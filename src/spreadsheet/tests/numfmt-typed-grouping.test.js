import { afterEach, describe, expect, it } from 'vitest';
import { parseInput, setLocale } from '../src/core/format.js';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { workbookFromFile } from '../src/core/io.js';

afterEach(() => setLocale('en-US'));

describe('typed thousands separators', () => {
  it.each([
    ['1,000', 1000, 0, '1,000'],
    ['1,234.50', 1234.5, 2, '1,234.50'],
    ['1,234.5', 1234.5, 2, '1,234.50'],
    ['12,345,678', 12345678, 0, '12,345,678'],
    ['(1,234)', -1234, 0, '-1,234'],
    ['-1,234.', -1234, 0, '-1,234'],
  ])('make %s a grouped number with the decimals typed', (text, value, dec, display) => {
    expect(parseInput(text)).toEqual({ v: value, f: null, fmt: 'number' });
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, text);
    expect(wb.getCell(id, 0, 0)).toEqual({ v: value, f: null, s: { fmt: 'number', dec } });
    expect(wb.getDisplay(id, 0, 0)).toBe(display);
  });

  it('leave a number typed without separators in the General format', () => {
    expect(parseInput('1000')).toEqual({ v: 1000, f: null, fmt: null });
    expect(parseInput('1234.5')).toEqual({ v: 1234.5, f: null, fmt: null });
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '1000');
    expect(wb.getCell(id, 0, 0)).toEqual({ v: 1000, f: null });
    expect(wb.getDisplay(id, 0, 0)).toBe('1000');
  });

  it('keep a format the cell already has, decimals included', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.applyStyle(id, parseRange('A1'), { fmt: 'currency', cur: 'USD' });
    wb.applyStyle(id, parseRange('A2'), { fmt: 'number', dec: 1 });
    wb.applyStyle(id, parseRange('A3'), { fmt: 'percent', dec: 0 });
    for (let r = 0; r < 3; r++) wb.setInput(id, r, 0, '1,000');
    expect(wb.getCell(id, 0, 0).s).toEqual({ fmt: 'currency', cur: 'USD' });
    expect(wb.getDisplay(id, 0, 0)).toBe('$1,000.00');
    expect(wb.getCell(id, 1, 0).s).toEqual({ fmt: 'number', dec: 1 });
    expect(wb.getDisplay(id, 1, 0)).toBe('1,000.0');
    expect(wb.getCell(id, 2, 0).s).toEqual({ fmt: 'percent', dec: 0 });
  });

  it('still make a typed currency a currency cell', () => {
    expect(parseInput('$1,200')).toEqual({ v: 1200, f: null, fmt: 'currency', cur: 'USD' });
    expect(parseInput('1,200 €').fmt).toBe('currency');
  });

  it('follow the locale: 1.000,5 groups in German, 1,5 does not', () => {
    setLocale('de-DE');
    expect(parseInput('1.000,5')).toEqual({ v: 1000.5, f: null, fmt: 'number' });
    // German groups with a period only: a space between digits is text there (a phone number), as in Excel.
    expect(parseInput('1 000,5')).toEqual({ v: '1 000,5', f: null, fmt: null });
    expect(parseInput('1,5')).toEqual({ v: 1.5, f: null, fmt: null });
    expect(parseInput('1,000')).toEqual({ v: 1, f: null, fmt: null });
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '1.000,5');
    expect(wb.getCell(id, 0, 0).s).toEqual({ fmt: 'number', dec: 2 });
    expect(wb.getDisplay(id, 0, 0)).toBe('1.000,50');
    wb.setInput(id, 1, 0, '1.000');
    expect(wb.getCell(id, 1, 0).s).toEqual({ fmt: 'number', dec: 0 });
    expect(wb.getDisplay(id, 1, 0)).toBe('1.000');
    setLocale('en-IN');
    wb.setInput(id, 2, 0, '12,34,567');
    expect(wb.getCell(id, 2, 0).s).toEqual({ fmt: 'number', dec: 0 });
    expect(wb.getDisplay(id, 2, 0)).toBe('12,34,567');
  });

  it('apply through Convert to numbers and a CSV import', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, "'1,000");
    wb.transformText(id, parseRange('A1'), 'number');
    expect(wb.getCell(id, 0, 0)).toEqual({ v: 1000, f: null, s: { fmt: 'number', dec: 0 } });
    const imported = await workbookFromFile(new TextEncoder().encode('"1,234.50",1000\n'), 'amounts.csv');
    expect(imported.getCell(imported.activeSheetId, 0, 0)).toEqual({ v: 1234.5, f: null, s: { fmt: 'number', dec: 2 } });
    expect(imported.getCell(imported.activeSheetId, 0, 1)).toEqual({ v: 1000, f: null, s: undefined });
  });
});
