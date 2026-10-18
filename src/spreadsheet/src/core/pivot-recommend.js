/**
 * Insert ▸ Recommended PivotTables: summaries worth making of a list, judged from its columns. A column of
 * a few repeated labels is a category to group by; a column of numbers is a value to total. Each
 * recommendation is a pivot spec (see pivot.js) with a title and a small preview of what it shows.
 */
import { pivotFields } from './pivot.js';
import { normalizeRange } from './cell.js';
import { dateTimeKind } from './format.js';
import { compareStoredValues } from './formula/functions.js';

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

/** Group the data by one column and total (or count) another, for the preview. */
function previewRows(wb, sheetId, range, rowCol, valueCol, agg) {
  const groups = new Map();
  for (let r = range.r1 + 1; r <= range.r2; r++) {
    const label = wb.getValue(sheetId, r, rowCol);
    if (label == null || label === '') continue;
    const key = typeof label === 'string' ? label.trim().toLowerCase() : String(label);
    // A number label reads as its cell shows it (a date as a date), and sorts by its value, as the pivot's rows do.
    const group = groups.get(key) || { label: typeof label === 'string' ? label.trim() : wb.getDisplay(sheetId, r, rowCol), value: label, sum: 0, count: 0 };
    const v = wb.getValue(sheetId, r, valueCol);
    if (agg === 'count') { if (v != null && v !== '') group.count++; } else if (typeof v === 'number') group.sum += v;
    groups.set(key, group);
  }
  const rows = [...groups.values()].sort((a, b) => (typeof a.value === 'string' && typeof b.value === 'string'
    ? String(a.label).localeCompare(String(b.label), undefined, { numeric: true }) : compareStoredValues(a.value, b.value)));
  return rows.slice(0, PREVIEW_ROWS).map((g) => [g.label, agg === 'count' ? g.count : g.sum]);
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
  const out = [];
  for (const cat of categories) {
    for (const val of values) {
      out.push({ title: `Sum of ${val.label} by ${cat.label}`, spec: { range, rowField: cat.index, colField: null, valueField: val.index, agg: 'sum', filters: [] },
        headers: [cat.label, `Sum of ${val.label}`], preview: previewRows(wb, sheetId, range, cat.col, val.col, 'sum') });
    }
    out.push({ title: `Count of ${cat.label} by ${cat.label}`, spec: { range, rowField: cat.index, colField: null, valueField: cat.index, agg: 'count', filters: [] },
      headers: [cat.label, `Count of ${cat.label}`], preview: previewRows(wb, sheetId, range, cat.col, cat.col, 'count') });
  }
  // A second category across the columns, for the first value, when the list has two.
  if (categories.length >= 2 && values.length) {
    const [a, b] = categories, val = values[0];
    if (b.distinct <= 12) out.splice(1, 0, { title: `Sum of ${val.label} by ${a.label} and ${b.label}`, spec: { range, rowField: a.index, colField: b.index, valueField: val.index, agg: 'sum', filters: [] },
      headers: [a.label, `Sum of ${val.label}`], preview: previewRows(wb, sheetId, range, a.col, val.col, 'sum') });
  }
  return out.slice(0, MAX_RECOMMENDATIONS);
}
