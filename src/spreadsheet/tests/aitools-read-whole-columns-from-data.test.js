import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

// read_range of whole columns began at row 1: with a wide block from A300, A:Z read 96 empty rows (shown as
// none) and said "Cut short: … Read A97:Z349 for the rest", so the model went through several empty reads.
it('reads whole columns from where their data begins', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 299; r < 349; r++) for (let c = 0; c < 26; c++) wb.setInput(id, r, c, String(r * 26 + c));
  const res = runTool(wb, 'read_range', { range: 'A:Z' }, { sheetId: () => id });
  expect(res.ok).toBe(true);
  const first = res.content.split('\n')[0];
  expect(first).toMatch(/^Sheet1!A300:Z/);
  expect(res.content.split('\n')[2]).toMatch(/^300\t7774\t/);
});
