import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

/** A workbook with a column chart, saved, its chart part changed by `edit`, read without the app's own sheet. */
async function chartFile(edit) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [['', 'Sales'], ['North', 1], ['South', 2]].flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
  wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 2, c2: 1 }, anchor: { r: 5, c: 1 }, w: 300, h: 200 });
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const change = (pattern, fn) => {
    const entry = zip.FileIndex[zip.FullPaths.findIndex((p) => pattern.test(p))];
    entry.content = new TextEncoder().encode(fn(new TextDecoder().decode(entry.content)));
    entry.size = entry.content.length;
  };
  change(/xl\/workbook\.xml$/, (xml) => xml.replace(/<sheet [^>]*name="_puter_meta"[^>]*\/>/, ''));
  change(/charts\/chart[\d_]*\.xml$/, edit);
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}
const depth = 20000;

// Reading a chart searched its parts' elements by recursion, one call per level of nesting: a part nesting
// a few thousand elements deep (an extension list, a title's runs) overflowed the call stack, and the whole
// file failed to open with "Maximum call stack size exceeded", its cells and all. The search keeps its own
// stack now.
it('opens a file whose chart nests an extension list thousands of levels deep', async () => {
  const bytes = await chartFile((xml) => xml.replace('</c:ser>', `<c:extLst>${'<c:ext>'.repeat(depth)}${'</c:ext>'.repeat(depth)}</c:extLst></c:ser>`));
  const wb = await workbookFromFile(bytes, 'deep.xlsx');
  expect(wb.getValue(wb.activeSheetId, 2, 1)).toBe(2);
  expect(wb.activeSheet.charts.map((chart) => chart.type)).toEqual(['column']);
});

it('opens a file whose chart title nests its text thousands of levels deep, and reads the title', async () => {
  const title = `<c:title><c:tx><c:rich><a:bodyPr/><a:p>${'<a:r>'.repeat(depth)}<a:t>Quarterly</a:t>${'</a:r>'.repeat(depth)}</a:p></c:rich></c:tx></c:title><c:autoTitleDeleted val="0"/>`;
  const wb = await workbookFromFile(await chartFile((xml) => xml.replace('<c:autoTitleDeleted val="1"/>', title)), 'deep.xlsx');
  expect(wb.activeSheet.charts[0].title).toBe('Quarterly');
});
