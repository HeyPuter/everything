import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { readNativePivotCache } from '../src/core/native-pivot-cache.js';
import { setNativePivotSlicerSelection } from '../src/core/native-pivot-slicer-edit.js';

// A PivotTable whose Date field Excel grouped by month (Microsoft's expense report template) keeps
// the months in the cache field's groupItems, and its report items and slicer members count those
// groups (<3/2/2023, Jan … Dec, >5/2/2023), not the field's dates. The pivot code read the dates, so
// the month slicer's member 13 was out of range and the workbook refused to open. Grouped fields now
// read as their groups: the file opens, the slicer lists the months, and a choice redraws the report.
const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const S = 'http://schemas.microsoft.com/office/2007/relationships';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const rows = [['2023-03-02', 0, 10], ['2023-03-20', 1, 5], ['2023-04-04', 1, 7], ['2023-05-01', 0, 3]];
const dates = ['2023-03-02', '2023-03-20', '2023-04-04', '2023-05-01'];

function fixture() {
  const serial = (iso) => Date.UTC(...iso.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0))) / 86400000 + 25569;
  const log = [['Date', 'Category', 'Amount'], ...rows.map(([d, c, a]) => [serial(d), ['Fun', 'Food'][c], a])];
  const cells = Object.fromEntries(log.flatMap((row, r) => row.map((v, c) => [`${r},${c}`, { v, ...(r && !c ? { s: { fmt: 'date' } } : {}) }])));
  const wb = new Workbook({ sheets: [{ name: 'Log', cells }, { name: 'Report' }] });
  const saved = [['Row Labels', 'Sum of Amount'], ['Mar', 15], ['Apr', 7], ['May', 3], ['Grand Total', 25]];
  wb.setCells(wb.sheets[1].id, saved.flatMap((row, r) => row.map((v, c) => ({ r: r + 2, c: c + 1, cell: { v } }))));
  const groupItems = [`<s v="&lt;3/2/2023"/>`, ...MONTHS.map(m => `<s v="${m}"/>`), `<s v="&gt;5/2/2023"/>`].join('');
  const cache = { key: 'source', scope: 'main', sourceSheetId: wb.sheets[0].id, sourceRef: 'A1:C5',
    xml: `<pivotCacheDefinition xmlns="${M}" recordCount="4"><cacheSource type="worksheet"><worksheetSource sheet="Log" ref="A1:C5"/></cacheSource><cacheFields count="3">`
      + `<cacheField name="Date" numFmtId="14"><sharedItems containsSemiMixedTypes="0" containsNonDate="0" containsDate="1" containsString="0" minDate="2023-03-02T00:00:00" maxDate="2023-05-01T00:00:00" count="4">${dates.map(d => `<d v="${d}T00:00:00"/>`).join('')}</sharedItems>`
      + `<fieldGroup base="0"><rangePr groupBy="months" startDate="2023-03-02T00:00:00" endDate="2023-05-02T00:00:00"/><groupItems count="14">${groupItems}</groupItems></fieldGroup></cacheField>`
      + `<cacheField name="Category"><sharedItems count="2"><s v="Fun"/><s v="Food"/></sharedItems></cacheField><cacheField name="Amount"><sharedItems containsNumber="1"/></cacheField></cacheFields>`
      + `<extLst><ext uri="{725AE2AE-9491-48be-B2B4-4EB974FC3084}"><x:pivotCacheDefinition xmlns:x="${X14}" pivotCacheId="2"/></ext></extLst></pivotCacheDefinition>`,
    records: `<pivotCacheRecords xmlns="${M}" count="4">${rows.map(([, c, a], i) => `<r><x v="${i}"/><x v="${c}"/><n v="${a}"/></r>`).join('')}</pivotCacheRecords>` };
  const items = Array.from({ length: 14 }, (_, i) => `<item x="${i}"/>`).join('');
  const report = { name: 'Monthly', owner: wb.sheets[1].id, cache: cache.key, ref: 'B3:C7',
    xml: `<pivotTableDefinition xmlns="${M}" name="Monthly" cacheId="0" dataCaption="Values" createdVersion="6" preserveFormatting="0"><location ref="B3:C7" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>`
      + `<pivotFields count="3"><pivotField axis="axisRow" showAll="0"><items count="15">${items}<item t="default"/></items></pivotField>`
      + `<pivotField showAll="0"><items count="3"><item x="0"/><item x="1"/><item t="default"/></items></pivotField><pivotField dataField="1" showAll="0"/></pivotFields>`
      + `<rowFields count="1"><field x="0"/></rowFields><rowItems count="4"><i><x v="3"/></i><i><x v="4"/></i><i><x v="5"/></i><i t="grand"><x/></i></rowItems>`
      + `<colItems count="1"><i/></colItems><dataFields count="1"><dataField name="Sum of Amount" fld="2"/></dataFields></pivotTableDefinition>` };
  wb.nativePivots = { version: 1, caches: [cache], tables: [report], dxfs: [], styles: [], formats: {}, connections: '' };
  return wb;
}

const slicer = (name, source, members) => `<x:slicerCacheDefinition xmlns:x="${X14}" name="${name}" sourceName="${source}"><x:pivotTables><x:pivotTable tabId="2" name="Monthly"/></x:pivotTables>`
  + `<x:data><x:tabular pivotCacheId="2"><x:items count="${members.length}">${members.map(([x, nd]) => `<x:i x="${x}" s="1"${nd ? ' nd="1"' : ''}/>`).join('')}</x:items></x:tabular></x:data></x:slicerCacheDefinition>`;
const get = (zip, path) => new TextDecoder().decode(X.CFB.find(zip, path)?.content || new Uint8Array());
const set = (zip, path, text) => X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(text));

/** The workbook as Excel saves it: two PivotTable slicer caches, one on the grouped Date field. */
async function excelFile() {
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(fixture())).arrayBuffer()), { type: 'array' });
  const parts = { date: slicer('Slicer_Date', 'Date', [3, 4, 5, 1, 2, 6, 7, 8, 9, 10, 11, 12, 0, 13].map(x => [x, x < 3 || x > 5])), category: slicer('Slicer_Category', 'Category', [[1], [0]]) };
  set(zip, '/xl/workbook.xml', get(zip, '/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')
    .replace('</extLst>', `<ext uri="{BBE1A952-AA13-448E-AADC-164F8A28A991}"><x:slicerCaches xmlns:x="${X14}" xmlns:r="${R}"><x:slicerCache r:id="sDate"/><x:slicerCache r:id="sCategory"/></x:slicerCaches></ext></extLst>`));
  set(zip, '/xl/_rels/workbook.xml.rels', get(zip, '/xl/_rels/workbook.xml.rels').replace('</Relationships>',
    `<Relationship Id="sDate" Type="${S}/slicerCache" Target="slicerCaches/date.xml"/><Relationship Id="sCategory" Type="${S}/slicerCache" Target="slicerCaches/category.xml"/></Relationships>`));
  for (const [name, xml] of Object.entries(parts)) set(zip, `/xl/slicerCaches/${name}.xml`, xml);
  set(zip, '/[Content_Types].xml', get(zip, '/[Content_Types].xml').replace('</Types>', Object.keys(parts).map(n => `<Override PartName="/xl/slicerCaches/${n}.xml" ContentType="application/vnd.ms-excel.slicerCache+xml"/>`).join('') + '</Types>'));
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

const report = (wb) => Array.from({ length: 5 }, (_, r) => [wb.getValue(wb.sheets[1].id, r + 2, 1), wb.getValue(wb.sheets[1].id, r + 2, 2)]);

it('reads a field grouped by month as its months, in the members and in every record', () => {
  const data = readNativePivotCache(fixture().nativePivots.caches[0]);
  expect(data.fields[0].items.map(i => i.value)).toEqual(['<3/2/2023', ...MONTHS, '>5/2/2023']);
  expect(data.records.map(r => [r[0].index, r[0].value])).toEqual([[3, 'Mar'], [3, 'Mar'], [4, 'Apr'], [5, 'May']]);
  expect(data.fields[1].items.map(i => i.value)).toEqual(['Fun', 'Food']);
});

it('opens a workbook whose slicer filters a field grouped by month, and redraws the report from either slicer', async () => {
  const wb = await workbookFromFile(await excelFile());
  expect(wb.nativePivots.slicers.map(s => s.name)).toEqual(['Slicer_Date', 'Slicer_Category']);
  expect(report(wb)).toEqual([['Row Labels', 'Sum of Amount'], ['Mar', 15], ['Apr', 7], ['May', 3], ['Grand Total', 25]]);
  expect(setNativePivotSlicerSelection(wb, wb.nativePivots.slicers[0], [3, 5])).toBe(true);
  expect(report(wb).slice(0, 4)).toEqual([['Row Labels', 'Sum of Amount'], ['Mar', 15], ['May', 3], ['Grand Total', 18]]);
  wb.undo();
  expect(setNativePivotSlicerSelection(wb, wb.nativePivots.slicers[1], [1])).toBe(true);
  expect(report(wb).slice(0, 4)).toEqual([['Row Labels', 'Sum of Amount'], ['Mar', 5], ['Apr', 7], ['Grand Total', 12]]);
  // Saved and opened again, the grouping and both slicers come back.
  const back = await workbookFromFile(await workbookToXlsx(wb));
  expect(back.nativePivots.slicers.map(s => s.name)).toEqual(['Slicer_Date', 'Slicer_Category']);
  expect(readNativePivotCache(back.nativePivots.caches[0]).fields[0].items[4].value).toBe('Apr');
  expect(report(back).slice(0, 4)).toEqual([['Row Labels', 'Sum of Amount'], ['Mar', 5], ['Apr', 7], ['Grand Total', 12]]);
});
