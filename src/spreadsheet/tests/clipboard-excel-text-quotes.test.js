// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { cellsFromHtmlRows, parseHtmlClipboard } from '../src/core/clipboard.js';

const office = body => `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><body><table>${body}</table></body></html>`;
const values = result => cellsFromHtmlRows(result.rows).map(x => x.cell?.v ?? null);

// Excel's HTML shows a cell as drawn (### in a narrow column, runs of spaces collapsed) and its text
// carries the cells' own values, which a paste takes. Excel quotes a cell in that text only when it
// holds a line break or a tab, so a cell reading 12" pipe comes as it is, and such a quote made the whole
// text unreadable to the paste: every cell of the block fell back to its drawing, ### and all.
it('takes the cells from Excel\'s text when one of them holds a quote mark', () => {
  const html = office('<tr><td>###</td><td>12" pipe</td><td>a b</td></tr><tr><td>say "hi"</td><td>x</td><td>"lead</td></tr>');
  const text = '123456789\t12" pipe\ta  b\r\nsay "hi"\tx\t"""lead"\r\n';
  expect(values(parseHtmlClipboard(html, text))).toEqual([123456789, '12" pipe', 'a  b', 'say "hi"', 'x', '"lead']);
});

it('still ignores text whose quoting does not close where a field ends', () => {
  const html = office('<tr><td>left</td><td>right</td></tr>');
  expect(values(parseHtmlClipboard(html, '"bad"quote\tb'))).toEqual(['left', 'right']);
});
