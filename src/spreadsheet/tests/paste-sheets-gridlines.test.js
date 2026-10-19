// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseHtmlClipboard } from '../src/core/clipboard.js';

// Google Sheets draws its gridlines on the clipboard with a page rule, td {border: 1px solid #cccccc}, and writes a
// border a cell really has on the cell itself. A paste read the rule as a border on every cell, so cells copied
// from Sheets (with no borders there) arrived boxed in grey lines. A Sheets paste now takes only the cells' own
// borders; any other web table still takes the borders its rules draw.
const sheets = (cells) => '<meta charset="utf-8"><google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}'
  + 'br {mso-data-placement:same-cell;}--></style><table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1" '
  + 'style="table-layout:fixed;font-size:10pt;font-family:Arial;width:0px;border-collapse:collapse;border:none" data-sheets-root="1"><tbody><tr style="height:21px;">'
  + cells + '</tr></tbody></table>';
const edges = (style) => ['bt', 'br', 'bb', 'bl'].filter((key) => style?.[key]);

describe('pasting cells copied from Google Sheets', () => {
  it('takes no border from the gridlines Sheets draws', () => {
    const { rows } = parseHtmlClipboard(sheets('<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;">a</td>'
      + '<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;font-weight:bold;">b</td>'), 'a\tb');
    expect(rows[0].map((cell) => cell.text)).toEqual(['a', 'b']);
    expect(rows[0].map((cell) => edges(cell.style))).toEqual([[], []]);
    expect(rows[0][1].style.bold).toBe(true);
  });

  it('keeps a border a cell has', () => {
    const { rows } = parseHtmlClipboard(sheets('<td style="border-bottom:1px solid #000000;overflow:hidden;vertical-align:bottom;">Total</td>'), 'Total');
    expect(edges(rows[0][0].style)).toEqual(['bb']);
    expect(rows[0][0].style.bbBorder).toEqual({ bs: 'thin', bc: '#000000' });
  });

  it('still reads the borders a web page draws with its rules', () => {
    const { rows } = parseHtmlClipboard('<style>td { border: 1px solid #999999 }</style><table><tr><td>x</td></tr></table>', 'x');
    expect(edges(rows[0][0].style)).toEqual(['bt', 'br', 'bb', 'bl']);
  });
});
