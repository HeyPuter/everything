import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall } from '../src/core/aitools.js';

// fill_formula passes over rows a filter hides, as a fill does, but reported every cell of the range filled: the
// model took the column for complete while the hidden rows had no formula.
it('counts the cells it filled and says which it passed over', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 5; r++) { wb.setInput(id, r, 1, String(r + 1)); wb.setInput(id, r, 2, '2'); }
  wb.sheet(id).filterHidden = new Set([2]);
  const res = runTool(wb, 'fill_formula', { range: 'D2:D5', formula: '=B2*C2' }, { sheetId: () => id, selection: () => null });
  const out = JSON.parse(res.content.split('\n')[0]);
  expect(out.cells).toBe(3);
  expect(out.left_out).toMatch(/1 row hidden by a filter was not filled/);
  expect(wb.getCell(id, 2, 3)?.f ?? null).toBe(null);
  expect(wb.getCell(id, 3, 3).f).toBe('B4*C4');
});

// The question before the fill counted every cell of the range holding data, the ones the fill passes over too: over a
// filtered list it asked about replacing data in hidden rows the fill leaves as they are, or asked when it replaced none.
it('asks only about the data in the cells it fills', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => null };
  for (let r = 0; r < 5; r++) wb.setInput(id, r, 1, String(r + 1));
  wb.setInput(id, 2, 2, 'kept'); wb.setInput(id, 4, 2, 'kept too');
  wb.sheet(id).filterHidden = new Set([2, 4]);
  expect(describeCall(wb, 'fill_formula', { range: 'C2:C5', formula: '=B2*2' }, env)).toMatchObject({ destructive: false, detail: null });
  wb.setInput(id, 3, 2, 'replaced');
  expect(describeCall(wb, 'fill_formula', { range: 'C2:C5', formula: '=B2*2' }, env).detail).toBe('Replaces 1 cell that already holds data.');
  runTool(wb, 'fill_formula', { range: 'C2:C5', formula: '=B2*2' }, env);
  expect([1, 2, 3, 4].map((r) => wb.getCell(id, r, 2)?.f ?? wb.getValue(id, r, 2))).toEqual(['B2*2', 'kept', 'B4*2', 'kept too']);
});

it('does not count what lies under a merged cell\'s top-left one, which the fill leaves', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => null };
  wb.mergeBlocks(id, [{ r1: 0, c1: 0, r2: 1, c2: 0 }]);
  wb.sheet(id).cells.set('1,0', { v: 'under the merge', f: null });
  expect(describeCall(wb, 'fill_formula', { range: 'A1:A3', formula: '=1' }, env).destructive).toBe(false);
});
