import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Clear, the fill handle and the other edits made again on every grouped sheet went on to the other sheets when the
// active sheet refused them, because those edits say a refusal without returning false. Delete on one cell of an
// array formula on Jan said "You can't change part of an array" and left Jan alone, but erased the same cell on Feb.
// A refusal on the active sheet now stops the edit for the whole group.
function book() {
  const wb = new Workbook({ sheets: [{ name: 'Jan' }, { name: 'Feb' }] });
  const [a, b] = wb.sheets.map((s) => s.id);
  for (const id of [a, b]) for (let r = 0; r < 5; r++) { wb.setInput(id, r, 0, String(r + 1)); wb.setInput(id, r, 1, `t${r}`); }
  expect(wb.setArrayFormula(a, { r1: 0, c1: 1, r2: 3, c2: 1 }, '=A1:A4*2')).toBe(true);
  wb.clearHistory();
  wb.groupSheets([b]);
  const column = (id, c) => [0, 1, 2, 3, 4].map((r) => wb.getValue(id, r, c));
  return { wb, a, b, column };
}

describe('a grouped edit the active sheet refuses', () => {
  it('clears nothing on the other sheets when part of an array is cleared', () => {
    const { wb, a, b, column } = book();
    const said = [];
    wb.addEventListener('change', (e) => { if (e.detail.type === 'array-edit') said.push(e.detail.sheetId); });
    wb.clearRange(a, { r1: 1, c1: 1, r2: 1, c2: 1 });
    expect(said).toEqual([a]);
    expect(column(a, 1)).toEqual([2, 4, 6, 8, 't4']);
    expect(column(b, 1)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(wb.canUndo()).toBe(false);
  });

  it('fills nothing on the other sheets when the fill would cut an array', () => {
    const { wb, a, b, column } = book();
    wb.ungroupSheets();
    for (const id of [a, b]) wb.setInput(id, 4, 1, 'z');
    wb.clearHistory();
    wb.groupSheets([b]);
    wb.fill(a, { r1: 4, c1: 1, r2: 4, c2: 1 }, { r1: 2, c1: 1, r2: 4, c2: 1 });
    expect(column(a, 1)).toEqual([2, 4, 6, 8, 'z']);
    expect(column(b, 1)).toEqual(['t0', 't1', 't2', 't3', 'z']);
    expect(wb.canUndo()).toBe(false);
  });

  it('formats and clears nothing on the other sheets when the active sheet is protected', () => {
    const { wb, a, b, column } = book();
    wb.setSheetProtected(a, true);
    wb.clearRange(a, { r1: 4, c1: 0, r2: 4, c2: 1 });
    wb.applyStyle(a, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
    wb.setColWidth(a, 0, 200);
    expect(column(b, 0)).toEqual([1, 2, 3, 4, 5]);
    expect(wb.getCell(b, 0, 0).s?.bold).toBeFalsy();
    expect(wb.sheet(b).colWidths.get(0)).toBeUndefined();
  });

  it('still reaches every sheet when the active sheet takes the edit', () => {
    const { wb, a, b, column } = book();
    wb.clearRange(a, { r1: 4, c1: 0, r2: 4, c2: 1 });
    expect(column(a, 0)).toEqual([1, 2, 3, 4, null]);
    expect(column(b, 0)).toEqual([1, 2, 3, 4, null]);
    // Nothing to clear on the active sheet still clears the others.
    wb.setInput(b, 4, 2, 'only on Feb');
    wb.clearRange(a, { r1: 4, c1: 2, r2: 4, c2: 2 });
    expect(wb.getValue(b, 4, 2)).toBe(null);
  });
});
