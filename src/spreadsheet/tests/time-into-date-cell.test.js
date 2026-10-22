import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// A time typed (or put in with Ctrl+Shift+;) into a cell formatted as a date alone kept the date format and read
// 1900-01-00; a date put into a cell formatted as a time alone read 00:00. Excel gives the entry its own format
// there; so does the app now. A format that shows both, or one that is no date or time, is kept.
it('gives a time typed into a date cell, or a date into a time cell, a format that shows it', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.applyStyle(id, parseRange('A1:A3'), { fmt: 'date', dateStyle: 'long' });
  wb.applyStyle(id, parseRange('B1:B2'), { fmt: 'time', sec: true });
  wb.applyStyle(id, parseRange('C1'), { fmt: 'custom', code: 'd mmm yyyy' });
  wb.applyStyle(id, parseRange('D1'), { fmt: 'datetime' });
  wb.applyStyle(id, parseRange('E1'), { fmt: 'currency' });
  wb.setInput(id, 0, 0, '16:07');
  wb.setInput(id, 1, 0, '25:30');
  wb.setInput(id, 2, 0, '2024-03-01');
  wb.setInput(id, 0, 1, '2024-03-01');
  wb.setInput(id, 1, 1, '9:15:30');
  wb.setInput(id, 0, 2, '7:45 PM');
  wb.setInput(id, 0, 3, '16:07');
  wb.setInput(id, 0, 4, '16:07');
  expect(wb.getDisplay(id, 0, 0)).toBe('16:07');
  expect(wb.getDisplay(id, 1, 0)).toBe('25:30:00');
  expect(wb.styleAt(id, 2, 0)).toMatchObject({ fmt: 'date', dateStyle: 'long' }); // a date in a date cell keeps it
  expect(wb.getDisplay(id, 0, 1)).toBe('2024-03-01');
  expect(wb.styleAt(id, 1, 1)).toMatchObject({ fmt: 'time', sec: true });
  expect(wb.getDisplay(id, 0, 2)).toBe('19:45');
  expect(wb.styleAt(id, 0, 3).fmt).toBe('datetime');
  expect(wb.styleAt(id, 0, 4).fmt).toBe('currency');
});
