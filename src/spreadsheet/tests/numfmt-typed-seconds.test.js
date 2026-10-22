import { describe, expect, it } from 'vitest';
import { parseInput, editText, ymdToSerial } from '../src/core/format.js';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

describe('a time typed with seconds', () => {
  it('implies the seconds variant of the time format, and one without seconds does not', () => {
    expect(parseInput('09:05:30')).toEqual({ v: 32730 / 86400, f: null, fmt: 'time', sec: true });
    expect(parseInput('1:5:7')).toEqual({ v: 3907 / 86400, f: null, fmt: 'time', sec: true });
    expect(parseInput('9:05:30 pm')).toEqual({ v: 75930 / 86400, f: null, fmt: 'time', sec: true });
    expect(parseInput('13:45')).toEqual({ v: 49500 / 86400, f: null, fmt: 'time' });
    expect(parseInput('1:45 pm')).toEqual({ v: 49500 / 86400, f: null, fmt: 'time' });
  });

  it('does the same after a date', () => {
    expect(parseInput('2024-01-15 13:45:30')).toEqual({ v: 45306 + 49530 / 86400, f: null, fmt: 'datetime', sec: true });
    expect(parseInput('1/15/2024 9:00:05 AM')).toEqual({ v: 45306 + 32405 / 86400, f: null, fmt: 'datetime', sec: true });
    expect(parseInput('2024-01-15 13:45')).toEqual({ v: 45306 + 49500 / 86400, f: null, fmt: 'datetime' });
    expect(parseInput('Aug 28, 2026 3:45 pm')).toEqual({ v: 46262.65625, f: null, fmt: 'datetime' });
  });

  it('shows the typed seconds in the cell and keeps them through editing and a save', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '09:05:30');
    wb.setInput(id, 1, 0, '13:45');
    wb.setInput(id, 2, 0, '2024-01-15 13:45:30');
    wb.setInput(id, 3, 0, '2024-01-15 13:45');
    expect(wb.getCell(id, 0, 0)).toEqual({ v: 32730 / 86400, f: null, s: { fmt: 'time', sec: true } });
    expect(wb.getDisplay(id, 0, 0)).toBe('09:05:30');
    expect(editText(wb.getCell(id, 0, 0))).toBe('09:05:30');
    expect(wb.getCell(id, 1, 0).s).toEqual({ fmt: 'time' });
    expect(wb.getDisplay(id, 1, 0)).toBe('13:45');
    expect(wb.getCell(id, 2, 0).s).toEqual({ fmt: 'datetime', sec: true });
    expect(wb.getDisplay(id, 2, 0)).toBe('2024-01-15 13:45:30');
    expect(wb.getCell(id, 3, 0).s).toEqual({ fmt: 'datetime' });
    expect(wb.getDisplay(id, 3, 0)).toBe('2024-01-15 13:45');
    const reopened = await workbookFromFile(await workbookToXlsx(wb), 'times.xlsx');
    expect(reopened.getDisplay(reopened.activeSheetId, 0, 0)).toBe('09:05:30');
    expect(reopened.getDisplay(reopened.activeSheetId, 1, 0)).toBe('13:45');
    expect(reopened.getDisplay(reopened.activeSheetId, 2, 0)).toBe('2024-01-15 13:45:30');
  });

  it('keeps the seconds setting of a time cell the user formatted, with or without seconds, and leaves other formats alone', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.applyStyle(id, parseRange('A1'), { fmt: 'time' }); // the toolbar's Time button, no seconds setting: hh:mm
    wb.applyStyle(id, parseRange('A2'), { fmt: 'time', sec: true }); // as an hh:mm:ss code imports
    wb.applyStyle(id, parseRange('A3'), { fmt: 'date' });
    wb.setInput(id, 0, 0, '09:05:20');
    wb.setInput(id, 1, 0, '13:45');
    wb.setInput(id, 2, 0, '09:05:30');
    expect(wb.getCell(id, 0, 0).s).toEqual({ fmt: 'time' });
    expect(wb.getDisplay(id, 0, 0)).toBe('09:05');
    expect(editText(wb.getCell(id, 0, 0))).toBe('09:05:20'); // the seconds are kept in the value
    expect(wb.getCell(id, 1, 0).s).toEqual({ fmt: 'time', sec: true });
    expect(wb.getDisplay(id, 1, 0)).toBe('13:45:00');
    // A date format cannot show a time typed into it (it read 1900-01-00): the entry's own time format, with its
    // seconds, replaces it, as Excel's does.
    expect(wb.getCell(id, 2, 0).s).toEqual({ fmt: 'time', sec: true });
    expect(wb.getDisplay(id, 2, 0)).toBe('09:05:30');
  });

  it('is read the same way by Convert to numbers and by a CSV import', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, "'09:05:30");
    wb.transformText(id, parseRange('A1'), 'number');
    expect(wb.getCell(id, 0, 0)).toEqual({ v: 32730 / 86400, f: null, s: { fmt: 'time', sec: true } });
    const imported = await workbookFromFile(new TextEncoder().encode('09:05:30,13:45,2024-01-15 13:45:30\n'), 'times.csv');
    const sheet = imported.activeSheetId;
    expect(imported.getCell(sheet, 0, 0).s).toEqual({ fmt: 'time', sec: true });
    expect(imported.getCell(sheet, 0, 1).s).toEqual({ fmt: 'time' });
    expect(imported.getCell(sheet, 0, 2).s).toEqual({ fmt: 'datetime', sec: true });
    expect(imported.getDisplay(sheet, 0, 2)).toBe('2024-01-15 13:45:30');
    expect(ymdToSerial(2024, 1, 15)).toBe(45306);
  });
});
