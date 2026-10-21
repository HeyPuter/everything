import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

const env = (wb) => ({ sheetId: () => wb.activeSheetId, selection: () => ({ sheetId: wb.activeSheetId, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }) });

// The assistant's find listed every value spilled on each sheet before looking at any of them, so on a sheet
// holding an array formula entered over the whole sheet (seventeen billion results) asking it to find anything ran
// the tab out of memory. It now looks at the first million spilled values and says when it stopped there.
it('finds typed text beside an array over the whole sheet, and says the spilled values were cut short', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '5');
  wb.setInput(id, 3, 0, 'needle');
  expect(wb.setArrayFormula(id, { r1: 0, c1: 1, r2: 1048575, c2: 16383 }, '=A1*2')).toBe(true);
  const found = JSON.parse(runTool(wb, 'find', { query: 'needle' }, env(wb)).content);
  expect(found.matches).toEqual([{ cell: 'Sheet1!A4', text: 'needle' }]);
  expect(found.note).toMatch(/first 1,000,000/);
});

it('still finds values an ordinary array spills, with no note', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '=SEQUENCE(3,1,7)');
  const found = JSON.parse(runTool(wb, 'find', { query: '9' }, env(wb)).content);
  expect(found.matches).toEqual([{ cell: 'Sheet1!A3', text: '9' }]);
  expect(found.note).toBeUndefined();
});
