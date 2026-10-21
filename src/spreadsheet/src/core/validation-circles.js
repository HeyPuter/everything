/**
 * Data ▸ Data Validation ▸ Circle Invalid Data: the cells whose current value breaks their validation rule
 * (at most 255 per sheet). Only cells holding something are checked; a blank is
 * never circled.
 */
import { cellKey } from './cell.js';
import { eachStoredCell } from './sparse-range.js';

export const MAX_CIRCLES = 255;

export function invalidCells(wb, sheetId, limit = MAX_CIRCLES) {
  const sheet = wb.sheet(sheetId);
  const out = [];
  if (!sheet || !sheet.validations?.length) return { cells: out, more: false };
  // Only the cells under a rule are candidates: the circles are redrawn after every edit, and a sheet of
  // 100,000 cells with one validated column was otherwise sorted and checked in full each time.
  const held = new Map();
  for (const rule of sheet.validations) eachStoredCell(sheet, rule.range, (r, c, cell) => {
    if (cell.v != null || cell.f != null) held.set(cellKey(r, c), [r, c]);
  });
  const keys = [...held.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [r, c] of keys) {
    if (!wb.validationAt(sheetId, r, c)) continue;
    const value = wb.getValue(sheetId, r, c);
    if (value == null || value === '') continue;
    if (wb.validateCell(sheetId, r, c).ok) continue;
    if (out.length === limit) return { cells: out, more: true };
    out.push({ r, c });
  }
  return { cells: out, more: false };
}
