import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { rangeToCsv, sheetToHtml } from '../src/core/io.js';

// Writing a selection as CSV (Export selection, or a selection attached to an email) listed every value spilled
// on the sheet to learn where each row's content ends, so on a sheet holding an array formula entered over the
// whole sheet (seventeen billion results) exporting even A1:C2 ran the tab out of memory. Each array's rows now
// end at its last column, read off its extent.
it('writes a selection as CSV beside an array over the whole sheet', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '5');
  wb.setInput(id, 1, 0, 'x');
  expect(wb.setArrayFormula(id, { r1: 0, c1: 1, r2: 1048575, c2: 16383 }, '=A1*2')).toBe(true);
  expect(rangeToCsv(wb, id, { r1: 0, c1: 0, r2: 2, c2: 2 })).toBe('﻿5,10,10\r\nx,10,10\r\n,10,10\r\n');
});

it('still ends each row at the last result an ordinary array spills into it', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '=SEQUENCE(2,3)');
  wb.setInput(id, 3, 0, '=SEQUENCE(1)');
  expect(rangeToCsv(wb, id, { r1: 0, c1: 0, r2: 3, c2: 3 })).toBe('﻿1,2,3,\r\n4,5,6,\r\n,,,\r\n1,,,\r\n');
  expect(sheetToHtml(wb, id)).toContain('<td x:num="4">4</td><td x:num="5">5</td><td x:num="6">6</td></tr>');
});
