/**
 * What the app's Edit options do to an entry as it is written: a fixed decimal point put into whole numbers
 * typed without one, and a list's formatting and formulas carried on to a row typed at its foot.
 */
import { shiftFormula } from './refs.js';

/**
 * A whole number typed without a decimal point, with `places` decimals put in (2: 1234 → 12.34; -2: 5 → 500).
 * Anything else (a formula, text, a number with its own decimal point) is left as typed. `decimal` is the
 * regional format's decimal separator, which the result is written with.
 */
export function applyFixedDecimal(text, places, decimal = '.') {
  const m = /^\s*([+-]?)(\d+)\s*$/.exec(String(text ?? ''));
  const n = Math.round(Number(places));
  if (!m || !n) return text;
  const sign = m[1] === '-' ? '-' : '';
  let digits = m[2];
  if (n < 0) return `${sign}${digits.replace(/^0+(?=\d)/, '')}${'0'.repeat(-n)}`;
  digits = digits.padStart(n + 1, '0');
  const whole = digits.slice(0, -n).replace(/^0+(?=\d)/, '');
  return `${sign}${whole}${decimal}${digits.slice(-n)}`;
}

const filled = (cell) => cell != null && (cell.f != null || (cell.v != null && cell.v !== ''));
const styleKey = (s) => (s && Object.keys(s).length ? JSON.stringify(s) : null);

/**
 * When an entry lands at the foot of a list (row r, under a run of at least three filled rows in its column),
 * what the list would carry on to it: the formatting the rows above share in that column, when the new cell
 * has none of its own, and, for each neighbouring column of the list whose last three rows hold the same
 * formula, that formula moved down a row into the empty cell beside the entry.
 * { style: object | null, formulas: [{ c, input }] }
 */
export function listExtension(wb, sheetId, r, c) {
  const none = { style: null, formulas: [] };
  if (r < 3) return none;
  const rows = [r - 1, r - 2, r - 3];
  if (!rows.every((rr) => filled(wb.getCell(sheetId, rr, c)))) return none;
  const own = wb.getCell(sheetId, r, c);
  if (!filled(own) || own.f != null) return none;
  let style = null;
  if (!styleKey(own.s)) {
    const keys = rows.map((rr) => styleKey(wb.getCell(sheetId, rr, c)?.s));
    if (keys[0] && keys.every((k) => k === keys[0])) style = { ...wb.getCell(sheetId, r - 1, c).s };
  }
  // The list's columns: the run of filled cells along the row above, either side of the entry's column.
  let c1 = c, c2 = c;
  while (c1 > 0 && filled(wb.getCell(sheetId, r - 1, c1 - 1))) c1--;
  while (c2 < c + 200 && filled(wb.getCell(sheetId, r - 1, c2 + 1))) c2++;
  const formulas = [];
  for (let cc = c1; cc <= c2; cc++) {
    if (cc === c || filled(wb.getCell(sheetId, r, cc))) continue;
    const above = rows.map((rr) => wb.getCell(sheetId, rr, cc)?.f);
    if (above.some((f) => f == null) || above.some((f) => wb.getCell(sheetId, r - 1, cc)?.array)) continue;
    // The three formulas are one formula filled down: each, moved to the row above's place, reads the same.
    if (shiftFormula(above[1], 1, 0) !== above[0] || shiftFormula(above[2], 2, 0) !== above[0]) continue;
    formulas.push({ c: cc, input: `=${shiftFormula(above[0], 1, 0)}` });
  }
  return { style, formulas };
}
