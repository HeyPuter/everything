import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

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
