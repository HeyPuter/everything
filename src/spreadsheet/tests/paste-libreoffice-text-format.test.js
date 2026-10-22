// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { parseHtmlClipboard, cellsFromHtmlRows } from '../src/core/clipboard.js';

// LibreOffice Calc marks a cell in its Text format with sdnum="1033;0;@" (the language, then the format
// code), as Excel writes mso-number-format:"@". Only Excel's mark was read, so cells formatted as text in
// Calc lost what the format kept: 00123 pasted as 123, 1/2 as a date and TRUE as a logical value.
const cells = (html) => cellsFromHtmlRows(parseHtmlClipboard(html, '').rows).map((e) => e.cell);
const page = (row) => `<html><head><meta name="generator" content="LibreOffice 7.6"/></head><body><table><tr>${row}</tr></table></body></html>`;

it('keeps cells in Calc\'s Text format as their text', () => {
  const pasted = cells(page('<td align="left" sdnum="1033;0;@">00123</td><td sdnum="1033;0;@">1/2</td><td sdnum="1033;1033;@">TRUE</td>'));
  expect(pasted.map((c) => c.v)).toEqual(['00123', '1/2', 'TRUE']);
  expect(pasted.every((c) => c.s?.fmt === 'text')).toBe(true);
});

it('reads Calc\'s other cells as before', () => {
  const pasted = cells(page('<td sdval="123" sdnum="1033;0;0">123</td><td>00123</td><td sdval="0.5" sdnum="1033;0;0%">50%</td>'));
  expect(pasted.map((c) => c.v)).toEqual([123, 123, 0.5]);
  expect(pasted[2].s.fmt).toBe('percent');
});
