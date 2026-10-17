// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { parseInput, setLocale } from '../src/core/format.js';
import { Workbook } from '../src/core/workbook.js';
import { parseHtmlClipboard, cellsFromHtmlRows } from '../src/core/clipboard.js';
import { workbookFromFile } from '../src/core/io.js';
import native from './fixtures/reference-numeric-input-digits.json';

afterEach(() => setLocale('en-US'));

// A typed percent was stored as its number divided by 100, so 12.3% held 0.12300000000000001, which
// MATCH(0.123, ...) and = 0.123 did not find. Excel moves the decimal point of the digits as typed.
const cases = [['1.1%', 0.011], ['12.3%', 0.123], ['0.7%', 0.007], ['33.3%', 0.333], ['-14.1%', -0.141], ['57%', 0.57], ['%12.5', 0.125]];

it.each(cases)('reads a typed %s as the exact decimal', (text, value) => {
  expect(parseInput(text)).toMatchObject({ v: value, fmt: 'percent' });
});

it('matches the native reference for 12.3% when typed, pasted and read from a CSV', async () => {
  const ref = native.syntax.find((r) => r.ascii === '12.3%');
  expect(parseInput('12.3%').v).toBe(ref.asciiValue);
  expect(cellsFromHtmlRows(parseHtmlClipboard('<table><tr><td>12.3%</td></tr></table>').rows)[0].cell.v).toBe(ref.asciiHtml);
  const csv = await workbookFromFile(new TextEncoder().encode('rate\r\n12.3%\r\n'), 'r.csv');
  expect(csv.getValue(csv.activeSheetId, 1, 0)).toBe(0.123);
});

it('finds a typed percent by its decimal', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '12.3%');
  wb.setInput(id, 0, 1, '=MATCH(0.123,A1,0)');
  wb.setInput(id, 0, 2, '=A1=0.123');
  expect(wb.getValue(id, 0, 1)).toBe(1);
  expect(wb.getValue(id, 0, 2)).toBe(true);
});

it('reads a decimal-comma percent exactly too', () => {
  setLocale('de-DE');
  expect(parseInput('12,3 %').v).toBe(0.123);
  expect(parseInput('1.234,5%').v).toBe(12.345);
});
