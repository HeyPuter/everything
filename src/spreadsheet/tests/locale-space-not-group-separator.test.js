import { afterEach, expect, it } from 'vitest';
import { parseInput, setLocale } from '../src/core/format.js';
import { Workbook } from '../src/core/workbook.js';

afterEach(() => setLocale('en-US'));

// Every regional format with a decimal comma read a space between digits as a thousands separator, so in
// German a phone number typed as +1 555 123 became the number 1555123. German, Spanish, Dutch and Turkish
// group thousands with a period; only the formats that write a space there (French, Swedish, Polish, …)
// read one, as Excel does.
it('keeps digits split by spaces as text where the regional format groups with a period', () => {
  for (const loc of ['de-DE', 'es-ES', 'nl-NL', 'tr-TR']) {
    setLocale(loc);
    for (const text of ['+1 555 123', '12 345', '1 234,5', '1 234,5']) expect(parseInput(text).v, `${loc} ${text}`).toBe(text);
    expect(parseInput('1.234,5').v).toBe(1234.5);
  }
  setLocale('de-DE');
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '+1 555 123');
  expect(wb.getValue(id, 0, 0)).toBe('+1 555 123');
});

it('still reads a space as the thousands separator where the regional format writes one', () => {
  for (const loc of ['fr-FR', 'sv-SE', 'pl-PL', 'ru-RU']) {
    setLocale(loc);
    expect(parseInput('1 234,5').v, loc).toBe(1234.5);
    expect(parseInput('1 234,5').v, loc).toBe(1234.5);
    expect(parseInput('1 234 567').v, loc).toBe(1234567);
  }
});
