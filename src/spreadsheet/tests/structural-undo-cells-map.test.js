import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Undoing or redoing a row insertion rebuilds the sheet from its snapshot, and the snapshot held its cells as an
// object keyed 'r,c': each undo listed its keys afresh (Object.entries), about half of what an undo cost on a sheet
// of 150,000 cells. The snapshot now keeps them as a map, read back as they are.
afterEach(() => vi.restoreAllMocks());

it('undoes and redoes a row insertion on a large sheet without listing its cells as object keys', () => {
  const cells = {};
  for (let r = 0; r < 2000; r++) for (let c = 0; c < 10; c++) cells[`${r},${c}`] = c === 9 ? { f: `A${r + 1}*2`, s: { b: true } } : { v: r * c };
  const wb = new Workbook({ sheets: [{ name: 'Sheet1', cells }] });
  const id = wb.activeSheetId;
  expect(wb.getValue(id, 99, 9)).toBe(0);
  wb.insertRows(id, 5, 2);
  expect(wb.getValue(id, 101, 9)).toBe(0);
  const entries = vi.spyOn(Object, 'entries');
  const listed = () => entries.mock.calls.filter(([o]) => o && Object.keys(o).length >= 20000).length;
  wb.undo();
  expect(wb.getCell(id, 5, 1).v).toBe(5);
  expect(wb.getCell(id, 99, 9)).toMatchObject({ f: 'A100*2', s: { b: true } });
  wb.redo();
  expect(wb.getCell(id, 7, 1).v).toBe(5);
  expect(wb.getCell(id, 101, 9)).toMatchObject({ f: 'A102*2', s: { b: true } });
  wb.undo();
  expect(wb.sheet(id).cells.size).toBe(20000);
  expect(listed()).toBe(0);
});
