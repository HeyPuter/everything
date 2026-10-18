import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { editText } from '../src/core/format.js';

// A number typed into a Percentage cell is that many percent (5 is 5%), but a cell whose percentage is a
// custom code, such as the 0.0%;[Red]-0.0% of a sheet from Excel, took a typed 5 as 500.0%. Excel's
// automatic percent entry treats every format that shows a percentage alike.
function typed(style, text) {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, style);
  wb.setInput(id, 0, 0, text);
  return { v: wb.getValue(id, 0, 0), shown: wb.getDisplay(id, 0, 0), edit: editText(wb.getCell(id, 0, 0)) };
}

it('reads a typed number in a custom percentage cell as that many percent', () => {
  expect(typed({ fmt: 'custom', code: '0.0%;[Red]-0.0%' }, '5')).toEqual({ v: 0.05, shown: '5.0%', edit: '5%' });
  expect(typed({ fmt: 'custom', code: '0.0%;[Red]-0.0%' }, '-12.5')).toMatchObject({ v: -0.125, shown: '-12.5%' });
  expect(typed({ fmt: 'custom', code: '#,##0%' }, '1,500')).toMatchObject({ v: 15, shown: '1,500%' });
});

it('keeps the share a number under one already is, and what a typed percent says', () => {
  expect(typed({ fmt: 'custom', code: '0.0%' }, '0.5')).toMatchObject({ v: 0.5, shown: '50.0%' });
  expect(typed({ fmt: 'custom', code: '0.0%' }, '5%')).toMatchObject({ v: 0.05, shown: '5.0%' });
});

it('leaves codes that do not scale by a percentage alone', () => {
  expect(typed({ fmt: 'custom', code: '0.00E+00%' }, '5').v).toBe(5);
  expect(typed({ fmt: 'custom', code: '0"%"' }, '5').v).toBe(5);
});
