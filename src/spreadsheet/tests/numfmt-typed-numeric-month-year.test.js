import { afterEach, describe, expect, it } from 'vitest';
import { parseInput, setLocale, ymdToSerial } from '../src/core/format.js';
import { Workbook } from '../src/core/workbook.js';

// A month and a four-digit year typed with numbers ("12/2023", the way a card's expiry or a reporting month is
// written) stayed text, though Excel reads it as the first of that month shown as Dec-23, as this app already
// read "Dec 2023". It now reads the same way; a month that cannot be one, or a year before 1900, stays text.
afterEach(() => setLocale('en-US'));

describe('a month and year typed as numbers', () => {
  it.each([['12/2023', 2023, 12], ['1/2013', 2013, 1], ['03/2026', 2026, 3], ['9-2010', 2010, 9]])('reads %s as the first of the month', (text, y, m) => {
    expect(parseInput(text)).toEqual({ v: ymdToSerial(y, m, 1), f: null, fmt: 'custom', code: 'mmm-yy' });
  });

  it('reads it in a regional format that writes days first, and a dotted one where dates are dotted', () => {
    expect(parseInput('3/2024', 'en-GB').v).toBe(ymdToSerial(2024, 3, 1));
    expect(parseInput('3.2024', 'de-DE').v).toBe(ymdToSerial(2024, 3, 1));
    expect(parseInput('3/2024', 'de-DE').v).toBe(ymdToSerial(2024, 3, 1));
  });

  it('leaves what is no month and year as before', () => {
    expect(parseInput('13/2024').v).toBe('13/2024');
    expect(parseInput('0/2024').v).toBe('0/2024');
    expect(parseInput('3/1899').v).toBe('3/1899');
    expect(parseInput('3/20245').v).toBe('3/20245');
    expect(parseInput('3.2024').v).toBe(3.2024);
    expect(parseInput('123/2024').v).toBe('123/2024');
    expect(parseInput('1/2/2024').fmt).toBe('date');
  });

  it('shows as Dec-23 in a cell', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '12/2023');
    expect(wb.getDisplay(id, 0, 0)).toBe('Dec-23');
  });
});
