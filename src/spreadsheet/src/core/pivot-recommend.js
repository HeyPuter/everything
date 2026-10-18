/**
 * Insert ▸ Recommended PivotTables: summaries worth making of a list, judged from its columns. A column of
 * a few repeated labels is a category to group by; a column of numbers is a value to total. Each
 * recommendation is a pivot spec (see pivot.js) with a title and a small preview of what it shows.
 */
import { pivotFields, pivotFieldValues } from './pivot.js';
import { normalizeRange } from './cell.js';
import { dateTimeKind, formatValue } from './format.js';

const MAX_RECOMMENDATIONS = 10;
const PREVIEW_ROWS = 8;

function columnProfile(wb, sheetId, range, col) {
  let numbers = 0, filled = 0;
  const labels = new Map();
  for (let r = range.r1 + 1; r <= range.r2; r++) {
    const v = wb.getValue(sheetId, r, col);
    if (v == null || v === '') continue;
    filled++;
    // A date or time is a number underneath, but a value to group by, never one to total.
    if (typeof v === 'number' && !dateTimeKind(wb.styleAt(sheetId, r, col), v)) numbers++;
    const key = typeof v === 'string' ? v.trim().toLowerCase() : String(v);
    if (!labels.has(key)) labels.set(key, typeof v === 'string' ? v.trim() : v);
  }
  return { filled, numeric: filled > 0 && numbers / filled >= 0.8, distinct: labels.size };
}

/** A cell value's group in a pivot: text case-insensitively, anything else by type and value (see pivot.js). */
const groupKey = (v) => (typeof v === 'string' ? `s:${v.toLowerCase()}` : `${typeof v}:${v}`);

/**
 * Group the data by one column (and, with `colCol`, across another) and total (or count) a value column,
 * for the preview: the rows the pivot will show first, in its order and with its grouping. Each row is
 * [label, value] or, across a second column, [label, ...one value per column label, row total].
 */
function previewTable(wb, sheetId, range, rowCol, valueCol, agg, colCol = null, labelsOf = fieldLabels(wb, sheetId, range)) {
  const labels = (col) => labelsOf(col).values.map((v) => ({ v, key: groupKey(v) }));
  const rows = labels(rowCol).slice(0, PREVIEW_ROWS);
  const cols = colCol == null ? [] : labels(colCol);
  const rowAt = new Map(rows.map((row, i) => [row.key, i]));
  const colAt = new Map(cols.map((col, j) => [col.key, j]));
  const width = colCol == null ? 1 : cols.length + 1;
  const totals = rows.map(() => new Array(width).fill(0));
  const shown = new Map();
  for (let r = range.r1 + 1; r <= range.r2; r++) {
    const label = wb.getValue(sheetId, r, rowCol);
    const i = label == null || label === '' ? undefined : rowAt.get(groupKey(label));
    if (i === undefined) continue;
    // A number label reads as its cell shows it (a date as a date).
    if (!shown.has(i)) shown.set(i, typeof label === 'string' ? rows[i].v : wb.getDisplay(sheetId, r, rowCol));
    const v = wb.getValue(sheetId, r, valueCol);
    const add = agg === 'count' ? (v != null && v !== '' ? 1 : 0) : typeof v === 'number' ? v : 0;
    if (!add) continue;
    if (colCol != null) {
      const across = wb.getValue(sheetId, r, colCol);
      const j = across == null || across === '' ? undefined : colAt.get(groupKey(across));
      if (j !== undefined) totals[i][j] += add;
    }
    totals[i][width - 1] += add;
  }
  return rows.map((_, i) => [shown.get(i) ?? rows[i].v, ...totals[i]]);
}

/** The pivot's own categories of each column (its distinct values, text case-insensitively, in its sort order), read once a column. */
function fieldLabels(wb, sheetId, range) {
  const memo = new Map();
  return (col) => {
    if (!memo.has(col)) {
      const styles = new Map();
      memo.set(col, { values: pivotFieldValues(wb, sheetId, range, col - range.c1, styles), styles });
    }
    return memo.get(col);
  };
}

/** The column labels of a preview across a second column, as its header row shows them. */
function previewColumns(labelsOf, colCol) {
  const { values, styles } = labelsOf(colCol);
  return values.map((v) => (typeof v === 'number' ? formatValue(v, styles.get(v)) : String(v)));
}

/** The number format the pivot gives its values: the value column's, except for a count. */
function valueFormat(wb, sheetId, range, valueCol, agg) {
  if (agg === 'count') return null;
  for (let r = range.r1 + 1; r <= range.r2; r++) {
    const s = wb.getCell(sheetId, r, valueCol)?.s;
    if (s?.fmt) return { fmt: s.fmt, dec: s.dec, cur: s.cur, dateStyle: s.dateStyle, code: s.code };
  }
  return null;
}

export function recommendPivots(wb, sheetId, rawRange) {
  const range = normalizeRange(rawRange);
  if (range.r2 <= range.r1) return [];
  const fields = pivotFields(wb, sheetId, range);
  const rowsCount = range.r2 - range.r1;
  const profiles = fields.map((f) => ({ ...f, ...columnProfile(wb, sheetId, range, f.col) }));
  // A category repeats: at least two labels, fewer than the rows, and not too many to read.
  const categories = profiles.filter((p) => !p.numeric && p.distinct >= 2 && p.distinct < rowsCount && p.distinct <= 50)
    .sort((a, b) => a.distinct - b.distinct);
  const values = profiles.filter((p) => p.numeric);
  const labelsOf = fieldLabels(wb, sheetId, range);
  const out = [];
  for (const cat of categories) {
    for (const val of values) {
      out.push({ title: `Sum of ${val.label} by ${cat.label}`, spec: { range, rowField: cat.index, colField: null, valueField: val.index, agg: 'sum', filters: [] },
        headers: [cat.label, `Sum of ${val.label}`], preview: previewTable(wb, sheetId, range, cat.col, val.col, 'sum', null, labelsOf), format: valueFormat(wb, sheetId, range, val.col, 'sum') });
    }
    out.push({ title: `Count of ${cat.label} by ${cat.label}`, spec: { range, rowField: cat.index, colField: null, valueField: cat.index, agg: 'count', filters: [] },
      headers: [cat.label, `Count of ${cat.label}`], preview: previewTable(wb, sheetId, range, cat.col, cat.col, 'count', null, labelsOf), format: null });
  }
  // A second category across the columns, for the first value, when the list has two.
  if (categories.length >= 2 && values.length) {
    const [a, b] = categories, val = values[0];
    if (b.distinct <= 12) out.splice(1, 0, { title: `Sum of ${val.label} by ${a.label} and ${b.label}`, spec: { range, rowField: a.index, colField: b.index, valueField: val.index, agg: 'sum', filters: [] },
      headers: [a.label, ...previewColumns(labelsOf, b.col), 'Total'], preview: previewTable(wb, sheetId, range, a.col, val.col, 'sum', b.col, labelsOf),
      format: valueFormat(wb, sheetId, range, val.col, 'sum') });
  }
  return out.slice(0, MAX_RECOMMENDATIONS);
}
