import { Blob as NodeBlob } from 'node:buffer';
import { expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

vi.stubGlobal('Blob', NodeBlob);

it('keeps results until F9 under manual calculation and works everything out on returning to automatic', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1');
  wb.setInput(id, 1, 0, '=A1*10');
  wb.setInput(id, 2, 0, '=SUM(A1:A2)');
  expect([wb.getValue(id, 1, 0), wb.getValue(id, 2, 0)]).toEqual([10, 11]);
  wb.setCalcMode('manual');
  wb.setInput(id, 0, 0, '5');
  // The cell typed into shows what it holds now; the formulas reading it keep their answers, and Calculate is pending.
  expect([wb.getValue(id, 0, 0), wb.getValue(id, 1, 0), wb.getValue(id, 2, 0), wb.calcPending]).toEqual([5, 10, 11, true]);
  // A formula entered now is calculated on entry, from the values as they stand.
  wb.setInput(id, 3, 0, '=A1+A2');
  expect(wb.getValue(id, 3, 0)).toBe(15);
  expect(wb.refreshVolatile()).toBe(false);
  wb.recalculate();
  expect([wb.getValue(id, 1, 0), wb.getValue(id, 2, 0), wb.calcPending]).toEqual([50, 55, false]);
  wb.setInput(id, 0, 0, '2');
  wb.setCalcMode('automatic');
  expect([wb.getValue(id, 1, 0), wb.getValue(id, 2, 0), wb.calcPending]).toEqual([20, 22, false]);
});

it('saves manual calculation in the file, where Excel reads it, and in the app\'s own format', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '=1+2');
  wb.setCalcMode('manual');
  expect(new Workbook(JSON.parse(JSON.stringify(wb.toJSON()))).calcMode).toBe('manual');
  const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const back = await workbookFromFile(bytes, 'manual.xlsx');
  expect(back.calcMode).toBe('manual');
  expect(back.getValue(back.activeSheetId, 0, 0)).toBe(3);
  wb.setCalcMode('automatic');
  const auto = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'auto.xlsx');
  expect(auto.calcMode).toBe('automatic');
});

it('keeps spilled and array formula results in view while other cells are edited under manual calculation', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (const [r, v] of [[0, '1'], [1, '2'], [2, '3']]) wb.setInput(id, r, 0, v);
  wb.setArrayFormula(id, { r1: 0, c1: 2, r2: 2, c2: 2 }, '=A1:A3*10');
  wb.setInput(id, 0, 3, '=SORT(A1:A3,,-1)');
  wb.setInput(id, 0, 4, '=SUM(D1#)');
  const column = (c) => [0, 1, 2].map((r) => wb.getValue(id, r, c));
  expect([column(2), column(3), wb.getValue(id, 0, 4)]).toEqual([[10, 20, 30], [3, 2, 1], 6]);
  wb.setCalcMode('manual');
  // An edit elsewhere left only the top-left cell of each array, the cells they spilled over blank.
  wb.setInput(id, 0, 7, 'note');
  expect([column(2), column(3), wb.getValue(id, 0, 4)]).toEqual([[10, 20, 30], [3, 2, 1], 6]);
  // An edit they read leaves their answers until Calculate, as for any formula.
  wb.setInput(id, 1, 0, '20');
  expect([column(2), column(3), wb.getValue(id, 0, 4)]).toEqual([[10, 20, 30], [3, 2, 1], 6]);
  wb.recalculate();
  expect([column(2), column(3), wb.getValue(id, 0, 4)]).toEqual([[10, 200, 30], [20, 3, 1], 24]);
  wb.setInput(id, 5, 5, '=1');
  expect([column(2), column(3)]).toEqual([[10, 200, 30], [20, 3, 1]]);
  // Typing into a spilled cell still blocks the spill.
  wb.setInput(id, 2, 3, 'x');
  expect(column(3)).toEqual([{ error: '#SPILL!' }, null, 'x']);
});
