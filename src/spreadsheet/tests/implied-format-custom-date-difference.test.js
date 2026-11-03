import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// =B1-A1 over two dates is a count of days, and a cell in the Date format gives it as one (60). Dates shown
// through a code of their own, dd/mm/yyyy or one an .xlsx carries, made the difference a date as well:
// 29/02/1900 for the sixty days between 1 January and 1 March.
it('gives a date minus a date in a custom date code as a number of days', () => {
  for (const code of ['dd/mm/yyyy', '[$-409]mmmm d, yyyy', 'd mmm yyyy h:mm']) {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '2024-01-01');
    wb.setInput(id, 0, 1, '2024-03-01');
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 1 }, { fmt: 'custom', code });
    wb.setInput(id, 0, 2, '=B1-A1');
    expect(wb.getCell(id, 0, 2).s).toBeUndefined();
    expect(wb.getDisplay(id, 0, 2)).toBe('60');
    // A date and a number of days is still a date, in the code it was written in.
    wb.setInput(id, 0, 3, '=A1+1');
    expect(wb.getCell(id, 0, 3).s).toEqual({ fmt: 'custom', code });
  }
  // A custom code that shows no date carries through a difference as before.
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '10');
  wb.setInput(id, 0, 1, '25');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 1 }, { fmt: 'custom', code: '#,##0.0 "kg"' });
  wb.setInput(id, 0, 2, '=B1-A1');
  expect(wb.getDisplay(id, 0, 2)).toBe('15.0 kg');
});
