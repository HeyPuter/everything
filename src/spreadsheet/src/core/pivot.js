/**
 * Pivot tables, the spreadsheet way: a summary table whose cells are live
 * SUMIFS / COUNTIFS / AVERAGEIFS / MAXIFS / MINIFS formulas over the source
 * range, so edits to the data flow through. Row and column labels are the
 * distinct values found when the table is built (rebuild to pick up new
 * categories, as with any pivot).
 */

import { normalizeRange, colName } from './cell.js';
import { formatValue } from './format.js';
import { refToText } from './refs.js';
import { isError, compareStoredValues, criteriaMatcher } from './formula/functions.js';
import { MAX_ROWS, MAX_COLS } from './workbook.js';

export class PivotSizeError extends Error {}

export const PIVOT_AGGS = [
  ['sum', 'Sum', 'SUMIFS', 'SUM'],
  ['count', 'Count', 'COUNTIFS', 'COUNTA'],
  ['average', 'Average', 'AVERAGEIFS', 'AVERAGE'],
  ['max', 'Max', 'MAXIFS', 'MAX'],
  ['min', 'Min', 'MINIFS', 'MIN'],
];

/**
 * The rows a pivot reads: a range that is a whole table, totals row included (the dialog takes a table
 * name), stops above that row, whose Total label is no category and whose SUBTOTAL is no value.
 */
function sourceRange(wb, sheetId, range) {
  const n = normalizeRange(range);
  const table = (wb.tablesOn?.(sheetId) || []).find((t) => t.totalsRow && t.range.r1 === n.r1 && t.range.r2 === n.r2 && n.c1 >= t.range.c1 && n.c2 <= t.range.c2);
  return table ? { ...n, r2: n.r2 - 1 } : n;
}

/** The header labels of a source range (its first row), one per column. */
export function pivotFields(wb, sheetId, range) {
  const n = normalizeRange(range);
  const out = [];
  for (let c = n.c1; c <= n.c2; c++) {
    const text = wb.getDisplay(sheetId, n.r1, c);
    out.push({ index: c - n.c1, col: c, label: text || `Column ${colName(c)}` });
  }
  return out;
}

/** The distinct values of a field (a column offset inside the range), sorted, blanks and errors left out; `styles` (a Map) collects each number's format so it can be shown the way its cell is. */
export function pivotFieldValues(wb, sheetId, range, field, styles = null) {
  const n = sourceRange(wb, sheetId, range);
  return distinct(wb, sheetId, n, n.c1 + field, styles);
}

export const PIVOT_ALL = '(All)';

/** Keep the all-values control distinct from real, case-insensitive categories. */
export function pivotAllLabel(values) {
  const labels = new Set(values.filter((v) => typeof v === 'string').map((v) => v.toLowerCase()));
  let label = PIVOT_ALL;
  let suffix = 1;
  while (labels.has(label.toLowerCase())) {
    label = suffix === 1 ? '(All values)' : `(All values ${suffix})`;
    suffix++;
  }
  return label;
}

export const PIVOT_BLANK = '(blank)';

/** Rows with no value in a field form one more category, named so it cannot pass for a real "(blank)" value. */
export function pivotBlankLabel(values) {
  const labels = new Set(values.filter((v) => typeof v === 'string').map((v) => v.toLowerCase()));
  let label = PIVOT_BLANK;
  let suffix = 1;
  while (labels.has(label.toLowerCase())) {
    label = suffix === 1 ? '(blank values)' : `(blank values ${suffix})`;
    suffix++;
  }
  return label;
}

/** Stands for the blank category among a field's values; the label is chosen when the pivot is written. */
const BLANK = Symbol('blank');

/** The number format of a source cell's style, or null when it has none worth carrying to a label. */
function labelStyle(st) {
  if (!st?.fmt || st.fmt === 'general' || st.fmt === 'text') return null;
  const out = {};
  for (const key of ['fmt', 'dec', 'cur', 'dateStyle', 'sec', 'code', 'group']) if (st[key] !== undefined) out[key] = st[key];
  return out;
}

/**
 * The distinct values of a column, sorted, blanks and errors left out. When
 * `styles` is given, each number's format is recorded there from the first
 * cell holding it, so a label can read the way its source does (a date as a
 * date, a plain number as a plain number).
 */
function distinct(wb, sheetId, range, col, styles = null) {
  const n = normalizeRange(range);
  const seen = new Map();
  for (let r = n.r1 + 1; r <= n.r2; r++) {
    const v = wb.getValue(sheetId, r, col);
    if (v == null || v === '' || isError(v)) continue;
    // Match the generated IFS criteria: case-insensitive, with spaces intact.
    const key = typeof v === 'string' ? `s:${v.toLowerCase()}` : `${typeof v}:${v}`;
    if (seen.has(key)) continue;
    seen.set(key, v);
    if (styles && typeof v === 'number') {
      const s = labelStyle(wb.getCell(sheetId, r, col)?.s) || labelStyle(wb.spillAt(sheetId, r, col)?.style);
      if (s) styles.set(v, s);
    }
  }
  return [...seen.values()].sort(compareStoredValues);
}

/** The number format a field's numbers share (as collected by distinct), or null when they differ or none has one. */
function fieldStyle(styles) {
  let shared = null;
  for (const s of styles.values()) {
    if (shared && s.fmt !== shared.fmt) return null;
    shared ??= s;
  }
  return shared;
}

/** Does any row of the field show nothing (an empty cell or "")? Errors are neither a value nor a blank. */
function hasBlank(wb, sheetId, range, col) {
  const n = normalizeRange(range);
  for (let r = n.r1 + 1; r <= n.r2; r++) {
    const v = wb.getValue(sheetId, r, col);
    if (v == null || v === '') return true;
  }
  return false;
}

/** The distinct error codes a field holds, in code order, each as the error value it stands for. */
function errorCodes(wb, sheetId, range, col) {
  const n = normalizeRange(range);
  const seen = new Map();
  for (let r = n.r1 + 1; r <= n.r2; r++) {
    const v = wb.getValue(sheetId, r, col);
    if (isError(v) && !seen.has(v.error)) seen.set(v.error, v);
  }
  return [...seen.keys()].sort().map((code) => seen.get(code));
}

/**
 * A field's categories in output order: its distinct values, then a row for
 * each error code among them (#DIV/0! is a label of its own),
 * then the blank group when some rows have none, so the categories add up to
 * the total.
 */
function categories(wb, sheetId, range, col, styles = null) {
  const values = [...distinct(wb, sheetId, range, col, styles), ...errorCodes(wb, sheetId, range, col)];
  return hasBlank(wb, sheetId, range, col) ? [...values, BLANK] : values;
}

/**
 * The criteria matching the rows whose field holds one error code: the code as a criterion is read
 * as that error (a "#DIV/0!" typed as text would match it too, so text spelled like the code is
 * left to its own, wildcard-matched category).
 */
function errorCriteria(range, code) {
  return `${range},${literal(code)},${range},${literal(`<>${code}*`)}`;
}

/** Quoted literal for a criteria argument: text in quotes, numbers and booleans bare. */
function literal(v) {
  if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`;
  return String(v);
}

/**
 * Does a text label, given bare as an IFS criterion, match exactly the cells
 * holding it? Not when it carries a wildcard or opens with a comparison, when a
 * typed cell would read it as a number, date or boolean, or when it could be
 * taken for an error code.
 */
function plainLabel(label) {
  return typeof label === 'string' && !/^[<>=#]/.test(label) && criteriaMatcher(label).key !== undefined;
}

/**
 * Match category text literally, including text that looks numeric or boolean.
 * A label that reads as plain text is passed bare: the IFS functions look such
 * a criterion up in an index of the column instead of testing every row
 * against a pattern, which summed a thousand labels over 20000 rows in 50 ms
 * where the wildcard pair took two seconds on every edit of the source. The
 * pair stays for the labels that need it, and for a filter cell, whose value
 * is picked later.
 */
function labelCriteria(range, cell, all = null, label = undefined) {
  if (plainLabel(label)) return `${range},${cell}`;
  const escaped = `SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(${cell},"~","~~"),"*","~*"),"?","~?")`;
  // A wildcard forces IFS to match text rather than converting "05" to 5.
  // Match the literal prefix, then exclude anything with an extra character:
  // together these two criteria match exactly the original text and its type.
  // A number or boolean label matches its value and, with "<>*", no text at
  // all, since the IFS functions read a "5" stored as text as the number 5.
  const criteria = [
    `IF(ISTEXT(${cell}),"="&${escaped}&"*",${cell})`,
    `IF(ISTEXT(${cell}),"<>"&${escaped}&"?*","<>*")`,
  ];
  return criteria.map((criterion) => `${range},${all ? `IF(${all},"<>",${criterion})` : criterion}`).join(',');
}

/** Inspect grouping and enforce sheet limits before allocating any output cells. */
function pivotGroups(wb, sheetId, spec) {
  const n = sourceRange(wb, sheetId, spec.range);
  const rowCol = n.c1 + spec.rowField;
  const colCol = spec.colField == null ? null : n.c1 + spec.colField;
  // Each label keeps the number format of the cell its value came from, so dates read as dates rather than serials.
  const rowStyles = new Map();
  const colStyles = new Map();
  const rowValues = categories(wb, sheetId, n, rowCol, rowStyles);
  const colValues = colCol == null ? [] : categories(wb, sheetId, n, colCol, colStyles);
  const filters = (spec.filters || []).filter((f) => f && f.field != null && f.field !== spec.rowField && f.field !== spec.colField);
  // Filter cells sit above the table: a label in A and the chosen value in B, then a blank row.
  const top = filters.length ? filters.length + 1 : 0;
  const outputRows = top + rowValues.length + 2;
  const outputCols = colCol == null ? 2 : colValues.length + 2;
  if (outputRows > MAX_ROWS) throw new PivotSizeError(`This pivot needs ${outputRows} rows; a sheet supports ${MAX_ROWS}. Choose a rows field with fewer categories or a smaller source range.`);
  if (outputCols > MAX_COLS) throw new PivotSizeError(`This pivot needs ${outputCols} columns; a sheet supports ${MAX_COLS}. Choose a columns field with fewer categories, or choose None.`);
  return { n, rowCol, colCol, rowValues, colValues, rowStyles, colStyles, filters, top, rows: outputRows, cols: outputCols };
}

/** Dimensions for the dialog preview, without generating the pivot formulas. */
export function previewPivot(wb, sheetId, spec) {
  const { rowValues, colValues, rows, cols, top } = pivotGroups(wb, sheetId, spec);
  return { rowCount: rowValues.length, colCount: colValues.length, rows, cols, headerRow: top };
}

/**
 * Build the cells of a pivot table.
 *
 * spec = { range, rowField, colField (or null), valueField, agg, filters }
 * Fields are column offsets inside the range. filters is an optional list of
 * { field, value } (value null for every row): each one becomes a labeled
 * cell above the table holding the chosen value (or a unique All label), which every
 * formula reads as one more criterion, so picking another value in that
 * cell re-filters the live table. Returns
 * { cells: [{ r, c, cell }], rows, cols, widths, filterCells } positioned
 * from (0, 0); filterCells lists { r, c, values } for a dropdown per filter.
 */
export function buildPivot(wb, sheetId, spec) {
  const { n, rowCol, colCol, rowValues, colValues, rowStyles, colStyles, filters, top, rows, cols } = pivotGroups(wb, sheetId, spec);
  const src = wb.sheet(sheetId);
  const fields = pivotFields(wb, sheetId, n);
  const aggDef = PIVOT_AGGS.find((a) => a[0] === spec.agg) || PIVOT_AGGS[0];
  const [, aggLabel, ifsName, plainName] = aggDef;
  const valCol = n.c1 + spec.valueField;
  const data = { r1: n.r1 + 1, r2: n.r2 };
  // A pivot over a table names its columns (Sales[Amount]), so it keeps up as the table grows.
  const table = (wb.tablesOn?.(sheetId) || []).find((t) => t.range.r1 === n.r1 && t.range.c1 === n.c1 && t.range.c2 === n.c2 && (t.range.r2 === n.r2 || (t.totalsRow && t.range.r2 - 1 === n.r2)));
  const columns = table ? wb.tableColumns(sheetId, table) : null;
  const ref = (c) => {
    if (table) {
      const name = columns[c - table.range.c1];
      return `${table.name}[${/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `[${name.replace(/([[\]#'@])/g, "'$1")}]`}]`;
    }
    return refToText({ sheet: src.name, kind: 'range', r1: data.r1, c1: c, r2: data.r2, c2: c, absR1: true, absC1: true, absR2: true, absC2: true });
  };
  const valueStyle = (() => {
    for (let r = data.r1; r <= data.r2; r++) {
      const s = wb.getCell(sheetId, r, valCol)?.s;
      if (s?.fmt && spec.agg !== 'count') return { fmt: s.fmt, dec: s.dec, cur: s.cur, dateStyle: s.dateStyle, code: s.code };
    }
    return null;
  })();
  const numStyle = (extra = {}) => ({ ...(valueStyle || {}), ...extra });
  const cells = [];
  const put = (r, c, cell) => cells.push({ r, c, cell });
  const headerStyle = { bold: true, bg: '#f2f1ee' };

  // Filter cells and the criteria they add to every formula.
  const filterCells = [];
  const filterCrits = filters.map((flt, i) => {
    const styles = new Map();
    const values = distinct(wb, sheetId, n, n.c1 + flt.field, styles);
    const allLabel = pivotAllLabel(values);
    const has = flt.value != null && values.some((v) => (typeof v === 'string' && typeof flt.value === 'string' ? v.toLowerCase() === flt.value.toLowerCase() : v === flt.value));
    put(i, 0, { v: fields[flt.field].label, f: null, s: { bold: true } });
    // The chosen value reads like its cell, and so does one picked from the list later: under
    // the All label the cell already carries the format the field's numbers share (dates as dates).
    put(i, 1, { v: has ? flt.value : allLabel, f: null, s: { color: '#0a63f0', ...((has && styles.get(flt.value)) || fieldStyle(styles) || {}) } });
    filterCells.push({ r: i, c: 1, values: [allLabel, ...values] });
    const cell = `$B$${i + 1}`;
    const all = `${cell}=${literal(allLabel)}`;
    // All must include rows whose filter field is blank. In that mode, test
    // the value field instead: every aggregate already ignores blank values.
    // CHOOSE returns a range reference, including growing table columns.
    return labelCriteria(`CHOOSE(IF(${all},1,2),${ref(valCol)},${ref(n.c1 + flt.field)})`, cell, all);
  });

  // The blank category is written as a label no real value of the field shares; an error category as its code.
  const labeller = (values) => { const blank = pivotBlankLabel(values.filter((v) => v !== BLANK)); return (v) => (v === BLANK ? blank : isError(v) ? v.error : v); };
  const rowLabel = labeller(rowValues);
  const colLabel = labeller(colValues);
  // Header row.
  put(top, 0, { v: fields[spec.rowField].label, f: null, s: headerStyle });
  const valueColumns = colCol == null ? 1 : colValues.length;
  if (colCol == null) put(top, 1, { v: `${aggLabel} of ${fields[spec.valueField].label}`, f: null, s: { ...headerStyle, align: 'right' } });
  else colValues.forEach((cv, j) => put(top, 1 + j, { v: colLabel(cv), f: null, s: { ...headerStyle, align: 'right', ...(colStyles.get(cv) || {}) } }));
  const totalCol = 1 + valueColumns;
  const showTotalCol = colCol != null;
  if (showTotalCol) put(top, totalCol, { v: 'Total', f: null, s: { ...headerStyle, align: 'right' } });

  // Body: one formula per row label × column label (rows in sheet coordinates).
  // The blank category matches rows whose field shows nothing ("=" is the IFS criterion for an empty cell);
  // an error category the rows whose field holds that error.
  const rowCrit = (r, rv) => (rv === BLANK ? `${ref(rowCol)},"="` : isError(rv) ? errorCriteria(ref(rowCol), rv.error) : labelCriteria(ref(rowCol), `$A${r + 1}`, null, rv));
  const colCrit = (j) => (colValues[j] === BLANK ? `${ref(colCol)},"="` : isError(colValues[j]) ? errorCriteria(ref(colCol), colValues[j].error) : labelCriteria(ref(colCol), `${colName(1 + j)}$${top + 1}`, null, colValues[j]));
  const formula = (crits) => {
    const all = [...crits, ...filterCrits];
    // Count the chosen value field: cells that show something, so a row
    // whose value is blank or "" is left out of every count alike.
    const parts = spec.agg === 'count' ? [...all, `${ref(valCol)},"<>"`] : [ref(valCol), ...all];
    const body = `${ifsName}(${parts.join(',')})`;
    // An average over no rows is #DIV/0!, and a max or min over none is 0; the cell shows nothing instead,
    // as an empty intersection of a pivot table does. Rows with no number among them still divide by zero.
    const blankWhenEmpty = spec.agg === 'average' || spec.agg === 'max' || spec.agg === 'min';
    return blankWhenEmpty && all.length ? `IF(COUNTIFS(${all.join(',')})=0,"",${body})` : body;
  };
  // A total is read off the category cells it stands under, so the categories always add up to it. The
  // labels are the ones found when the pivot was built (rebuild to pick up new ones, as with any pivot),
  // while the formulas are live: a total counted over the whole source instead would count rows in
  // categories the pivot has no row for, and stand above rows that no longer reach it. An average is not
  // the average of the category averages, so it alone stays the live aggregate over the source.
  // MAX and MIN skip the blank cells, and over only blank ones (a filter leaving a category no rows) the
  // total is blank too rather than 0.
  const totalName = { sum: 'SUM', count: 'SUM', max: 'MAX', min: 'MIN' }[spec.agg];
  const total = (range) => (spec.agg === 'max' || spec.agg === 'min' ? `IF(COUNT(${range})=0,"",${totalName}(${range}))` : `${totalName}(${range})`);
  const down = (c) => `$${colName(c)}$${top + 2}:$${colName(c)}$${top + 1 + rowValues.length}`;
  const across = (r) => `$B$${r + 1}:$${colName(valueColumns)}$${r + 1}`;
  const rowTotal = (r, rv) => (totalName ? total(across(r)) : formula([rowCrit(r, rv)]));
  const grand = (c, crits = []) => (totalName ? total(down(c))
    : crits.length || filterCrits.length ? formula(crits) : `${plainName}(${ref(valCol)})`);
  rowValues.forEach((rv, i) => {
    const r = top + 1 + i;
    put(r, 0, { v: rowLabel(rv), f: null, ...(rowStyles.has(rv) ? { s: rowStyles.get(rv) } : {}) });
    if (colCol == null) put(r, 1, { v: null, f: formula([rowCrit(r, rv)]), s: numStyle() });
    else {
      colValues.forEach((_, j) => put(r, 1 + j, { v: null, f: formula([rowCrit(r, rv), colCrit(j)]), s: numStyle() }));
      put(r, totalCol, { v: null, f: rowTotal(r, rv), s: numStyle({ bold: true }) });
    }
  });

  // Grand total row.
  const totalRow = top + 1 + rowValues.length;
  const bold = { bold: true, bt: true };
  put(totalRow, 0, { v: 'Total', f: null, s: bold });
  if (colCol == null) put(totalRow, 1, { v: null, f: grand(1), s: numStyle(bold) });
  else {
    colValues.forEach((_, j) => put(totalRow, 1 + j, { v: null, f: grand(1 + j, [colCrit(j)]), s: numStyle(bold) }));
    put(totalRow, totalCol, { v: null, f: grand(totalCol), s: numStyle(bold) });
  }
  // The label column fits the labels as written: a date's text, not its serial.
  const widths = [Math.max(120, ...rowValues.map((v) => formatValue(rowLabel(v), rowStyles.get(v)).length * 8 + 24), ...filters.map((f) => fields[f.field].label.length * 8 + 24))];
  return { cells, rows, cols, widths, rowCount: rowValues.length, colCount: colValues.length, headerRow: top, filterCells };
}

/** Does the range look like a table with a header row and at least one data row? */
export function pivotRangeProblem(wb, sheetId, range) {
  if (!range) return 'Choose the data to summarize';
  const n = normalizeRange(range);
  if (n.r2 - n.r1 < 1) return 'The range needs a header row and at least one row of data';
  if (n.c2 - n.c1 < 1) return 'The range needs at least two columns';
  if (n.r2 - n.r1 > 50000) return 'That range is too large to summarize';
  return null;
}
