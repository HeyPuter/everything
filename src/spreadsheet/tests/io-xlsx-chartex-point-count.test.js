import { expect, it } from 'vitest';
import * as XLSX from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

/** A treemap's file whose data are its cached points alone (no references), with the size level claiming `count` points. */
async function treemapFile(count) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [['Cat', 'Val'], ['A', 10], ['B', 15], ['C', 30]].flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
  wb.addChart(id, { type: 'treemap', range: { r1: 0, c1: 0, r2: 3, c2: 1 }, anchor: { r: 6, c: 1 }, w: 400, h: 250 });
  const zip = XLSX.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const edit = (pattern, change) => {
    const entry = zip.FileIndex[zip.FullPaths.findIndex((p) => pattern.test(p))];
    entry.content = new TextEncoder().encode(change(new TextDecoder().decode(entry.content)));
    entry.size = entry.content.length;
  };
  // Without the app's own sheet the chart is read from its DrawingML, as from a file Excel saved.
  edit(/xl\/workbook\.xml$/, (xml) => xml.replace(/<sheet [^>]*name="_puter_meta"[^>]*\/>/, ''));
  edit(/chartEx[\d_]*\.xml$/, (xml) => xml.replace(/<cx:f>[^<]*<\/cx:f>/g, '')
    .replace(/(<cx:numDim type="size"><cx:lvl )ptCount="3"/, `$1ptCount="${count}"`));
  return new Uint8Array(XLSX.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}

// A chartex chart (treemap, sunburst, funnel, box and whisker) whose data are cached points took the
// point count its file claimed and made an array that long: a count of billions stopped the file opening,
// or ran the tab out of memory. The count is now held to the 5,000 points the reader takes from a cache.
it('opens a treemap whose cached points claim billions of entries', async () => {
  const wb = await workbookFromFile(await treemapFile(4294967296), 'treemap.xlsx');
  const [chart] = wb.activeSheet.charts;
  expect(chart.type).toBe('treemap');
  expect(chart.sourceRefs[0].literal.values.slice(0, 3)).toEqual([10, 15, 30]);
  expect(chart.sourceRefs[0].literal.values.length).toBeLessThanOrEqual(5000);
});

it('still keeps the empty points a modest count names', async () => {
  const wb = await workbookFromFile(await treemapFile(5), 'treemap.xlsx');
  expect(wb.activeSheet.charts[0].sourceRefs[0].literal.values).toEqual([10, 15, 30, null, null]);
});
