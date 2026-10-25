import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

afterEach(() => vi.unstubAllGlobals());

const chart = (type, trendline) => ({ type, title: 'Trend', anchor: { r: 0, c: 3 }, range: { r1: 0, c1: 0, r2: 1, c2: 1 }, trendline,
  sourceRefs: [{ name: 'Sales', literal: { categories: ['North', 'South', 'East'], values: [3, 7, 9], x: [1, 2, 3], sizes: [2, 4, 3] } }],
  ...(type === 'bubble' ? { appearance: { bubble: {} } } : {}) });

const saved = async (wb) => {
  vi.stubGlobal('Blob', NodeBlob);
  return X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
};
const chartXml = zip => new TextDecoder().decode(zip.FileIndex[zip.FullPaths.findIndex(p => /\/charts\/chart[^/]*\.xml$/.test(p))].content);
// The file as Excel saves it: without this app's own record of the workbook.
const asExcelFile = (zip, edit = xml => xml) => {
  const book = X.CFB.find(zip, '/xl/workbook.xml');
  book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  book.size = book.content.length;
  const part = zip.FileIndex[zip.FullPaths.findIndex(p => /\/charts\/chart[^/]*\.xml$/.test(p))];
  part.content = new TextEncoder().encode(edit(new TextDecoder().decode(part.content)));
  part.size = part.content.length;
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
};

// A chart's trendline in an Excel file was never read, so opening and saving the file again dropped it.
it.each(['column', 'bar', 'line', 'area', 'scatter', 'bubble'])('opens the linear trendline of a %s chart and saves it again', async type => {
  const zip = await saved(new Workbook({ sheets: [{ name: 'Data', charts: [chart(type, true)] }] }));
  expect(chartXml(zip)).toContain('<c:trendline><c:trendlineType val="linear"/></c:trendline>');
  const back = await workbookFromFile(asExcelFile(zip), 'excel.xlsx');
  expect(back.activeSheet.charts[0].trendline).toBe(true);
  expect(chartXml(await saved(back))).toContain('<c:trendline><c:trendlineType val="linear"/></c:trendline>');
});

it('opens a chart without a trendline as one without', async () => {
  const back = await workbookFromFile(asExcelFile(await saved(new Workbook({ sheets: [{ name: 'Data', charts: [chart('column', false)] }] }))), 'excel.xlsx');
  expect(back.activeSheet.charts[0].trendline).toBe(false);
});

// A polynomial or moving-average trendline was dropped, as the app drew only straight ones.
it('opens a polynomial or moving-average trendline as one of its kind and saves it again', async () => {
  for (const [kind, expected] of [['<c:trendlineType val="poly"/><c:order val="3"/>', { type: 'poly', order: 3 }],
    ['<c:trendlineType val="movingAvg"/><c:period val="2"/>', { type: 'movingAvg', period: 2 }]]) {
    const zip = await saved(new Workbook({ sheets: [{ name: 'Data', charts: [chart('line', true)] }] }));
    const back = await workbookFromFile(asExcelFile(zip, xml => xml.replace('<c:trendlineType val="linear"/>', kind)), 'excel.xlsx');
    expect(back.activeSheet.charts[0].trendline).toBe(true);
    expect(back.activeSheet.charts[0].trendlines[0]).toMatchObject(expected);
    expect(chartXml(await saved(back))).toContain(`<c:trendline>${kind}</c:trendline>`);
  }
});
