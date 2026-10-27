/**
 * Pivot tables, the spreadsheet way: a summary table whose cells are live
 * SUMIFS / COUNTIFS / AVERAGEIFS / MAXIFS / MINIFS formulas over the source
 * range, so edits to the data flow through. Row and column labels are the
 * distinct values found when the table is built (rebuild to pick up new
 * categories, as with any pivot).
 */

import { normalizeRange, colName, cellKey, parseKey } from './cell.js';
import { formatValue, NUMBER_FORMAT_KEYS } from './format.js';
import { refToText, mapFormulaRefs, quoteSheet } from './refs.js';
import { isError, compareStoredValues, criteriaMatcher } from './formula/functions.js';
import { MAX_ROWS, MAX_COLS } from './workbook.js';
import { maxOf } from './numeric.js';

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

/**
 * The last row of a source range that can hold data: a range reaching past the sheet's data (A:D, or A1:D100000 kept
 * roomy for rows to come) is read only as far as the data goes, while its formulas still name the whole range, so
 * rows added to it later count in their categories. The empty rows past the data make no "(blank)" category.
 */
function lastDataRow(wb, sheetId, n) {
  const used = wb.usedRange?.(sheetId);
  return Math.max(n.r1, Math.min(n.r2, used ? used.r2 : n.r2));
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
 * One pass over a column: its distinct values, sorted (blanks and errors left out), the distinct error codes it
 * holds, in code order, each as the error value it stands for, and whether any row shows nothing (an empty cell
 * or ""; an error is neither a value nor a blank). When `styles` is given, each number's format is recorded there
 * from the first cell holding it, so a label can read the way its source does (a date as a date, a plain number
 * as a plain number). The column is read once: a pivot over a long source read each of its cells three times.
 */
function scanField(wb, sheetId, range, col, styles = null) {
  const n = normalizeRange(range);
  const seen = new Map(), codes = new Map();
  let blank = false;
  for (let r = n.r1 + 1, last = lastDataRow(wb, sheetId, n); r <= last; r++) {
    const v = wb.getValue(sheetId, r, col);
    if (v == null || v === '') { blank = true; continue; }
    if (isError(v)) { if (!codes.has(v.error)) codes.set(v.error, v); continue; }
    // Match the generated IFS criteria: case-insensitive, with spaces intact, and numbers at the 15 significant
    // digits they compare at, so 0.3 and =0.1+0.2 are one category rather than two that each count both.
    const value = typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(15)) : v;
    const key = typeof value === 'string' ? `s:${value.toLowerCase()}` : `${typeof value}:${value}`;
    if (seen.has(key)) continue;
    seen.set(key, value);
    if (styles && typeof value === 'number') {
      const s = labelStyle(wb.getCell(sheetId, r, col)?.s) || labelStyle(wb.spillAt(sheetId, r, col)?.style);
      if (s) styles.set(value, s);
    }
  }
  return { values: [...seen.values()].sort(compareStoredValues), errors: [...codes.keys()].sort().map((code) => codes.get(code)), blank };
}

/** The distinct values of a column, sorted, blanks and errors left out (see scanField). */
function distinct(wb, sheetId, range, col, styles = null) {
  return scanField(wb, sheetId, range, col, styles).values;
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

/**
 * A field's categories in output order: its distinct values, then a row for
 * each error code among them (#DIV/0! is a label of its own),
 * then the blank group when some rows have none, so the categories add up to
 * the total.
 */
function categories(wb, sheetId, range, col, styles = null) {
  const { values, errors, blank } = scanField(wb, sheetId, range, col, styles);
  return blank ? [...values, ...errors, BLANK] : [...values, ...errors];
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
    for (let r = data.r1, last = lastDataRow(wb, sheetId, n); r <= last; r++) {
      const s = wb.getCell(sheetId, r, valCol)?.s;
      // The whole number format, its grouping and seconds included: 1234.50 without separators stays so.
      if (s?.fmt && spec.agg !== 'count') return Object.fromEntries(NUMBER_FORMAT_KEYS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
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
    // A max or min over rows that hold no number (text, blanks) is no 0 either: the cell shows nothing, so the
    // total read off the category cells is the largest or smallest number there is (-2, not 0, over -2 and -8).
    if (all.length && (spec.agg === 'max' || spec.agg === 'min')) return `IF(COUNTIFS(${[...all, `${ref(valCol)},">=-9.99999999999999E+307"`].join(',')})=0,"",${body})`;
    // A sum or count over no rows is 0, and blank in a pivot table too. Each label of a lone row field
    // came from the records, so only a column field or a filter can leave a cell none: the plain
    // SUMIFS stays there.
    const guard = spec.agg === 'average' ? all.length : (spec.agg === 'sum' || spec.agg === 'count') && all.length > 1;
    return guard ? `IF(COUNTIFS(${all.join(',')})=0,"",${body})` : body;
  };
  // A total is read off the category cells it stands under, so the categories always add up to it. The
  // labels are the ones found when the pivot was built (rebuild to pick up new ones, as with any pivot),
  // while the formulas are live: a total counted over the whole source instead would count rows in
  // categories the pivot has no row for, and stand above rows that no longer reach it. An average is not
  // the average of the category averages, so it alone stays the live aggregate over the source.
  // The totals skip the blank cells, and over only blank ones (a filter leaving a category no rows) the
  // total is blank too rather than 0.
  const totalName = { sum: 'SUM', count: 'SUM', max: 'MAX', min: 'MIN' }[spec.agg];
  const blanks = spec.agg === 'max' || spec.agg === 'min' || colCol != null || filterCrits.length > 0;
  const total = (range) => (blanks ? `IF(COUNT(${range})=0,"",${totalName}(${range}))` : `${totalName}(${range})`);
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
  const widths = [maxOf([...rowValues.map((v) => formatValue(rowLabel(v), rowStyles.get(v)).length * 8 + 24), ...filters.map((f) => fields[f.field].label.length * 8 + 24)], 120)];
  return { cells, rows, cols, widths, rowCount: rowValues.length, colCount: colValues.length, headerRow: top, filterCells, spec };
}

/** The most rows of data a pivot table summarizes: each category is a live formula over them all. */
export const PIVOT_MAX_ROWS = 50000;

/** Does the range look like a table with a header row and at least one data row? Rows past the sheet's data do not count. */
export function pivotRangeProblem(wb, sheetId, range) {
  if (!range) return 'Choose the data to summarize';
  const n = normalizeRange(range);
  if (n.c2 - n.c1 < 1) return 'The range needs at least two columns';
  const rows = lastDataRow(wb, sheetId, n) - n.r1;
  if (rows < 1) return 'The range needs a header row and at least one row of data';
  if (rows > PIVOT_MAX_ROWS) return `That range holds ${rows.toLocaleString('en-US')} rows of data; a pivot table summarizes up to ${PIVOT_MAX_ROWS.toLocaleString('en-US')}`;
  return null;
}

/* ---------- Placing a built pivot ---------- */

/** The name Insert ▸ PivotTable gives the sheet it adds: "Pivot of Sales", then "Pivot of Sales 2", within 31 characters. */
export function pivotSheetName(wb, sourceSheetId) {
  const base = `Pivot of ${wb.sheet(sourceSheetId).name}`;
  const withSuffix = (suffix) => base.slice(0, 31 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
  let name = withSuffix('');
  let k = 2;
  while (wb.sheetByName(name)) name = withSuffix(` ${k++}`);
  return name;
}

/** The dropdown in a filter cell above the table, as the pivot writes it at (r, c). */
const filterDropdown = (wb, sheetId, fc, r, c) => wb.addValidation(sheetId, { range: { r1: r, c1: c, r2: r, c2: c }, type: 'list', source: fc.values, strict: false, allowBlank: true, prompt: `Pick a value to filter the table, or ${fc.values[0]}` });

/**
 * Write a built pivot table to a new sheet (named `name`, or as pivotSheetName names it), as one undo step `label`,
 * with its definition kept for Refresh. Returns the new sheet, or null when no sheet could be added (Protect
 * Workbook locks the structure).
 */
export function writePivotSheet(wb, sourceSheetId, built, { name = null, label = 'Insert pivot table' } = {}) {
  const sheetName = name || pivotSheetName(wb, sourceSheetId);
  let sheet = null;
  wb.transaction(label, () => {
    sheet = wb.addSheet(sheetName);
    if (!sheet) return;
    wb.setCells(sheet.id, built.cells, label);
    built.widths.forEach((w, c) => wb.setColWidth(sheet.id, c, w));
    for (let c = 1; c < built.cols; c++) wb.setColWidth(sheet.id, c, 110);
    for (const fc of built.filterCells) filterDropdown(wb, sheet.id, fc, fc.r, fc.c);
    wb.setFrozen(sheet.id, built.headerRow + 1, 0);
    // Its definition stays with it, so Refresh can build it again over the source as it grows (see refreshPivot).
    if (built.spec) wb._setNames(namesWithPivotDefinition(wb, sourceSheetId, built, sheet.name, { r1: 0, c1: 0, r2: built.rows - 1, c2: built.cols - 1 }), label);
  });
  return sheet;
}

/**
 * Write a built pivot table with its top-left cell at `at` on an existing sheet, as one undo step `label`: the block
 * it takes is cleared first, its formulas moved there as Refresh moves them, and its definition kept for Refresh (a
 * sheet keeps one, so the caller makes sure the sheet holds none yet). Returns the block it takes.
 */
export function writePivotAt(wb, sourceSheetId, built, sheetId, at, { label = 'Insert pivot table' } = {}) {
  const sheet = wb.sheet(sheetId);
  const dr = at.r, dc = at.c;
  const area = { r1: dr, c1: dc, r2: dr + built.rows - 1, c2: dc + built.cols - 1 };
  const moved = (f) => (dr || dc ? mapFormulaRefs(f, (ref) => (ref.sheet ? ref : { ...ref, r1: ref.r1 + dr, r2: ref.r2 + dr, c1: ref.c1 + dc, c2: ref.c2 + dc })) : f);
  const written = new Set();
  const entries = built.cells.map(({ r, c, cell }) => {
    written.add(cellKey(r + dr, c + dc));
    return { r: r + dr, c: c + dc, cell: cell.f != null ? { ...cell, f: moved(cell.f) } : cell };
  });
  // What the block held where the table has nothing (the row under its filters) is cleared, so it is the table's alone.
  for (const key of sheet.cells.keys()) {
    const { r, c } = parseKey(key);
    if (r >= area.r1 && r <= area.r2 && c >= area.c1 && c <= area.c2 && !written.has(key)) entries.push({ r, c, cell: null });
  }
  wb.transaction(label, () => {
    wb.ensureSize(sheetId, area.r2 + 1, area.c2 + 1);
    wb.setCells(sheetId, entries, label);
    for (const fc of built.filterCells) filterDropdown(wb, sheetId, fc, fc.r + dr, fc.c + dc);
    if (built.spec) wb._setNames(namesWithPivotDefinition(wb, sourceSheetId, built, sheet.name, area), label);
  });
  return area;
}

/* ---------- Refresh ---------- */

/**
 * A pivot table built here is a block of formulas, so it keeps up with its source's values but not with categories
 * added since it was built. Its definition is kept with its sheet, so that Refresh can build it again over the source
 * as it now is: three hidden names scoped to that sheet, as Solver keeps its model. The source and the block are
 * references, which follow the rows and columns inserted or deleted around them and the renames of sheets and
 * tables; the fields are named by their headers, as Excel names a PivotTable's fields.
 */
const DEFINITION = { source: '_PuterPivot_Source', area: '_PuterPivot_Area', fields: '_PuterPivot_Fields' };
const isDefinitionName = (n, sheetName) => n.hidden && (n.sheet || '').toLowerCase() === String(sheetName).toLowerCase()
  && Object.values(DEFINITION).some((name) => name.toLowerCase() === n.name.toLowerCase());
const absoluteRange = (sheetName, r) => refToText({ sheet: sheetName, kind: 'range', r1: r.r1, c1: r.c1, r2: r.r2, c2: r.c2, absR1: true, absC1: true, absR2: true, absC2: true });

/**
 * What a pivot table's block holds, as a short fingerprint: each filled cell's place in the block and its label, or
 * that it holds a formula (the formulas' text changes as the source's rows come and go, their places do not). The
 * value picked in a filter cell is left out, being the reader's to change. Refresh rewrites only a block that still
 * has the fingerprint it was given: one cleared, typed over or given other data since is left alone.
 */
function blockSignature(cells, filters) {
  const parts = cells.filter(({ r, c, cell }) => cell && (cell.v != null || cell.f != null) && !(c === 1 && r < filters))
    .map(({ r, c, cell }) => `${r},${c}:${cell.f != null ? '=' : JSON.stringify(cell.v)}`).sort();
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return `${parts.length}:${h.toString(16)}`;
}

/** The fingerprint of what the block at `area` on a sheet holds now (see blockSignature). */
function areaSignature(wb, sheetId, area, filters) {
  const cells = [];
  for (const [key, cell] of wb.sheet(sheetId).cells) {
    const { r, c } = parseKey(key);
    if (r >= area.r1 && r <= area.r2 && c >= area.c1 && c <= area.c2) cells.push({ r: r - area.r1, c: c - area.c1, cell });
  }
  return blockSignature(cells, filters);
}

/** The names that keep a built pivot's definition (see DEFINITION), for the sheet `pivotSheetName` holding it at `area`. */
export function pivotDefinitionNames(wb, sourceSheetId, built, pivotSheetName, area) {
  const { spec } = built;
  const n = normalizeRange(spec.range);
  const fields = pivotFields(wb, sourceSheetId, n);
  // A source that is a whole table is named by the table, so it takes in the rows the table grows by.
  const table = (wb.tablesOn?.(sourceSheetId) || []).find((t) => t.range.r1 === n.r1 && t.range.c1 === n.c1 && t.range.c2 === n.c2 && (t.range.r2 === n.r2 || (t.totalsRow && t.range.r2 - 1 === n.r2)));
  const source = table ? `${table.name}[#All]` : absoluteRange(wb.sheet(sourceSheetId).name, n);
  const label = (i) => (i == null ? null : fields[i]?.label ?? null);
  const definition = { row: label(spec.rowField), col: label(spec.colField), value: label(spec.valueField), agg: spec.agg, filter: label(spec.filters?.[0]?.field),
    sig: blockSignature(built.cells, built.filterCells.length) };
  const fieldsRef = fieldsText(definition);
  if (!fieldsRef) return [];
  return [
    { name: DEFINITION.source, ref: source, hidden: true, sheet: pivotSheetName },
    { name: DEFINITION.area, ref: absoluteRange(pivotSheetName, area), hidden: true, sheet: pivotSheetName },
    { name: DEFINITION.fields, ref: fieldsRef, hidden: true, sheet: pivotSheetName },
  ];
}

/** The workbook's names with the definition of the pivot table on `pivotSheetName` set (one per sheet: any earlier one is replaced). */
export function namesWithPivotDefinition(wb, sourceSheetId, built, pivotSheetName, area) {
  return [...wb.names.filter((n) => !isDefinitionName(n, pivotSheetName)), ...pivotDefinitionNames(wb, sourceSheetId, built, pivotSheetName, area)];
}

/**
 * The fields as the name's formula: their JSON as string constants joined with &, each at most 255 characters, the
 * longest a string constant in a formula may be (ECMA-376; Excel repairs a file holding a longer one). Null when the
 * whole would pass FIELDS_LIMIT, well under the 8,192 characters a name's formula may have: such a pivot keeps no
 * definition, rather than one Excel cannot read.
 */
const STRING_LIMIT = 255, FIELDS_LIMIT = 8000;
function fieldsText(definition) {
  const chars = [...JSON.stringify(definition)]; // by code point, so no constant ends in half a surrogate pair
  const parts = [];
  for (let i = 0; i < chars.length; i += STRING_LIMIT) parts.push(`"${chars.slice(i, i + STRING_LIMIT).join('').replace(/"/g, '""')}"`);
  const text = parts.join('&');
  return text.length <= FIELDS_LIMIT ? text : null;
}

/** The fields read back from the name's formula: string constants joined with & (one alone in files written before). */
function parseFields(text) {
  const t = String(text ?? '').trim();
  if (!/^"(?:[^"]|"")*"(?:\s*&\s*"(?:[^"]|"")*")*$/.test(t)) return null;
  const json = [...t.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')).join('');
  try { const parsed = JSON.parse(json); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
}

/** The definition kept for the pivot table on a sheet: { source, area, fields } as their texts, or null. */
export function readPivotDefinition(wb, sheetId) { return readDefinition(wb, sheetId); }
function readDefinition(wb, sheetId) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return null;
  const get = (name) => wb.names.find((n) => isDefinitionName(n, sheet.name) && n.name.toLowerCase() === name.toLowerCase())?.ref;
  const source = get(DEFINITION.source), area = get(DEFINITION.area), fields = get(DEFINITION.fields);
  if (!source || !area || !fields) return null;
  const parsed = parseFields(fields);
  return parsed ? { source, area, fields: parsed, fieldsRef: fields } : null;
}

/**
 * Whether the sheet holds a pivot table Refresh can build again: 'intact' when its block still holds what the last
 * build wrote, 'changed' when the block has been cleared, typed over or moved apart since, null when it has none.
 */
export function pivotDefinitionState(wb, sheetId) {
  const def = readDefinition(wb, sheetId);
  if (!def) return null;
  const area = wb.rangeFromText(sheetId, def.area);
  if (!area || area.sheetId !== sheetId) return 'changed';
  return areaSignature(wb, sheetId, area.range, def.fields.filter != null ? 1 : 0) === def.fields.sig ? 'intact' : 'changed';
}

/** Whether a sheet keeps the definition of a pivot table built here (intact or not), cheaply, for the menus. */
export function hasPivotDefinition(wb, sheetId) {
  return !!readDefinition(wb, sheetId);
}

/** The sheets holding a pivot table that Refresh All builds again (intact ones only), in the workbook's order. */
export function refreshablePivotSheets(wb) {
  return wb.sheets.filter((s) => pivotDefinitionState(wb, s.id) === 'intact').map((s) => s.id);
}

/**
 * Build the pivot table on a sheet again from its kept definition, over its source as it now is, in its place, as one
 * undo step: categories added to the source get rows and columns, and a filter keeps the value picked above the table.
 * Returns { rows } or { error } (a sentence); { error, changed: true } when the block no longer holds what the last
 * build wrote (cleared, typed over: see pivotDefinitionState), unless `replaceChanged`; { error, overwrite: true } when
 * the larger table would cover cells beside it that hold something, unless `force`.
 */
export function refreshPivot(wb, sheetId, { force = false, replaceChanged = false } = {}) {
  const sheet = wb.sheet(sheetId);
  const def = readDefinition(wb, sheetId);
  if (!def) return { error: 'This sheet has no PivotTable to refresh' };
  const state = pivotDefinitionState(wb, sheetId);
  if (state !== 'intact' && !replaceChanged) return { error: 'The PivotTable on this sheet has been cleared or changed since it was built, so it was not refreshed', changed: true };
  if (wb.isProtected(sheetId)) return { error: 'This sheet is protected. Unprotect it to refresh the PivotTable' };
  const found = wb.rangeFromText(sheetId, def.source);
  const at = wb.rangeFromText(sheetId, def.area);
  if (!found) return { error: 'The PivotTable\'s source data is gone' };
  if (!at || at.sheetId !== sheetId) return { error: 'The PivotTable is gone from this sheet' };
  const problem = pivotRangeProblem(wb, found.sheetId, found.range);
  if (problem) return { error: problem };
  const fields = pivotFields(wb, found.sheetId, found.range);
  const field = (label) => {
    if (label == null) return null;
    const i = fields.findIndex((f) => f.label.toLowerCase() === String(label).toLowerCase());
    return i < 0 ? undefined : i;
  };
  const { row, col, value, agg, filter } = def.fields;
  const spec = { range: found.range, rowField: field(row), colField: field(col), valueField: field(value), agg, filters: [] };
  const missing = [[row, spec.rowField], [col, spec.colField], [value, spec.valueField], [filter, field(filter)]].find(([label, i]) => label != null && i === undefined);
  if (missing) return { error: `The field “${missing[0]}” is no longer in the PivotTable's source` };
  const old = at.range;
  if (filter != null) {
    // The value picked in the filter cell stays picked, while the field still has it; otherwise every row is shown.
    const values = pivotFieldValues(wb, found.sheetId, found.range, field(filter));
    const picked = wb.getValue(sheetId, old.r1, old.c1 + 1);
    const has = values.find((v) => (typeof v === 'string' && typeof picked === 'string' ? v.toLowerCase() === picked.toLowerCase() : v === picked));
    spec.filters = [{ field: field(filter), value: has ?? null }];
  }
  let built;
  try { built = buildPivot(wb, found.sheetId, spec); } catch (cause) { if (cause instanceof PivotSizeError) return { error: cause.message }; throw cause; }
  if (!built.rowCount) return { error: 'The rows field has no values to group by' };
  // The formulas name the table's own cells as if it began at A1; where it stands now, they are moved with it.
  const dr = old.r1, dc = old.c1;
  const moved = (f) => (dr || dc ? mapFormulaRefs(f, (ref) => (ref.sheet ? ref : { ...ref, r1: ref.r1 + dr, r2: ref.r2 + dr, c1: ref.c1 + dc, c2: ref.c2 + dc })) : f);
  const next = { r1: old.r1, c1: old.c1, r2: old.r1 + built.rows - 1, c2: old.c1 + built.cols - 1 };
  const inOld = (r, c) => r >= old.r1 && r <= old.r2 && c >= old.c1 && c <= old.c2;
  const written = new Set();
  const entries = built.cells.map(({ r, c, cell }) => {
    written.add(cellKey(r + dr, c + dc));
    return { r: r + dr, c: c + dc, cell: cell.f != null ? { ...cell, f: moved(cell.f) } : cell };
  });
  if (!force && entries.some(({ r, c }) => !inOld(r, c) && (() => { const cell = wb.getCell(sheetId, r, c); return cell && (cell.v != null || cell.f != null); })())) {
    return { error: 'The refreshed PivotTable would cover cells beside it that hold data', overwrite: true };
  }
  // What the old table had where the new one has nothing is cleared.
  for (const key of sheet.cells.keys()) {
    const { r, c } = parseKey(key);
    if (inOld(r, c) && !written.has(key)) entries.push({ r, c, cell: null });
  }
  // Written on the pivot table's sheet alone: its sheet grouped with others (Refresh All from a group of tabs) would
  // otherwise have the cells it rewrote written over the same cells of every other sheet in the group.
  const alone = (fn) => (wb._withoutGroup ? wb._withoutGroup(fn) : fn());
  wb.transaction('Refresh PivotTable', () => alone(() => {
    for (const v of sheet.validations.filter((v) => v.type === 'list' && v.range.r1 >= old.r1 && v.range.r2 <= old.r2 && v.range.c1 >= old.c1 && v.range.c2 <= old.c2)) wb.deleteValidation(sheetId, v.id);
    wb.setCells(sheetId, entries, 'Refresh PivotTable');
    for (const fc of built.filterCells) {
      wb.addValidation(sheetId, { range: { r1: fc.r + dr, c1: fc.c + dc, r2: fc.r + dr, c2: fc.c + dc }, type: 'list', source: fc.values, strict: false, allowBlank: true, prompt: `Pick a value to filter the table, or ${fc.values[0]}` });
    }
    const fields = fieldsText({ ...def.fields, sig: blockSignature(built.cells, built.filterCells.length) }) ?? def.fieldsRef;
    const names = wb.names.map((n) => (!isDefinitionName(n, sheet.name) ? n
      : n.name.toLowerCase() === DEFINITION.area.toLowerCase() ? { ...n, ref: absoluteRange(sheet.name, next) }
        : n.name.toLowerCase() === DEFINITION.fields.toLowerCase() ? { ...n, ref: fields } : n));
    wb._setNames(names, 'Refresh PivotTable');
  }));
  return { rows: built.rowCount };
}
