// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseHtmlClipboard, cellsFromHtmlRows } from '../src/core/clipboard.js';

// LibreOffice Calc puts each number's own value on the clipboard as sdval beside the text it shows, as Excel
// writes x:num and Google Sheets data-sheets-value. Only those two were read, so cells copied from Calc came in
// as their rounded display: 1.23456 shown as 1.23 pasted as 1.23, and 1/3 as 0.33. The value is now kept, the
// shown text still choosing the format; a TRUE or FALSE (a 1 or 0 to Calc) stays a logical value.
const html = '<table><tr><td sdval="1.23456" sdnum="1033;0;0.00">1.23</td><td sdval="0.333333333333333" sdnum="1033;0;0%">33%</td>'
  + '<td sdval="45366" sdnum="1033;0;MM/DD/YY">03/15/24</td><td sdval="1" sdnum="1033;0;&quot;TRUE&quot;;&quot;TRUE&quot;;&quot;FALSE&quot;">TRUE</td>'
  + '<td>00123</td></tr></table>';

describe('cells copied from LibreOffice Calc', () => {
  it('keep their full values', () => {
    const { rows } = parseHtmlClipboard(html, '1.23\t33%\t03/15/24\tTRUE\t00123');
    const cells = cellsFromHtmlRows(rows).map((e) => e.cell);
    expect(cells.map((c) => c?.v)).toEqual([1.23456, 0.333333333333333, 45366, true, 123]);
    expect(cells[1].s.fmt).toBe('percent');
    expect(cells[2].s.fmt).toBe('date');
  });
});
