import { Workbook } from '../../src/core/workbook.js';
import { parseCellRef } from '../../src/core/cell.js';

/** Evaluate one formula on a scratch sheet; `cells` maps A1 addresses to typed text. */
export function calc(formula, cells = {}) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (const [a1, text] of Object.entries(cells)) {
    const { r, c } = parseCellRef(a1);
    wb.setInput(id, r, c, String(text));
  }
  wb.setInput(id, 99, 25, `=${formula}`);
  return wb.getValue(id, 99, 25);
}

/**
 * Evaluate one formula as a file stores it rather than as typed: a formula giving a function too few or too many
 * arguments (ROUND(2.5), N()) stays text when typed, as Excel refuses it, but a file may still hold one.
 */
export function calcStored(formula, cells = {}) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (const [a1, text] of Object.entries(cells)) {
    const { r, c } = parseCellRef(a1);
    wb.setInput(id, r, c, String(text));
  }
  wb.setCells(id, [{ r: 99, c: 25, cell: { v: null, f: formula } }]);
  return wb.getValue(id, 99, 25);
}

/** Evaluate against stored values, preserving their bits instead of converting
 * them through typed text or a numeric formula literal.
 */
export function calcValues(formula, cells = {}) {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, Object.entries(cells).map(([a1,v]) => {
    const { r,c } = parseCellRef(a1);
    return { r,c,cell:{v} };
  }));
  wb.setInput(id,99,25,`=${formula}`);
  return wb.getValue(id,99,25);
}
