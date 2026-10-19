import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { refill } from '../src/core/autofill-options.js';
import { ymdToSerial, serialToYMD } from '../src/core/format.js';

// Fill Months (and Fill Years) from two dates stepped each new date from the last one, so a day cut short by a
// short month stayed cut: January 31 and February 29 went on as March 29 and April 29, though the drag itself
// had filled March 31 and April 30, and February 29, 2024 then February 28, 2025 by year never came back to
// February 29, 2028. A regular run of dates is now counted from its first date, as one date already was.
const ymd = (v) => { const { y, m, d } = serialToYMD(v); return `${y}-${m}-${d}`; };
function fillDates(dates, kind, count) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, dates.map(([y, m, d], r) => ({ r, c: 0, cell: { v: ymdToSerial(y, m, d), f: null, s: { fmt: 'date' } } })), 'x');
  const source = { r1: 0, c1: 0, r2: dates.length - 1, c2: 0 };
  refill(wb, id, source, { ...source, r2: dates.length - 1 + count }, kind);
  return Array.from({ length: count }, (_, i) => ymd(wb.getValue(id, dates.length + i, 0)));
}

describe('Fill Months and Fill Years after two dates', () => {
  it('keeps month ends', () => {
    expect(fillDates([[2024, 1, 31], [2024, 2, 29]], 'months', 3)).toEqual(['2024-3-31', '2024-4-30', '2024-5-31']);
  });

  it('keeps the day a short month cut short', () => {
    expect(fillDates([[2026, 1, 30], [2026, 2, 28]], 'months', 2)).toEqual(['2026-3-30', '2026-4-30']);
    expect(fillDates([[2024, 2, 29], [2025, 2, 28]], 'years', 3)).toEqual(['2026-2-28', '2027-2-28', '2028-2-29']);
  });

  it('still steps from the last date of a run that is not regular, and counts days as before', () => {
    expect(fillDates([[2026, 1, 5], [2026, 2, 20]], 'months', 2)).toEqual(['2026-3-20', '2026-4-20']);
    expect(fillDates([[2026, 1, 5], [2026, 1, 7]], 'days', 2)).toEqual(['2026-1-9', '2026-1-11']);
  });
});
