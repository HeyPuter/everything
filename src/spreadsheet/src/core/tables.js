import { themedTableLook } from './workbook-theme.js';
import { normalizeFillColor } from './fill-color.js';
import { layerDifferentialStyle } from './style-values.js';
import { normalizeFontColor } from './font-color.js';
/**
 * Tables: a named range with a header row, optional totals row, banded
 * styling, and structured references in formulas.
 *
 * table = { id, name, range: {r1,c1,r2,c2}, totalsRow: boolean, style, banded }
 *   The first row of `range` is the header; with totalsRow the last row is
 *   the totals row; the rows between are the data.
 *
 * Structured references, as .xlsx formulas write them:
 *   Table1[Amount]              the Amount column's data cells
 *   Table1[@Amount]             the Amount cell on the formula's own row
 *   Table1[[#Headers],[Amount]] the header cell; #Totals, #Data, #All likewise
 *   Table1[#All], Table1[#Data], Table1[#Headers], Table1[#Totals], Table1[@]
 *   Table1[[Qty]:[Amount]]      several adjacent columns
 *   [@Amount], [Amount]         inside the table itself, the table name may be left out
 * A column name with spaces or punctuation is written in its own brackets;
 * ' escapes [ ] # ' and @ inside a name.
 */

import { tokenize } from './formula/tokenizer.js';
import { freeNameTokens, tableReferenceTokens } from './formula/names.js';
import { colName } from './cell.js';
import { fontStack } from './format.js';

// The default looks are medium-weight styles in the default theme's accents (header in the accent, rows banded in its tint).
export const TABLE_STYLES = [
  ['blue', 'Blue', { header: '#4472c4', headerText: '#ffffff', band: '#d9e1f2', total: '#d9e1f2' }],
  ['gray', 'Gray', { header: '#a5a5a5', headerText: '#ffffff', band: '#ededed', total: '#ededed' }],
  ['green', 'Green', { header: '#70ad47', headerText: '#ffffff', band: '#e2efda', total: '#e2efda' }],
  ['orange', 'Orange', { header: '#ed7d31', headerText: '#ffffff', band: '#fce4d6', total: '#fce4d6' }],
  ['purple', 'Purple', { header: '#4a3aa7', headerText: '#ffffff', band: '#ebe6fb', total: '#d9d1f5' }],
  ['red', 'Red', { header: '#991b1b', headerText: '#ffffff', band: '#fde8e8', total: '#f8cfcf' }],
  ['light', 'Light', { header: '#e7e6e1', headerText: '#0b0b0b', band: '#f7f7f5', total: '#e7e6e1' }],
  ['none', 'None', { header: 'transparent', headerText: 'inherit', band: 'transparent', total: 'transparent' }],
];

export function tableStyle(key) {
  return (TABLE_STYLES.find(([k]) => k === key) || TABLE_STYLES[0])[2];
}

// Worksheet table regions, in SpreadsheetML precedence order. The corner
// elements refine the enabled first/last column at the header and total row.
export const TABLE_STYLE_REGIONS = ['wholeTable', 'firstRowStripe', 'secondRowStripe',
  'lastColumn', 'firstColumn', 'headerRow', 'totalRow',
  'firstHeaderCell', 'lastHeaderCell', 'firstTotalCell', 'lastTotalCell'];

/** Differential regions represented by a table theme in native XLSX. */
export function tableStyleParts(table, wb = null) {
  if (table.style === 'none') return null;
  const look = themedTableLook(table.style, tableStyle(table.style), wb);
  return table.customStyle || {
    headerRow: { bg: look.header, color: look.headerText, bold: true },
    totalRow: { bg: look.total, bold: true }, firstRowStripe: { bg: look.band },
    firstColumn: { bold: true }, lastColumn: { bold: true },
  };
}

/** Custom table styles from .xlsx files stay attached to the table, so stripes follow filtering and new rows. */
export function normalizeCustomTableStyle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const name of TABLE_STYLE_REGIONS) {
    const source = raw[name];
    if (!source || typeof source !== 'object') continue;
    const st = {};
    for (const key of ['bg', 'color', 'bc']) if (/^#[0-9a-f]{6}$/i.test(source[key])) st[key] = source[key];
    const color = normalizeFontColor(source.color);
    if (color) st.color = color;
    const fill = normalizeFillColor(source.bg);
    if (fill) st.bg = fill;
    if (source.bg === 'transparent') st.bg = 'transparent';
    for (const key of ['bold', 'italic', 'underline', 'strike', 'bt', 'bb', 'bl', 'br', 'bh', 'bv']) if (typeof source[key] === 'boolean') st[key] = source[key];
    if (['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'].includes(source.bs)) st.bs = source.bs;
    for (const key of ['bt', 'bb', 'bl', 'br', 'bh', 'bv']) {
      const edge = source[`${key}Border`];
      if (edge === null) st[`${key}Border`] = null;
      else if (edge && typeof edge === 'object') {
        st[`${key}Border`] = {
          bs: ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'].includes(edge.bs) ? edge.bs : st.bs || 'thin',
          bc: /^#[0-9a-f]{6}$/i.test(edge.bc) ? edge.bc : null,
        };
      }
    }
    if (['major', 'minor', 'none'].includes(source.scheme)) st.scheme = source.scheme;
    if (fontStack(source.font)) st.font = source.font;
    st.stripeSize = Number.isInteger(source.stripeSize) && source.stripeSize > 0 && source.stripeSize <= 1000 ? source.stripeSize : 1;
    out[name] = st;
  }
  return Object.keys(out).length ? out : null;
}

export function customTableStyleAt(table, r, c, ordinal) {
  const style = table.customStyle;
  if (!style) return null;
  const { r1, r2, c1, c2 } = table.range, rows = tableRows(table);
  const out = {};
  const layer = (st, first, last, left = c1, right = c2) =>
    layerDifferentialStyle(out, st, { r1: first, r2: last, c1: left, c2: right }, r, c);
  layer(style.wholeTable, r1, r2);
  if (r >= rows.dataStart && r <= rows.dataEnd && table.banded && ordinal >= 0) {
    const firstSize = style.firstRowStripe?.stripeSize || 1, secondSize = style.secondRowStripe?.stripeSize || 1;
    const first = ordinal % (firstSize + secondSize) < firstSize;
    layer(first ? style.firstRowStripe : style.secondRowStripe, rows.dataStart, rows.dataEnd);
  }
  if (table.lastColumn && c === c2) layer(style.lastColumn, r1, r2, c, c);
  if (table.firstColumn && c === c1) layer(style.firstColumn, r1, r2, c, c);
  if (r === rows.header) {
    layer(style.headerRow, r, r);
    if (table.firstColumn && c === c1) layer(style.firstHeaderCell, r, r, c, c);
    if (table.lastColumn && c === c2) layer(style.lastHeaderCell, r, r, c, c);
  }
  if (r === rows.totals) {
    layer(style.totalRow, r, r);
    if (table.firstColumn && c === c1) layer(style.firstTotalCell, r, r, c, c);
    if (table.lastColumn && c === c2) layer(style.lastTotalCell, r, r, c, c);
  }
  return out;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const CELL_LIKE = /^[A-Za-z]{1,3}\d{1,7}$/;

export const MAX_TABLE_NAME_LENGTH = 255;

/** Why a table name is unacceptable, or null. */
export function validateTableName(name, taken = []) {
  const t = String(name ?? '').trim();
  if (!t) return 'Enter a name';
  if (!NAME_RE.test(t)) return 'Names start with a letter or underscore and use only letters, digits, underscores, and periods';
  if (CELL_LIKE.test(t) || /^R\d*C\d*$/i.test(t)) return 'That looks like a cell reference';
  if (t.length > MAX_TABLE_NAME_LENGTH) return 'That name is too long';
  if (taken.some((n) => n.toLowerCase() === t.toLowerCase())) return 'That name is already used';
  return null;
}

/** The rows of a table: header (null when the Header Row is turned off), data (first..last), totals (or null). */
export function tableRows(table) {
  const { r1, r2 } = table.range;
  const header = table.headerRow === false ? null : r1;
  const dataStart = header == null ? r1 : r1 + 1;
  const totals = table.totalsRow ? r2 : null;
  const dataEnd = table.totalsRow ? r2 - 1 : r2;
  return { header, dataStart, dataEnd, totals, empty: dataEnd < dataStart };
}

const unescape = (s) => s.replace(/'([[\]#'@])/g, '$1');
const needsBrackets = (name) => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name);
const escapeName = (name) => name.replace(/([[\]#'@])/g, "'$1");

/** Split a bracket spec into its top-level items ("[#Headers],[Amount]" → ["[#Headers]", "[Amount]"]), brackets kept. */
function splitItems(spec) {
  const items = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i];
    if (ch === "'" && i + 1 < spec.length) { cur += ch + spec[i + 1]; i++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (ch === ',' && depth === 0) { items.push(cur); cur = ''; continue; }
    cur += ch;
  }
  items.push(cur);
  // Space between bracketed specifiers is syntax; inside a column name it
  // is data. Distinct headers such as "Cost", "Cost " and " " are allowed.
  return items.map((s) => s.trimStart().startsWith('[') ? s.trim() : s).filter((s, i, all) => s !== '' || all.length === 1);
}

/** "[Amount]" → "Amount"; a column range "[A]:[B]" and plain text are left alone. */
const unwrap = (item) => (item.startsWith('[') && item.endsWith(']') && !/\]\s*:\s*\[/.test(item) ? item.slice(1, -1) : item);

/**
 * Parse the text inside Table[...]: → { rows, cols } where rows is 'data' |
 * 'all' | 'headers' | 'totals' | 'this' and cols is null (every column) or
 * [first, last] column names. Null for text that is not a structured reference.
 */
export function parseTableSpec(spec) {
  const text = String(spec ?? '');
  let rows = 'data';
  let cols = null;
  const takeColumn = (raw) => {
    // "[A]:[B]" or "A" or "[A]"
    const m = /^\[([\s\S]+?)\]\s*:\s*\[([\s\S]+?)\]$/.exec(raw);
    if (m) return [unescape(m[1]), unescape(m[2])];
    const one = unwrap(raw);
    return one === '' ? null : [unescape(one), unescape(one)];
  };
  if (text === '') return { rows, cols };
  const items = splitItems(text).map(unwrap);
  let selectors = 0;
  for (const item of items) {
    if (item.startsWith('#')) {
      const key = item.slice(1).toLowerCase().replace(/\s+/g, ' ');
      const map = { all: 'all', data: 'data', headers: 'headers', totals: 'totals', 'this row': 'this' };
      if (!map[key]) return null;
      if (selectors && rows !== map[key]) {
        // [#Headers],[#Data] means both: the header row through the data.
        const set = new Set([rows, map[key]]);
        if (set.has('headers') && set.has('data')) rows = 'headersData';
        else if (set.has('data') && set.has('totals')) rows = 'dataTotals';
        else return null;
      } else rows = map[key];
      selectors++;
      continue;
    }
    if (item.startsWith('@')) {
      rows = 'this';
      const rest = item.slice(1);
      if (rest) { const c = takeColumn(rest); if (!c) return null; cols = c; }
      continue;
    }
    const c = takeColumn(item);
    if (!c) return null;
    if (cols) return null;
    cols = c;
  }
  return { rows, cols };
}

/** Render a spec back to text: the plainest forms. */
export function renderTableSpec({ rows, cols }) {
  const col = (name) => (needsBrackets(name) ? `[${escapeName(name)}]` : escapeName(name));
  const colPart = cols ? (cols[0] === cols[1] ? col(cols[0]) : `[${escapeName(cols[0])}]:[${escapeName(cols[1])}]`) : '';
  if (rows === 'this') return cols ? `@${colPart}` : '@';
  if (rows === 'data') return cols ? colPart : '';
  const sel = { all: '[#All]', headers: '[#Headers]', totals: '[#Totals]', headersData: '[#Headers],[#Data]', dataTotals: '[#Data],[#Totals]' }[rows];
  if (!cols) return sel.startsWith('[') && !sel.includes(',') ? sel.slice(1, -1) : sel;
  return `${sel},[${escapeName(cols[0])}]${cols[0] === cols[1] ? '' : `:[${escapeName(cols[1])}]`}`;
}

/** Exact names win; retain older unpadded spellings only when unambiguous. */
function columnIndex(columns, name) {
  const key = name.toLowerCase(), exact = columns.findIndex(n => n.toLowerCase() === key);
  if (exact >= 0) return exact;
  const trimmed = key.trim();
  if (!trimmed) return -1;
  let found = -1;
  for (let i = 0; i < columns.length; i++) if (columns[i].trim().toLowerCase() === trimmed) {
    if (found >= 0) return -1;
    found = i;
  }
  return found;
}

/** A rename map with compatibility aliases derived from the complete old header row. */
export function tableColumnRenames(before, after) {
  const names = new Map(before.flatMap((name, i) => name !== after[i] ? [[name.toLowerCase(), after[i]]] : []));
  if (!names.size) return names;
  const counts = new Map();
  for (const name of before) { const key = name.trim().toLowerCase(); counts.set(key, (counts.get(key) || 0) + 1); }
  names.aliases = new Map();
  for (const [name, next] of names) {
    const key = name.trim();
    if (key && counts.get(key) === 1) names.aliases.set(key, next);
  }
  return names;
}

/**
 * The cells a structured reference names. `columns` are the table's column
 * names in order; `cell` is the formula's own position for @ references.
 * Returns { r1, c1, r2, c2 } or { error }.
 */
export function resolveTableSpec(table, columns, spec, cell) {
  const parsed = parseTableSpec(spec);
  if (!parsed) return { error: '#REF!' };
  const rows = tableRows(table);
  let r1;
  let r2;
  switch (parsed.rows) {
    case 'all': r1 = table.range.r1; r2 = table.range.r2; break;
    // A table whose Header Row is turned off has no header cells: [#Headers] is #REF!.
    case 'headers': if (rows.header == null) return { error: '#REF!' }; r1 = r2 = rows.header; break;
    case 'totals': if (rows.totals == null) return { error: '#REF!' }; r1 = r2 = rows.totals; break;
    case 'headersData': r1 = rows.header ?? rows.dataStart; r2 = rows.dataEnd; break;
    case 'dataTotals': r1 = rows.dataStart; r2 = table.range.r2; break;
    case 'this': {
      // A this-row reference has no row outside the data: in the header or totals row it is #VALUE!.
      if (!cell || cell.r < rows.dataStart || cell.r > rows.dataEnd || rows.empty) return { error: '#VALUE!' };
      r1 = r2 = cell.r;
      break;
    }
    default: r1 = rows.dataStart; r2 = rows.dataEnd;
  }
  let c1 = table.range.c1;
  let c2 = table.range.c2;
  if (parsed.cols) {
    const find = (name) => columnIndex(columns, name);
    const a = find(parsed.cols[0]);
    const b = find(parsed.cols[1]);
    if (a < 0 || b < 0) return { error: '#REF!' };
    c1 = table.range.c1 + Math.min(a, b);
    c2 = table.range.c1 + Math.max(a, b);
  }
  // A table whose data rows were all deleted keeps its header (and its totals row): r2 < r1 then, and the
  // reference covers no cells. It is an empty reference, not a broken one — SUM(T[Amt]) and the totals row's
  // SUBTOTAL read it as 0, as they do over a table whose values were cleared, rather than every formula in
  // the book turning into #REF! because the data went. Only a data spec can invert; every other one names
  // rows the table always has, and a this-row spec is #VALUE! on an empty table (above).
  return { r1, c1, r2, c2 };
}

/** Rewrite the table-reference tokens of a formula with `fn(tableName, spec) → text | null`. */
export function mapTableRefs(formula, fn, includeBare = false) {
  let tokens;
  try { tokens = tokenize(formula); } catch { return formula; }
  const bare = includeBare ? new Map(freeNameTokens(formula, tokens).map((t) => [t.start, t])) : null;
  // A LAMBDA's optional parameter, [b], is written like a column reference but names nothing in a table.
  const refs = new Set(tableReferenceTokens(formula, tokens).map((t) => t.start));
  let out = '';
  let last = 0;
  for (const t of tokens) {
    const isBare = bare?.get(t.start);
    if (!refs.has(t.start) && !isBare) continue;
    const next = fn(isBare ? t.value : t.table, isBare ? '' : t.spec, isBare || t);
    if (next == null) continue;
    out += formula.slice(last, t.start) + next;
    last = t.end;
  }
  return out + formula.slice(last);
}

/** Does the formula use a structured reference at all? */
export function hasTableRefs(formula, tableNames = []) {
  if (!formula || (!formula.includes('[') && !tableNames.length)) return false;
  try {
    const tokens = tokenize(formula);
    if (tableReferenceTokens(formula, tokens).length) return true; // not a LAMBDA's [optional] parameter
    const names = new Set(tableNames.map((name) => name.toUpperCase()));
    if (!tokens.some((t) => t.type === 'name' && names.has(t.value))) return false;
    return freeNameTokens(formula, tokens).some((t) => names.has(t.value));
  } catch { return false; }
}

/** Table1[...] → Sales[...] throughout a formula. */
export function renameTableInFormula(formula, oldName, newName, includeBare = true) {
  if (!formula || !formula.toLowerCase().includes(oldName.toLowerCase())) return formula;
  return mapTableRefs(formula, (table, spec, token) => {
    if (!table || table.toLowerCase() !== oldName.toLowerCase()) return null;
    if (token.type !== 'name') return `${newName}[${spec}]`;
    // Boolean spellings are literals unless the table selector is explicit.
    return /^(TRUE|FALSE)$/i.test(newName) || token.locals?.has(newName.toUpperCase()) ? `${newName}[#Data]` : newName;
  }, includeBare);
}

/**
 * A column of `tableName` was renamed: fix every reference to it. Bare
 * [Col] references count only when the formula sits in that table
 * (`ownerTable`).
 */
export function renameColumnInFormula(formula, tableName, oldCol, newCol, ownerTable = null) {
  if (!formula || !formula.includes('[')) return formula;
  return renameColumnsInFormula(formula, tableName, new Map([[oldCol.toLowerCase(), newCol]]), ownerTable);
}

/** Rename columns together, using a map of lowercase old names to new names. */
export function renameColumnsInFormula(formula, tableName, names, ownerTable = null) {
  if (!formula || !formula.includes('[')) return formula;
  return mapTableRefs(formula, (table, spec) => {
    const target = table || ownerTable;
    if (!target || target.toLowerCase() !== tableName.toLowerCase()) return null;
    const parsed = parseTableSpec(spec);
    if (!parsed?.cols) return null;
    const cols = parsed.cols.map((c) => names.get(c.toLowerCase()) ?? names.aliases?.get(c.trim().toLowerCase()) ?? c);
    if (cols[0] === parsed.cols[0] && cols[1] === parsed.cols[1]) return null;
    return `${table || ''}[${renderTableSpec({ rows: parsed.rows, cols })}]`;
  });
}

/**
 * A formula filled across (`dc` columns, the fill handle or Ctrl+R) moves its one-column structured references
 * along their table's columns, as Excel moves them, the way a relative reference moves: Table1[Qty] filled right
 * reads Table1[Price], and [@Qty]*2 reads [@Price]*2. A span written as such ([[Qty]:[Qty]]) stays put, as in
 * Excel, and so do a reference to no column and one that would move past the table's last column. `columnsOf(name)`
 * gives a table's column names (null for no such table); `ownerTable` names the table a bare [@Qty] belongs to.
 */
export function shiftTableColumns(formula, dc, columnsOf, ownerTable = null) {
  if (!dc || !formula || !formula.includes('[')) return formula;
  return mapTableRefs(formula, (table, spec) => {
    const target = table || ownerTable;
    const parsed = target && !/\]\s*:\s*\[/.test(spec) ? parseTableSpec(spec) : null;
    if (!parsed?.cols || parsed.cols[0] !== parsed.cols[1]) return null;
    const columns = columnsOf(target);
    const i = columns ? columnIndex(columns, parsed.cols[0]) : -1;
    if (i < 0) return null;
    const next = columns[i + dc];
    if (next == null) return null;
    return `${table || ''}[${renderTableSpec({ rows: parsed.rows, cols: [next, next] })}]`;
  });
}

/** Structured references → absolute A1 text ($A2 rows when the resolver marks a ref `relativeRows`); an optional include predicate leaves other tokens intact. */
export function tableRefsToA1(formula, resolve, include = null, tableNames = []) {
  const names = new Set(tableNames.map((name) => name.toUpperCase()));
  return mapTableRefs(formula, (table, spec, token) => {
    if (token.type === 'name' && !names.has(table)) return null;
    if (include && !include(table, spec)) return null;
    const ref = resolve(table, spec);
    if (!ref) return '#REF!';
    // A resolver may keep the rows relative (a [@Column] reference in a rule that reads row by row).
    const row = (r) => `${ref.relativeRows ? '' : '$'}${r + 1}`;
    const a = `$${colName(ref.c1)}${row(ref.r1)}`;
    const b = `$${colName(ref.c2)}${row(ref.r2)}`;
    const body = a === b ? a : `${a}:${b}`;
    return ref.sheet ? `${/^[A-Za-z_][\w.]*$/.test(ref.sheet) ? ref.sheet : `'${ref.sheet.replace(/'/g, "''")}'`}!${body}` : body;
  }, names.size > 0);
}
