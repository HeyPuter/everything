import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { recommendPivots } from '../src/core/pivot-recommend.js';

const ROWS = [['Order date', 'Region', 'Amount'], ['12/30/2023', 'North', 30], ['1/2/2024', 'South', 50], ['12/30/2023', 'North', 12],
  ['1/10/2024', 'East', 24], ['1/2/2024', 'South', 9], ['1/10/2024', 'North', 5]];

it('groups by a date column instead of totalling it, and previews its dates as dates in date order', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ROWS.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  const picks = recommendPivots(wb, id, { r1: 0, c1: 0, r2: ROWS.length - 1, c2: 2 });
  const titles = picks.map((p) => p.title);
  expect(titles.some((t) => t.startsWith('Sum of Order date'))).toBe(false);
  expect(titles).toContain('Sum of Amount by Order date');
  const byDate = picks.find((p) => p.title === 'Sum of Amount by Order date');
  const shown = (r) => wb.getDisplay(id, r, 0);
  expect(shown(1)).not.toBe(String(wb.getValue(id, 1, 0)));
  expect(byDate.preview).toEqual([[shown(1), 42], [shown(2), 59], [shown(4), 29]]);
});
