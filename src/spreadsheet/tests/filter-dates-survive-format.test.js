import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A list filtered to the date 2024-01-15 hid every row once the column took another date format (dd/mm/yyyy) and
// the filter was applied again, by Reapply or by any row inserted on the sheet: the chosen date was kept as its
// number with the format it was shown in. Excel keeps a chosen date chosen whatever its format.
it('keeps the chosen dates shown after the column is formatted another way', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['Date', '2024-01-15', '2024-02-01', '2024-01-15', '2024-03-09'].forEach((v, r) => wb.setInput(id, r, 0, v));
  ['Amt', '1', '2', '3', '4'].forEach((v, r) => wb.setInput(id, r, 1, v));
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 4, c2: 1 });
  const shown = () => [1, 2, 3, 4].filter((r) => !wb.sheet(id).filterHidden.has(r)).map((r) => wb.getValue(id, r, 1));
  wb.setFilterCriteria(id, 0, { values: ['2024-01-15'] });
  expect(shown()).toEqual([1, 3]);
  wb.applyStyle(id, { r1: 1, c1: 0, r2: 4, c2: 0 }, { fmt: 'custom', code: 'dd/mm/yyyy' });
  wb.insertRows(id, 10, 1);
  expect(shown()).toEqual([1, 3]);
  wb.reapplyFilter(id);
  expect(shown()).toEqual([1, 3]);
  // The filter menu still reads the date as chosen under its new spelling.
  const keys = wb.filterKeysByText(id, 0).get('15/01/2024');
  expect([...keys].some((k) => wb.sheet(id).filter.criteria[0].keys.includes(k))).toBe(true);
});
