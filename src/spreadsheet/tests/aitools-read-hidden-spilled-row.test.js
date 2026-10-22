import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

// read_range left out a hidden row whose values an array formula spilled there, as if it were blank, though it
// says only blank rows are left out: =SEQUENCE(5) with row 3 hidden read as rows 1, 2, 4 and 5.
it('reads a hidden row of spilled values, marked hidden', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '=SEQUENCE(5)');
  wb.setHidden(id, 'row', [2], true);
  const res = runTool(wb, 'read_range', { range: 'A1:A5' }, { sheetId: () => id });
  expect(res.content).toContain('3 (hidden)\t3');
  expect(res.content.split('\n').filter((l) => /^\d/.test(l))).toHaveLength(5);
});
