// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { parseHtmlClipboard, cellsFromHtmlRows } from '../src/core/clipboard.js';
import { formatValue } from '../src/core/format.js';

const cells = (row) => cellsFromHtmlRows(parseHtmlClipboard(`<html><head><meta name="generator" content="LibreOffice 24.2"/></head><body><table><tr>${row}</tr></table></body></html>`, '').rows).map((e) => e.cell);

// A number LibreOffice Calc shows through a format of its own (a unit, a currency after the amount, Calc's
// German separators) came in as the text it showed, though its value was on the clipboard as sdval: the
// shown text read as no number here, and such text is kept as text, as a Sheets weekday is. A column of
// weights or prices pasted from Calc could not be summed. The number now comes in with the format sdnum
// names, read in the separators of the language sdnum gives with it.
it('keeps the number behind text Calc showed through its own format', () => {
  const pasted = cells('<td sdval="1.5" sdnum="1033;0;0.0&quot; kg&quot;">1.5 kg</td>'
    + '<td sdval="1234.5" sdnum="1031;0;#.##0,00 [$€-407]">1.234,50 €</td>'
    + '<td sdval="-7" sdnum="1033;0;0&quot; pcs&quot;;[RED]-0&quot; pcs&quot;">-7 pcs</td>'
    + '<td sdval="0.125" sdnum="1031;0;0,0 %">12,5 %</td>');
  expect(pasted.map((c) => c.v)).toEqual([1.5, 1234.5, -7, 0.125]);
  expect(pasted.map((c) => formatValue(c.v, c.s))).toEqual(['1.5 kg', '1,234.50 €', '-7 pcs', '12.5 %']);
});

it('leaves text Calc wrote with a code in another language\'s words as the text it showed', () => {
  // Calc spells a German date code in German (TT.MM.JJJJ) and a weekday as NNNN: neither is a code here.
  const pasted = cells('<td sdval="45366" sdnum="1031;0;NNNN">Freitag</td><td sdval="45366" sdnum="1033;0;NNNN">Friday</td>');
  expect(pasted.map((c) => c.v)).toEqual(['Freitag', 'Friday']);
});

it('keeps the shown format where the shown text reads as the number', () => {
  const pasted = cells('<td sdval="1.23456" sdnum="1033;0;0.00">1.23</td><td sdval="45366" sdnum="1033;0;MM/DD/YY">03/15/24</td>');
  expect(pasted.map((c) => c.v)).toEqual([1.23456, 45366]);
  expect(pasted[1].s.fmt).toBe('date');
});
