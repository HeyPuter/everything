import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { refill } from '../src/core/autofill-options.js';
import { serialToYMD } from '../src/core/format.js';

// Auto Fill Options ▸ Fill Weekdays walked every calendar day from the source to each filled cell, so a
// date dragged down 10,000 rows froze the tab for about 17 seconds. Whole weeks are now skipped at once.
const walk = (serial, n) => {
  let d = serial; const sign = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0;) { d += sign; const wd = serialToYMD(d).weekday; if (wd !== 0 && wd !== 6) left--; }
  return d;
};

it('fills weekdays down and up, from a weekday or a weekend, as walking day by day does', () => {
  for (const start of ['2024-01-15', '2024-01-19', '2024-01-20', '2024-01-21']) {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.setInput(id, 40, 0, start);
    const first = wb.getValue(id, 40, 0);
    refill(wb, id, { r1: 40, c1: 0, r2: 40, c2: 0 }, { r1: 0, c1: 0, r2: 80, c2: 0 }, 'weekdays');
    for (let r = 0; r <= 80; r++) expect(wb.getValue(id, r, 0), `${start} row ${r}`).toBe(walk(first, r - 40));
  }
});

it('fills 10,000 rows of weekdays without walking every day', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '2024-01-15');
  const t0 = performance.now();
  refill(wb, id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 0, r2: 9999, c2: 0 }, 'weekdays');
  expect(performance.now() - t0).toBeLessThan(3000);
  expect(wb.getValue(id, 9999, 0)).toBe(walk(wb.getValue(id, 0, 0), 9999));
});
