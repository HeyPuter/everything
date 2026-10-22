import { expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { slicerItems } from '../src/core/slicer.js';

// One PivotTable slicer this app cannot model kept the whole workbook from opening: a slicer on a
// field Excel derives from another (Months (Date), a field of its own with no records) failed its
// binding, and the file was refused with "Invalid native slicer: pivot slicer member index". Such a
// slicer is now left out with a warning; the other slicers, the report and the data open as saved.
const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const S = 'http://schemas.microsoft.com/office/2007/relationships';
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const SLE = 'http://schemas.microsoft.com/office/drawing/2010/slicer';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const A14 = 'http://schemas.microsoft.com/office/drawing/2010/main';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dates = ['2023-03-02', '2023-03-20', '2023-04-04'];

function fixture({ food = '<s v="Food"/>' } = {}) {
  const cells = { '0,0': { v: 'Date' }, '0,1': { v: 'Category' }, '0,2': { v: 'Amount' } };
  [[45000, 'Fun', 10], [45018, 'Food', 5], [45020, 'Food', 7]].forEach((row, r) => row.forEach((v, c) => { cells[`${r + 1},${c}`] = { v }; }));
  const wb = new Workbook({ sheets: [{ name: 'Log', cells }, { name: 'Report' }] });
  const saved = [['Row Labels', 'Sum of Amount'], ['Mar', 15], ['Apr', 7], ['Grand Total', 22]];
  wb.setCells(wb.sheets[1].id, saved.flatMap((row, r) => row.map((v, c) => ({ r: r + 2, c: c + 1, cell: { v } }))));
  const groupItems = [`<s v="&lt;3/2/2023"/>`, ...MONTHS.map(m => `<s v="${m}"/>`), `<s v="&gt;4/5/2023"/>`].join('');
  const cache = { key: 'source', scope: 'main', sourceSheetId: wb.sheets[0].id, sourceRef: 'A1:C4',
    xml: `<pivotCacheDefinition xmlns="${M}" recordCount="3"><cacheSource type="worksheet"><worksheetSource sheet="Log" ref="A1:C4"/></cacheSource><cacheFields count="4">`
      + `<cacheField name="Date" numFmtId="14"><sharedItems containsSemiMixedTypes="0" containsNonDate="0" containsDate="1" containsString="0" count="3">${dates.map(d => `<d v="${d}T00:00:00"/>`).join('')}</sharedItems><fieldGroup par="3"/></cacheField>`
      + `<cacheField name="Category"><sharedItems count="2"><s v="Fun"/>${food}</sharedItems></cacheField><cacheField name="Amount"><sharedItems containsNumber="1"/></cacheField>`
      + `<cacheField name="Months (Date)" numFmtId="0" databaseField="0"><fieldGroup base="0"><rangePr groupBy="months" startDate="2023-03-02T00:00:00" endDate="2023-04-05T00:00:00"/><groupItems count="14">${groupItems}</groupItems></fieldGroup></cacheField></cacheFields>`
      + `<extLst><ext uri="{725AE2AE-9491-48be-B2B4-4EB974FC3084}"><x:pivotCacheDefinition xmlns:x="${X14}" pivotCacheId="2"/></ext></extLst></pivotCacheDefinition>`,
    records: `<pivotCacheRecords xmlns="${M}" count="3"><r><x v="0"/><x v="0"/><n v="10"/></r><r><x v="1"/><x v="1"/><n v="5"/></r><r><x v="2"/><x v="1"/><n v="7"/></r></pivotCacheRecords>` };
  const items = Array.from({ length: 14 }, (_, i) => `<item x="${i}"/>`).join('');
  const report = { name: 'Monthly', owner: wb.sheets[1].id, cache: cache.key, ref: 'B3:C6',
    xml: `<pivotTableDefinition xmlns="${M}" name="Monthly" cacheId="0" dataCaption="Values" createdVersion="6"><location ref="B3:C6" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>`
      + `<pivotFields count="4"><pivotField showAll="0"/><pivotField showAll="0"><items count="3"><item x="0"/><item x="1"/><item t="default"/></items></pivotField><pivotField dataField="1" showAll="0"/>`
      + `<pivotField axis="axisRow" showAll="0"><items count="15">${items}<item t="default"/></items></pivotField></pivotFields>`
      + `<rowFields count="1"><field x="3"/></rowFields><rowItems count="3"><i><x v="3"/></i><i><x v="4"/></i><i t="grand"><x/></i></rowItems>`
      + `<colItems count="1"><i/></colItems><dataFields count="1"><dataField name="Sum of Amount" fld="2"/></dataFields></pivotTableDefinition>` };
  wb.nativePivots = { version: 1, caches: [cache], tables: [report], dxfs: [], styles: [], formats: {}, connections: '' };
  return wb;
}

const slicerCache = (name, source, members) => `<x:slicerCacheDefinition xmlns:x="${X14}" name="${name}" sourceName="${source}"><x:pivotTables><x:pivotTable tabId="2" name="Monthly"/></x:pivotTables>`
  + `<x:data><x:tabular pivotCacheId="2"><x:items count="${members.length}">${members.map(x => `<x:i x="${x}" s="1"/>`).join('')}</x:items></x:tabular></x:data></x:slicerCacheDefinition>`;
const frame = (name, id, row) => `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
  + `<xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 8}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><mc:AlternateContent xmlns:mc="${MC}" xmlns:a14="${A14}"><mc:Choice Requires="a14">`
  + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${name}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
  + `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${SLE}"><sle:slicer xmlns:sle="${SLE}" name="${name}"/></a:graphicData></a:graphic></xdr:graphicFrame></mc:Choice>`
  + `<mc:Fallback><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="0" name=""/><xdr:cNvSpPr><a:spLocks noTextEdit="1"/></xdr:cNvSpPr></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1524000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:sp></mc:Fallback></mc:AlternateContent><xdr:clientData/></xdr:twoCellAnchor>`;
const get = (zip, path) => new TextDecoder().decode(X.CFB.find(zip, path)?.content || new Uint8Array());
const set = (zip, path, text) => X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(text));

/** The workbook as Excel saves it, with a Months slicer and a Category slicer beside the report. */
async function excelFile(options) {
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(fixture(options))).arrayBuffer()), { type: 'array' });
  set(zip, '/xl/workbook.xml', get(zip, '/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')
    .replace('</extLst>', `<ext uri="{BBE1A952-AA13-448E-AADC-164F8A28A991}"><x:slicerCaches xmlns:x="${X14}" xmlns:r="${R}"><x:slicerCache r:id="sMonths"/><x:slicerCache r:id="sCategory"/></x:slicerCaches></ext></extLst>`));
  set(zip, '/xl/_rels/workbook.xml.rels', get(zip, '/xl/_rels/workbook.xml.rels').replace('</Relationships>',
    `<Relationship Id="sMonths" Type="${S}/slicerCache" Target="slicerCaches/months.xml"/><Relationship Id="sCategory" Type="${S}/slicerCache" Target="slicerCaches/category.xml"/></Relationships>`));
  set(zip, '/xl/slicerCaches/months.xml', slicerCache('Slicer_Months', 'Months (Date)', [3, 4, 1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 0, 13]));
  set(zip, '/xl/slicerCaches/category.xml', slicerCache('Slicer_Category', 'Category', [1, 0]));
  set(zip, '/xl/slicers/slicer1.xml', `<slicers xmlns="${X14}"><slicer name="Months" cache="Slicer_Months" caption="Months" rowHeight="241300"/><slicer name="Category" cache="Slicer_Category" caption="Category" rowHeight="241300"/></slicers>`);
  set(zip, '/xl/drawings/slicers.xml', `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}">${frame('Months', 2, 1)}${frame('Category', 3, 10)}</xdr:wsDr>`);
  const sheet = '/xl/worksheets/sheet2.xml', rels = '/xl/worksheets/_rels/sheet2.xml.rels';
  const extra = `<Relationship Id="rSlicers" Type="${S}/slicer" Target="../slicers/slicer1.xml"/><Relationship Id="rDrawing" Type="${R}/drawing" Target="../drawings/slicers.xml"/>`;
  set(zip, rels, get(zip, rels) ? get(zip, rels).replace('</Relationships>', `${extra}</Relationships>`) : `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${extra}</Relationships>`);
  expect(get(zip, sheet)).not.toMatch(/<drawing\b|<extLst>/);
  set(zip, sheet, get(zip, sheet).replace('</worksheet>', `<drawing xmlns:r="${R}" r:id="rDrawing"/><extLst><ext uri="{A8765BA9-456A-4dab-B4F3-ACF838C121DE}"><x14:slicerList xmlns:x14="${X14}" xmlns:r="${R}"><x14:slicer r:id="rSlicers"/></x14:slicerList></ext></extLst></worksheet>`));
  set(zip, '/[Content_Types].xml', get(zip, '/[Content_Types].xml').replace('</Types>', ['months', 'category'].map(n => `<Override PartName="/xl/slicerCaches/${n}.xml" ContentType="application/vnd.ms-excel.slicerCache+xml"/>`).join('')
    + '<Override PartName="/xl/slicers/slicer1.xml" ContentType="application/vnd.ms-excel.slicer+xml"/><Override PartName="/xl/drawings/slicers.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'));
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

it('opens a workbook with a slicer it cannot model, leaving out only that slicer', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const wb = await workbookFromFile(await excelFile());
    const report = wb.sheetByName('Report');
    expect(Array.from({ length: 4 }, (_, r) => [wb.getValue(report.id, r + 2, 1), wb.getValue(report.id, r + 2, 2)]))
      .toEqual([['Row Labels', 'Sum of Amount'], ['Mar', 15], ['Apr', 7], ['Grand Total', 22]]);
    expect(wb.getValue(wb.sheetByName('Log').id, 3, 2)).toBe(7);
    const slicers = report.charts.filter(c => c.type === 'slicer');
    expect(slicers.map(c => c.nativeName)).toEqual(['Category']);
    expect(slicerItems(wb, slicers[0]).map(i => i.value)).toEqual(['Food', 'Fun']);
    expect(wb.nativePivots.slicers.map(s => s.name)).toEqual(['Slicer_Category']);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/Slicer Months is not shown/);
    // It saves, and opens again with what it kept.
    const back = await workbookFromFile(await workbookToXlsx(wb));
    expect(back.sheetByName('Report').charts.filter(c => c.type === 'slicer').map(c => c.nativeName)).toEqual(['Category']);
    expect(back.getValue(back.sheetByName('Report').id, 3, 2)).toBe(15);
  } finally { warn.mockRestore(); }
});

it('opens a workbook with a slicer whose members it cannot list, leaving out only that slicer', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    // A Category member saved as a date that is no date: the slicer cannot show it.
    const wb = await workbookFromFile(await excelFile({ food: '<d v="soon"/>' }));
    const report = wb.sheetByName('Report');
    expect(report.charts.filter(c => c.type === 'slicer')).toEqual([]);
    expect(wb.getValue(report.id, 3, 2)).toBe(15);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/Slicer Category is not shown: .*date member is invalid/);
    const back = await workbookFromFile(await workbookToXlsx(wb));
    expect(back.getValue(back.sheetByName('Report').id, 3, 2)).toBe(15);
  } finally { warn.mockRestore(); }
});
