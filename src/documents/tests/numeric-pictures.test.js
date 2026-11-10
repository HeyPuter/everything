// Numeric pictures (\# switch, ECMA-376 Part 1 §17.16.4.2) of formula and merge fields: sign placeholders,
// quoted literals, a leading grouping comma, x and decimal halves were mishandled, and merge fields had a
// formatter of their own; both now use formatFormulaNumber.
import { it, expect } from 'vitest';
import { formatFormulaNumber, evaluateFormula } from '../src/engine/table-formula.js';
import { formatNumberPicture } from '../src/engine/merge-fields.js';

// ECMA-376 Part 1 §17.16.4.2 numeric picture items:
//   "+" adds a plus sign to a positive result, a minus sign to a negative one, a space to zero;
//   "-" adds a minus sign to a negative result, a space to a positive result or zero.
it('formula pictures: + and - are sign placeholders, not literal text', () => {
  expect(formatFormulaNumber(5, '-0')).toBe(' 5');
  expect(formatFormulaNumber(-5, '-0')).toBe('-5');
  expect(formatFormulaNumber(5, '+0')).toBe('+5');
  expect(formatFormulaNumber(-5, '+0')).toBe('-5');
  expect(formatFormulaNumber(0, '+0')).toBe(' 0');
});
it('merge field pictures: + and - are sign placeholders (a positive value is not shown negative)', () => {
  expect(formatNumberPicture('5', '-0')).toBe(' 5');
  expect(formatNumberPicture('-5', '-0')).toBe('-5');
  expect(formatNumberPicture('-5', '+0')).toBe('-5');
});

// Text in single quotes is literal (§17.16.4.2): its letters and digits are not digit placeholders.
it('merge field pictures keep quoted literals containing x, 0 or # intact', () => {
  expect(formatNumberPicture('1234', "#,##0 'boxes'")).toBe('1,234 boxes');
  expect(formatNumberPicture('12', "'Tax: '$0.00")).toBe('Tax: $12.00');
  expect(formatNumberPicture('3', "0 'of 10'")).toBe('3 of 10');
});

// A comma among the integer placeholders turns on digit grouping (§17.16.4.2); "$,0.00" is the common way to
// group thousands without reserving # positions. The comma before the first 0 is still a grouping mark.
it('a leading grouping comma groups thousands (formula and merge field)', () => {
  expect(formatFormulaNumber(1234.5, '$,0.00')).toBe('$1,234.50');
  expect(formatNumberPicture('1234.5', '$,0.00')).toBe('$1,234.50');
});

// ROUND already rounds 1.005 to 1.01 (decimal shifting avoids 100.49999…); the picture and the
// default two-decimal display should round the same value the same way.
it('a 0.00 picture and the default display round decimal halves like ROUND does', () => {
  const doc = { text: '', paragraphs: [], tables: [] };
  expect(evaluateFormula(doc, '=ROUND(1.005,2)', null)).toBe('1.01');
  expect(formatFormulaNumber(1.005, '0.00')).toBe('1.01');
  expect(evaluateFormula(doc, '=1.005', null)).toBe('1.01');
  expect(formatFormulaNumber(2.675, '#,##0.00')).toBe('2.68');
});

// §17.16.4.2 "x": drops digits to the left of the placeholder. The clause's own example:
// { = 111053 + 111439 \# x## } displays 492.
it('the x placeholder drops digits to its left (formula and merge field)', () => {
  expect(formatFormulaNumber(111053 + 111439, 'x##')).toBe('492');
  expect(formatNumberPicture('222492', 'x##')).toBe('492');
});

// Characters between digit placeholders keep their place among the digits (§17.16.4.2 fills placeholders
// with the result's digits; the clause gives literals no other position). The numeric-page-fields native
// reference control shows it: "00-00" formats 12 as "00 12" and "00'-'00" as "00-12". They were moved
// after the number, so "# ##0" gave "1234 " and a phone-number picture lost its layout.
it('keeps literals and signs between digit placeholders in place (formula and merge field)', () => {
  expect(formatFormulaNumber(1234, '# ##0')).toBe('1 234');
  expect(formatFormulaNumber(1234567, '# ##0')).toBe('1234 567');
  expect(formatFormulaNumber(1234.5, '# ##0.00')).toBe('1 234.50');
  expect(formatFormulaNumber(-1234, '# ##0')).toBe('-1 234');
  expect(formatFormulaNumber(12, '000 000')).toBe('000 012');
  expect(formatFormulaNumber(12, '00-00')).toBe('00 12');
  expect(formatFormulaNumber(-12, '00-00')).toBe('00-12');
  expect(formatFormulaNumber(12, "00'-'00")).toBe('00-12');
  expect(formatNumberPicture('5551234567', "(000) 000'-'0000")).toBe('(555) 123-4567');
  expect(formatNumberPicture('123456789', "000'-'00'-'0000")).toBe('123-45-6789');
  // Optional places left empty take no room here, so neither does a separator among them.
  expect(formatFormulaNumber(12, '# ##0')).toBe('12');
  expect(formatFormulaNumber(0, '# ##0')).toBe('0');
});
