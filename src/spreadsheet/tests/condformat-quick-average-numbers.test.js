import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { quickRule } from '../src/ui/condformat-quick.js';

// A1>AVERAGE(...) is true for any text (text sorts above numbers) and a blank cell counts as 0, so the
// quick Above/Below Average rules formatted a header and blank cells. Like Excel, they format numbers only.
it('formats only numbers above or below the average, never text or blank cells', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['Sales', '10', '20', '', '30', 'n/a', "'40"].forEach((v, r) => v && wb.setInput(id, r, 0, v));
  const range = parseRange('A1:A7');
  wb.addRule(id, quickRule(range, 'above', { style: { bg: '#f00' } }));
  wb.addRule(id, { ...quickRule(range, 'below', { style: { color: '#00f' } }), stopIfTrue: false });
  const style = r => wb.conditionalStyle(id, r, 0, wb.getValue(id, r, 0));
  expect(style(0)).toBeNull(); // header text
  expect(style(1)).toEqual({ color: '#00f' }); // 10 is below the average of 20
  expect(style(2)).toBeNull(); // 20 is the average
  expect(style(3)).toBeNull(); // blank
  expect(style(4)).toEqual({ bg: '#f00' }); // 30
  expect(style(5)).toBeNull(); // text
  expect(style(6)).toBeNull(); // a number stored as text
});
