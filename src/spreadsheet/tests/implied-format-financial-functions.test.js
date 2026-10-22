import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { setLocale } from '../src/core/format.js';

afterEach(() => setLocale('en-US'));

// A payment, present or future value typed as a formula showed its bare binary tail (-188.7123364) and a rate of
// return a fraction (0.130662386), where Excel shows money and a percentage. The result takes those formats
// when the cell has none of its own.
it.each([
  ['=PMT(5%/12,60,10000)', '-$188.71'],
  ['=FV(10%,2,-100)', '$210.00'],
  ['=PV(5%,10,-100)', '$772.17'],
  ['=NPV(10%,100,200)', '$256.20'],
  ['=ROUND(PMT(5%/12,60,10000),2)*-1', '$188.71'],
  ['=IRR({-100,60,60})', '13.07%'],
  ['=RATE(10,-100,800)', '4.28%'],
])('shows %s as %s', (formula, shown) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, formula);
  expect(wb.getDisplay(id, 0, 0)).toBe(shown);
});

it('keeps a cell\'s own format, and takes the regional format\'s currency', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { fmt: 'number', dec: 3 });
  wb.setInput(id, 0, 0, '=PMT(5%/12,60,10000)');
  expect(wb.getDisplay(id, 0, 0)).toBe('-188.712');
  setLocale('de-DE');
  wb.setInput(id, 1, 0, '=FV(10%;2;-100)');
  expect(wb.getCell(id, 1, 0).s).toMatchObject({ fmt: 'currency', cur: 'EUR' });
});
