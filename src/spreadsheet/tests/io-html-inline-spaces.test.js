import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

// A web-page table's cell text drops the markup, but the space between two pieces of it is
// text: "<b>Total</b> due" reads "Total due" in a browser and in Excel. The reader removed every
// space next to a tag, so such a cell opened as "Totaldue".

const read = async (cells) => {
  const html = `<table><tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr></table>`;
  const wb = await workbookFromFile(new TextEncoder().encode(html), 'report.html');
  return cells.map((_, c) => wb.getValue(wb.activeSheetId, 0, c));
};

it('keeps the space between inline elements and beside them', async () => {
  expect(await read(['<b>Total</b> due', '<font color="red">Late</font> payment <i>fee</i>', 'see <a href="https://example.com">the site</a> now']))
    .toEqual(['Total due', 'Late payment fee', 'see the site now']);
});

it('still drops the indentation of the markup and collapses runs of spaces', async () => {
  expect(await read(['\n    <span>Indented</span>\n  ', '  a   lot    of   space  ', '<p>\n  Wrapped\n  line\n</p>']))
    .toEqual(['Indented', 'a lot of space', 'Wrapped line']);
});

it('keeps line breaks without the spaces beside them', async () => {
  expect(await read(['line one <br> line two', 'a<br/>b', '<b>x</b> <br />\n <i>y</i>']))
    .toEqual(['line one\nline two', 'a\nb', 'x\ny']);
});
