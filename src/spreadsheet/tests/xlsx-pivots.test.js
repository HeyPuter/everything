import { decodeXlsxString } from '../src/core/xlsx-string.js';
import { commitNativePivotReports } from '../src/core/native-pivot-commit.js';
import { materializeNativePivotReport } from '../src/core/native-pivot-materialize.js';
import { nativePivotPaintLayers, nativePivotPaintAt, nativePivotCellNumberFormat } from '../src/core/native-pivot-paint.js';
import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook, MAX_ROWS } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { normalizeNativePivots } from '../src/core/native-pivots.js';
import { writeNativePivotAxes } from '../src/core/native-pivot-axis-xml.js';
import { rebuildNativePivotAxis } from '../src/core/native-pivot-axis.js';
import { readNativePivotLayout } from '../src/core/native-pivot-layout.js';
import { readNativePivotConditionalFormats, nativePivotConditionalRanges } from '../src/core/native-pivot-condformat.js';
import { planNativePivotReport } from '../src/core/native-pivot-report.js';
import { nativePivotRowLabels } from '../src/core/native-pivot-row-labels.js';
import { calculateNativePivotValues } from '../src/core/native-pivot-values.js';
import { NativePivotQuery } from '../src/core/native-pivot-query.js';
import { resolveNativePivotSlicers } from '../src/core/native-pivot-slicer.js';
import { readNativePivotCache } from '../src/core/native-pivot-cache.js';
import { readXlsxPivots } from '../src/core/xlsx-pivots.js';
import { parseModelXml } from '../src/core/data-model-metadata.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const X15 = 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main';
const xml = (name, body = '', attrs = '') => `<${name} xmlns="${MAIN}" xmlns:r="${REL}" ${attrs}>${body}</${name}>`;
const descendants = (text, name) => Array.from(parseModelXml(text).getElementsByTagNameNS(MAIN, name));
function fixture() {
  const wb = new Workbook({ sheets: [{ name: 'Input', cells: { '0,0': { v: 'Sales' }, '1,0': { v: 17 } } }, { name: 'Report' }] });
  const cache = xml('pivotCacheDefinition', '<cacheSource type="worksheet"><worksheetSource sheet="Input" ref="A1:A2"/></cacheSource><cacheFields count="1"><cacheField name="Sales" numFmtId="190"><sharedItems count="1"><n v="17"/></sharedItems></cacheField></cacheFields>', 'r:id="oldRecords" recordCount="1"');
  const definition = (name, cacheId) => xml('pivotTableDefinition', '<location ref="B3:C4" firstHeaderRow="0" firstDataRow="1" firstDataCol="1"/><pivotFields count="1"><pivotField dataField="1"/></pivotFields><dataFields count="1"><dataField name="Total" fld="0" numFmtId="190"/></dataFields><formats count="1"><format dxfId="0"><pivotArea/></format></formats><pivotTableStyleInfo name="Custom pivot"/>', `name="${name}" cacheId="${cacheId}" dataCaption="Values"`);
  wb.nativePivots = { version: 1,
    caches: [{ key: 'shared', scope: 'main', sourceSheetId: wb.sheets[0].id, xml: cache, records: xml('pivotCacheRecords', '<r><n v="17"/></r>', 'count="1"') },
      { key: 'chart-only', scope: 'x15', xml: xml('pivotCacheDefinition', '<cacheSource type="external" connectionId="7"/><cacheFields count="1"><cacheField name="Sales"/></cacheFields><extLst><ext uri="{ABF5C744-AB39-4b91-8756-CFA1BBC848D5}"><x15:pivotCacheIdVersion xmlns:x15="' + X15 + '" cacheIdSupportedVersion="6" cacheIdCreatedVersion="6"/></ext></extLst>'), records: '' }],
    tables: [{ name: 'Summary', cache: 'shared', owner: wb.sheets[1].id, xml: definition('Summary', 77) },
      { name: 'ChartSummary', cache: 'chart-only', owner: null, xml: definition('ChartSummary', 88) }],
    formats: { 190: '0.000" units"' }, dxfs: [xml('dxf', '<font><b/><color rgb="FF123456"/></font><numFmt numFmtId="215" formatCode="0.00%"/>')],
    styles: [{ name: 'Custom pivot', xml: xml('tableStyle', '<tableStyleElement type="wholeTable" dxfId="0"/>', 'name="Custom pivot" table="0" count="1"') }], connections: xml('connections', '<connection id="7" name="External cube" type="5"><dbPr connection="Provider=MSOLAP;Data Source=example.invalid" command="Cube" commandType="1"/></connection>'),
  };
  wb.sheets[1].charts = [{ id: 'pivot-chart', type: 'column', anchor: { r: 6, c: 1 }, range: { r1: 0, c1: 0, r2: 1, c2: 0 },
    w: 400, h: 300, pivotSource: { name: '[Source.xlsx]ChartSummary', standalone: true, formatId: 4 },
    sourceRefs: [{ name: 'Total', literal: { categories: ['Sales'], values: [17] } }] }];
  return wb;
}
async function nativeRoundTrip(wb) {
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const get = path => new TextDecoder().decode(X.CFB.find(zip, path)?.content || new Uint8Array());
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  part.content = new TextEncoder().encode(get('/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')); part.size = part.content.length;
  return { get, wb: await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' })) };
}
it('keeps worksheet and non-worksheet pivots, cache records and chart bindings through native-only round trips', async () => {
  let wb = fixture();
  for (let pass = 0; pass < 2; pass++) {
    wb.setInput(wb.sheets[0].id, 1, 0, String(29 + pass));
    const result = await nativeRoundTrip(wb); wb = result.wb;
    expect(wb.nativePivots.caches).toHaveLength(2);
    expect(wb.nativePivots.tables.map(p => [p.name, p.owner])).toEqual([['Summary', wb.sheets[1].id], ['ChartSummary', null]]);
    expect(wb.nativePivots.caches.map(c => c.scope)).toEqual(['main', 'x15']);
    expect(wb.nativePivots.caches[0].records).toContain('v="17"'); // Editing a source does not implicitly refresh a cache.
    expect(wb.getValue(wb.sheets[0].id, 1, 0)).toBe(29 + pass);
    expect(wb.sheets[1].charts[0].pivotSource).toEqual({ name: '[Source.xlsx]ChartSummary', standalone: true, formatId: 4 });
    expect(result.get('/xl/worksheets/sheet2.xml')).not.toContain('pivotTableParts');
    expect(result.get('/xl/worksheets/_rels/sheet2.xml.rels')).toContain(`${REL}/pivotTable`);
    expect(result.get('/xl/pivotTables/_rels/pivotTable1.xml.rels')).toContain(`${REL}/pivotCacheDefinition`);
    const cacheFormat = descendants(wb.nativePivots.caches[0].xml, 'cacheField')[0].getAttribute('numFmtId');
    expect(wb.nativePivots.formats[cacheFormat]).toBe('0.000" units"');
    const pivot = wb.nativePivots.tables[0];
    const dxfId = Number(descendants(pivot.xml, 'format')[0].getAttribute('dxfId'));
    expect(wb.nativePivots.dxfs[dxfId]).toContain('FF123456');
    expect(descendants(wb.nativePivots.dxfs[dxfId], 'numFmt')[0].getAttribute('formatCode')).toBe('0.00%');
    const styleName = descendants(pivot.xml, 'pivotTableStyleInfo')[0].getAttribute('name');
    expect(wb.nativePivots.styles.find(s => s.name === styleName)?.xml).toContain(`dxfId="${dxfId}"`);
  }
});
it('serializes independent pivot descriptors and keeps owners through report renames', async () => {
  const wb = fixture(), json = wb.toJSON(), copy = new Workbook(json);
  copy.nativePivots.tables[0].name = 'Changed';
  expect(wb.nativePivots.tables[0].name).toBe('Summary');
  wb.renameSheet(wb.sheets[1].id, 'New report');
  wb.renameSheet(wb.sheets[0].id, 'New input');
  const result = await nativeRoundTrip(wb);
  expect(descendants(result.wb.nativePivots.caches[0].xml, 'worksheetSource')[0].getAttribute('sheet')).toBe('New input');
  expect(result.wb.sheetByName('New report').id).toBe(result.wb.nativePivots.tables[0].owner);
  wb.replaceWith({ sheets: [{ name: 'Empty' }] }); expect(wb.nativePivots).toBeNull();
  expect(normalizeNativePivots({ ...json.nativePivots, caches: [] })).toBeNull();
  expect(normalizeNativePivots({ ...json.nativePivots, dxfs: {} })).toBeNull();
});
it('follows relocated OPC relationships and rejects missing or inconsistent local caches', () => {
  const wb = fixture(), f = wb.nativePivots, content = s => ({ content: new TextEncoder().encode(s) });
  const relations = body => `<Relationships xmlns="${PACKAGE}">${body}</Relationships>`;
  const relationship = (id, type, target, extra = '') => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}" ${extra}/>`;
  const book = { Directory: { workbooks: ['/docs/book.xml'] }, files: {
    'docs/book.xml': content(xml('workbook', '<sheets><sheet name="Report" sheetId="9" r:id="sheet"/></sheets><pivotCaches><pivotCache cacheId="77" r:id="cache"/></pivotCaches>')),
    'docs/_rels/book.xml.rels': content(relations(relationship('sheet', 'worksheet', '../pages/report.xml') + relationship('cache', 'pivotCacheDefinition', '../data/cache.xml'))),
    'pages/_rels/report.xml.rels': content(relations(relationship('pivot', 'pivotTable', '../data/pivot.xml'))),
    'data/cache.xml': content(f.caches[0].xml.replace(' r:id="oldRecords"', '')),
    'data/pivot.xml': content(f.tables[0].xml),
    'data/_rels/pivot.xml.rels': content(relations(relationship('cache', 'pivotCacheDefinition', './cache.xml'))),
  } };
  expect(readXlsxPivots(book, wb).tables[0]).toMatchObject({ name: 'Summary', cache: 'data/cache.xml', owner: wb.sheets[1].id });
  book.files['data/_rels/pivot.xml.rels'] = content(relations(relationship('cache', 'pivotCacheDefinition', './wrong.xml')));
  expect(() => readXlsxPivots(book, wb)).toThrow(/Inconsistent/);
  delete book.files['data/cache.xml'];
  expect(() => readXlsxPivots(book, wb)).toThrow(/Missing native pivot cache/);
});
it('keeps a standard worksheet PivotChart connection and a cache shared by multiple reports', async () => {
  const wb = fixture(), pivots = wb.nativePivots;
  pivots.tables.push({ ...pivots.tables[0], name: 'Second summary', owner: wb.sheets[0].id });
  wb.sheets[1].charts[0].pivotSource = { name: '[Source.xlsx]Report!Summary', formatId: 0, standalone: false };
  const result = await nativeRoundTrip(wb);
  expect(result.wb.nativePivots.tables.filter(p => p.cache === result.wb.nativePivots.caches[0].key)).toHaveLength(2);
  expect(result.wb.sheets[1].charts[0].pivotSource).toEqual(wb.sheets[1].charts[0].pivotSource);
  wb.deleteSheet(wb.sheets[1].id);
  const deleted = await nativeRoundTrip(wb);
  expect(deleted.wb.nativePivots.tables.map(p => p.name)).toEqual(['Second summary', 'ChartSummary']);
  wb.undo();
  const restored = await nativeRoundTrip(wb);
  expect(restored.wb.nativePivots.tables).toHaveLength(3);
});
it('moves native source and report ranges through row/column edits, undo and native export', async () => {
  let { wb } = await nativeRoundTrip(fixture());
  const source = wb.sheets[0].id, report = wb.sheets[1].id;
  const state = () => [wb.nativePivots.caches[0].sourceRef, wb.nativePivots.tables.find(p => p.owner === report)?.ref];
  expect(state()).toEqual(['A1:A2', 'B3:C4']);
  wb.transaction('Move both', () => { wb.insertRows(source, 0, 3); wb.insertCols(source, 0, 2); wb.insertRows(report, 0, 4); wb.insertCols(report, 0, 3); });
  expect(state()).toEqual(['C4:C5', 'E7:F8']);
  wb.undo(); expect(state()).toEqual(['A1:A2', 'B3:C4']);
  wb.redo(); expect(state()).toEqual(['C4:C5', 'E7:F8']);
  wb = (await nativeRoundTrip(wb)).wb;
  expect(wb.nativePivots.caches[0].sourceRef).toBe('C4:C5');
  expect(wb.nativePivots.tables.find(p => p.owner)?.ref).toBe('E7:F8');
  const owner = wb.sheets[1].id;
  expect(wb.deleteLines(owner, 'row', [{ from: 0, to: 1 }, { from: 3, to: 4 }])).toBe(true);
  expect(wb.nativePivots.tables.find(p => p.owner)?.ref).toBe('E3:F4');
  wb.undo(); expect(wb.nativePivots.tables.find(p => p.owner)?.ref).toBe('E7:F8');
});
it('rejects partial report line edits and allows whole-report removal with undo', async () => {
  const { wb } = await nativeRoundTrip(fixture()), owner = wb.sheets[1].id;
  const before = wb.toJSON();
  expect(wb.insertRows(owner, 3)).toBe(false);
  expect(wb.insertCols(owner, 2)).toBe(false);
  expect(wb.deleteLines(owner, 'row', [{ from: 3, to: 3 }])).toBe(false);
  expect(wb.deleteLines(owner, 'col', [{ from: 1, to: 1 }])).toBe(false);
  expect(wb.toJSON()).toEqual(before);
  expect(wb.deleteLines(owner, 'row', [{ from: 2, to: 3 }])).toBe(true);
  expect(wb.nativePivots.tables.map(p => p.name)).toEqual(['ChartSummary']);
  const exported = await nativeRoundTrip(wb);
  expect(exported.wb.nativePivots.tables.map(p => p.name)).toEqual(['ChartSummary']);
  wb.undo(); expect(wb.nativePivots.tables).toHaveLength(2);
  wb.redo(); expect(wb.nativePivots.tables).toHaveLength(1);
});
it('expands a worksheet source inside its range and preserves a deleted-source error', async () => {
  const { wb } = await nativeRoundTrip(fixture()), source = wb.sheets[0].id;
  wb.insertRows(source, 1, 5);
  expect(wb.nativePivots.caches[0].sourceRef).toBe('A1:A7');
  wb.deleteLines(source, 'row', [{ from: 1, to: 2 }, { from: 4, to: 4 }]);
  expect(wb.nativePivots.caches[0].sourceRef).toBe('A1:A4');
  wb.deleteLines(source, 'row', [{ from: 0, to: 3 }]);
  expect(wb.nativePivots.caches[0].sourceRef).toBe('#REF!');
  expect((await nativeRoundTrip(wb)).wb.nativePivots.caches[0].sourceRef).toBe('#REF!');
  wb.undo(); expect(wb.nativePivots.caches[0].sourceRef).toBe('A1:A4');
});
it('refuses report overflow and emits a specific edit reason without changing history', async () => {
  const { wb } = await nativeRoundTrip(fixture()), owner = wb.sheets[1].id;
  const pivot = wb.nativePivots.tables.find(p => p.owner === owner);
  pivot.ref = 'XFC1048575:XFD1048576';
  const events = []; wb.addEventListener('change', e => { if (e.detail.type === 'pivot-edit') events.push(e.detail); });
  const before = wb.toJSON();
  expect(wb.insertRows(owner, 0)).toBe(false);
  expect(wb.insertCols(owner, 0)).toBe(false);
  expect(events.map(e => e.reason)).toEqual(['bounds', 'bounds']);
  expect(wb.toJSON()).toEqual(before);
});
it('removes a report when every worksheet row is deleted, restoring it through undo', async () => {
  const { wb } = await nativeRoundTrip(fixture()), owner = wb.sheets[1].id;
  expect(wb.deleteLines(owner, 'row', [{ from: 0, to: wb.sheet(owner).rows - 1 }])).toBe(true);
  expect(wb.nativePivots.tables.some(p => p.owner === owner)).toBe(false);
  wb.undo(); expect(wb.nativePivots.tables.find(p => p.owner === owner)?.ref).toBe('B3:C4');
});
it.each([
  ['down', { r1: 0, c1: 1, r2: 1, c2: 2 }, 'B5:C6'],
  ['right', { r1: 2, c1: 0, r2: 3, c2: 0 }, 'C3:D4'],
])('moves an entire native report through a %s cell shift and native export', async (direction, block, expected) => {
  let { wb } = await nativeRoundTrip(fixture()); const owner = wb.sheets[1].id;
  expect(wb.insertCells(owner, block, direction)).toBe(true);
  expect(wb.nativePivots.tables.find(p => p.owner === owner)?.ref).toBe(expected);
  wb.undo(); expect(wb.nativePivots.tables.find(p => p.owner === owner)?.ref).toBe('B3:C4');
  wb.redo(); expect(wb.nativePivots.tables.find(p => p.owner === owner)?.ref).toBe(expected);
  wb = (await nativeRoundTrip(wb)).wb;
  expect(wb.nativePivots.tables.find(p => p.owner)?.ref).toBe(expected);
  expect(wb.deleteCells(wb.sheets[1].id, block, direction === 'down' ? 'up' : 'left')).toBe(true);
  expect(wb.nativePivots.tables.find(p => p.owner)?.ref).toBe('B3:C4');
});
it.each([
  ['down', { r1: 0, c1: 1, r2: 0, c2: 1 }],
  ['right', { r1: 2, c1: 0, r2: 2, c2: 0 }],
  ['down', { r1: 3, c1: 1, r2: 3, c2: 2 }],
  ['right', { r1: 2, c1: 2, r2: 3, c2: 2 }],
])('refuses insertion/deletion of %s bands that split a report', async (direction, block) => {
  const { wb } = await nativeRoundTrip(fixture()), owner = wb.sheets[1].id, before = wb.toJSON();
  const events = []; wb.addEventListener('change', e => { if (e.detail.type === 'pivot-edit') events.push(e.detail.reason); });
  expect(wb.insertCells(owner, block, direction)).toBe(false);
  expect(wb.deleteCells(owner, block, direction === 'down' ? 'up' : 'left')).toBe(false);
  expect(events).toEqual(['partial', 'partial']);
  expect(wb.toJSON()).toEqual(before);
});
it('updates only worksheet source ranges fully inside the shifted band', async () => {
  const { wb } = await nativeRoundTrip(fixture()), source = wb.sheets[0].id;
  expect(wb.insertCells(source, { r1: 0, c1: 0, r2: 1, c2: 0 }, 'down')).toBe(true);
  expect(wb.nativePivots.caches[0].sourceRef).toBe('A3:A4');
  expect(wb.insertCells(source, { r1: 0, c1: 1, r2: 1, c2: 1 }, 'down')).toBe(true);
  expect(wb.nativePivots.caches[0].sourceRef).toBe('A3:A4');
  expect(wb.deleteCells(source, { r1: 2, c1: 0, r2: 3, c2: 0 }, 'up')).toBe(true);
  expect(wb.nativePivots.caches[0].sourceRef).toBe('#REF!');
  wb.undo(); expect(wb.nativePivots.caches[0].sourceRef).toBe('A3:A4');
});
it('allows a block to remove a whole report and preserves unrelated reports', async () => {
  const { wb } = await nativeRoundTrip(fixture()), owner = wb.sheets[1].id;
  expect(wb.deleteCells(owner, { r1: 1, c1: 0, r2: 4, c2: 3 }, 'up')).toBe(true);
  expect(wb.nativePivots.tables.map(p => p.name)).toEqual(['ChartSummary']);
  expect((await nativeRoundTrip(wb)).wb.nativePivots.tables.map(p => p.name)).toEqual(['ChartSummary']);
  wb.undo(); expect(wb.nativePivots.tables.find(p => p.owner === owner)?.ref).toBe('B3:C4');
});
it('allows shifts entirely beside or after a report and rejects block overflow', async () => {
  const { wb } = await nativeRoundTrip(fixture()), owner = wb.sheets[1].id;
  expect(wb.insertCells(owner, { r1: 0, c1: 4, r2: 0, c2: 4 }, 'down')).toBe(true);
  expect(wb.insertCells(owner, { r1: 4, c1: 1, r2: 4, c2: 2 }, 'down')).toBe(true);
  expect(wb.nativePivots.tables.find(p => p.owner === owner)?.ref).toBe('B3:C4');
  wb.nativePivots.tables.find(p => p.owner === owner).ref = 'B1048575:C1048576';
  expect(wb.insertCells(owner, { r1: 0, c1: 1, r2: 0, c2: 2 }, 'down')).toBe(false);
});

it('recovers range metadata from early version-1 drafts before structural edits', async () => {
  const original = fixture(), json = original.toJSON();
  for (const p of json.nativePivots.tables) delete p.ref;
  for (const c of json.nativePivots.caches) delete c.sourceRef;
  const wb = new Workbook(json), report = wb.sheets[1].id, source = wb.sheets[0].id;
  expect(wb.nativePivots.tables[0].ref).toBe('B3:C4');
  expect(wb.nativePivots.caches[0].sourceRef).toBe('A1:A2');
  expect(wb.insertRows(report, 3, 1)).toBe(false); // Partial report edit still refused.
  wb.insertRows(report, 0, 3); wb.insertCols(report, 0, 2); wb.insertRows(source, 0, 2);
  const out = await nativeRoundTrip(wb);
  expect(descendants(out.wb.nativePivots.tables[0].xml, 'location')[0].getAttribute('ref')).toBe('D6:E7');
  expect(descendants(out.wb.nativePivots.caches[0].xml, 'worksheetSource')[0].getAttribute('ref')).toBe('A3:A4');
  wb.undo(); wb.undo(); wb.undo();
  expect(wb.nativePivots.tables[0].ref).toBe('B3:C4');
  expect(wb.nativePivots.caches[0].sourceRef).toBe('A1:A2');
});
it('recovers only namespace-qualified direct native ranges and preserves edited references', () => {
  const original = fixture(), json = original.toJSON();
  const pivot = json.nativePivots.tables[0]; delete pivot.ref;
  pivot.xml = `<p:pivotTableDefinition xmlns:p="${MAIN}" xmlns:other="urn:other"><!-- <location ref="Z9"/> -->
    <other:location ref="Z8"/><p:extLst><p:location ref="Z7"/></p:extLst><p:location ref="&#68;9:F12"/></p:pivotTableDefinition>`;
  expect(new Workbook(json).nativePivots.tables[0].ref).toBe('D9:F12');
  pivot.ref = 'H20:J23'; json.nativePivots.caches[0].sourceRef = '#REF!';
  const wb = new Workbook(json);
  expect(wb.nativePivots.tables[0].ref).toBe('H20:J23');
  expect(wb.nativePivots.caches[0].sourceRef).toBe('#REF!');
  delete pivot.ref;
  pivot.xml = pivot.xml.replace('</p:pivotTableDefinition>', '<p:location ref="A1"/></p:pivotTableDefinition>');
  expect(normalizeNativePivots(json.nativePivots)).toBeNull();
});

it('moves a whole native report and its cache-source references with undo and native export', async () => {
  const wb = new Workbook(fixture().toJSON()), id = wb.sheets[1].id;
  wb.setInput(id, 2, 1, 'Total'); wb.setInput(id, 3, 2, '17');
  const src = { r1: 2, c1: 1, r2: 3, c2: 2 };
  expect(wb.moveRange(id, src, 5, 4)).toEqual({ r1: 5, c1: 4, r2: 6, c2: 5 });
  expect(wb.nativePivots.tables[0].ref).toBe('E6:F7');
  expect(wb.getValue(id, 6, 5)).toBe(17);
  expect((await nativeRoundTrip(wb)).wb.nativePivots.tables[0].ref).toBe('E6:F7');
  wb.undo(); expect(wb.nativePivots.tables[0].ref).toBe('B3:C4'); expect(wb.getValue(id, 3, 2)).toBe(17);
  wb.redo(); expect(wb.nativePivots.tables[0].ref).toBe('E6:F7');
  wb.moveRange(wb.sheets[0].id, { r1: 0, c1: 0, r2: 1, c2: 0 }, 4, 2);
  expect(wb.nativePivots.caches[0].sourceRef).toBe('C5:C6');
  wb.undo(); expect(wb.nativePivots.caches[0].sourceRef).toBe('A1:A2');
});
it('refuses partial report moves and destination collisions before changing cells or history', () => {
  const wb = new Workbook(fixture().toJSON()), id = wb.sheets[1].id;
  const before = JSON.stringify(wb.toJSON()), events = [];
  wb.addEventListener('change', e => { if (e.detail.type === 'pivot-edit') events.push(e.detail.reason); });
  expect(wb.moveRange(id, { r1: 2, c1: 1, r2: 2, c2: 2 }, 8, 8)).toBeNull();
  expect(wb.moveRange(id, { r1: 8, c1: 8, r2: 10, c2: 10 }, 1, 0)).toBeNull();
  expect(JSON.stringify(wb.toJSON())).toBe(before);
  expect(events).toEqual(['move-partial', 'overlap']);
});
it('carries report ownership and chart binding through a cross-sheet cut and undo', async () => {
  const wb = new Workbook(fixture().toJSON()), source = wb.sheets[1].id, target = wb.sheets[0].id;
  wb.sheets[1].charts[0].pivotSource = { name: '[Source.xlsx]Report!Summary', standalone: false, formatId: 4 };
  wb.setInput(source, 2, 1, 'Total'); wb.setInput(source, 3, 2, '17');
  const range = { r1: 2, c1: 1, r2: 3, c2: 2 }, cells = wb.copyCells(source, [2, 3], [1, 2]);
  expect(wb.placeMoved(target, 6, 4, cells, { sheetId: source, range })).toBeTruthy();
  expect(wb.nativePivots.tables[0]).toMatchObject({ owner: target, ref: 'E7:F8' });
  expect(wb.sheets[1].charts[0].pivotSource.name).toBe('[Source.xlsx]Input!Summary');
  const out = await nativeRoundTrip(wb);
  expect(out.wb.nativePivots.tables.find(p => p.name === 'Summary')).toMatchObject({ owner: out.wb.sheets[0].id, ref: 'E7:F8' });
  wb.undo(); expect(wb.nativePivots.tables[0]).toMatchObject({ owner: source, ref: 'B3:C4' });
  expect(wb.sheets[1].charts[0].pivotSource.name).toBe('[Source.xlsx]Report!Summary');
  expect(wb.getValue(source, 3, 2)).toBe(17);
  wb.redo(); expect(wb.nativePivots.tables[0].owner).toBe(target);
});

it('handles overlapping report moves and refuses truncated cuts, duplicate names and table collisions', () => {
  const wb = new Workbook(fixture().toJSON()), source = wb.sheets[1].id, target = wb.sheets[0].id;
  const range = { r1: 2, c1: 1, r2: 3, c2: 2 }, cells = wb.copyCells(source, [2, 3], [1, 2]);
  expect(wb.moveRange(source, range, 3, 2)).toBeTruthy();
  expect(wb.nativePivots.tables[0].ref).toBe('C4:D5'); wb.undo();
  expect(wb.placeMoved(target, 5, 5, [cells[0]], { sheetId: source, range })).toBeNull();
  wb.nativePivots.tables.push({ ...wb.nativePivots.tables[0], owner: target, ref: 'M20:N21' });
  expect(wb.placeMoved(target, 5, 5, cells, { sheetId: source, range })).toBeNull();
  wb.nativePivots.tables.pop();
  wb.sheets[0].tables.push({ id: 't', name: 'Data', range: { r1: 5, c1: 5, r2: 7, c2: 7 } });
  expect(wb.placeMoved(target, 5, 5, cells, { sheetId: source, range })).toBeNull();
  expect(wb.nativePivots.tables[0].ref).toBe('B3:C4');
});
it('keeps quoted PivotChart qualifiers and explicit cache-source ownership during cross-sheet moves', async () => {
  const wb = new Workbook(fixture().toJSON()), source = wb.sheets[1].id, target = wb.sheets[0].id;
  wb.renameSheet(target, "New report's tab");
  wb.sheets[1].charts[0].pivotSource = { name: "'[Source.xlsx]Report'!Summary", standalone: false, formatId: 4 };
  const range = { r1: 2, c1: 1, r2: 3, c2: 2 };
  wb.placeMoved(target, 5, 5, wb.copyCells(source, [2, 3], [1, 2]), { sheetId: source, range });
  expect(wb.sheets[1].charts[0].pivotSource.name).toBe("'[Source.xlsx]New report''s tab'!Summary");
  const data = { r1: 0, c1: 0, r2: 1, c2: 0 };
  wb.placeMoved(source, 8, 8, wb.copyCells(target, [0, 1], [0]), { sheetId: target, range: data });
  expect(wb.nativePivots.caches[0]).toMatchObject({ sourceSheetId: source, sourceRef: 'I9:I10' });
  const out = await nativeRoundTrip(wb);
  expect(descendants(out.wb.nativePivots.caches[0].xml, 'worksheetSource')[0].getAttribute('sheet')).toBe('Report');
  wb.undo(); expect(wb.nativePivots.caches[0].sourceSheetId).toBe(target);
});

it('clears an entire report with undo while keeping shared caches and chart-only reports', async () => {
  const wb = new Workbook(fixture().toJSON()), id = wb.sheets[1].id;
  wb.setInput(id, 2, 1, 'Total'); wb.setInput(id, 3, 2, '17');
  const range = { r1: 2, c1: 1, r2: 3, c2: 2 }, cache = wb.nativePivots.caches[0];
  wb.clearRange(id, range);
  expect(wb.nativePivots.tables.map(p => p.name)).toEqual(['ChartSummary']);
  expect(wb.nativePivots.caches[0]).toBe(cache);
  expect(wb.getValue(id, 3, 2)).toBeNull();
  expect((await nativeRoundTrip(wb)).wb.nativePivots.tables.map(p => p.name)).toEqual(['ChartSummary']);
  wb.undo(); expect(wb.nativePivots.tables[0].name).toBe('Summary'); expect(wb.getValue(id, 3, 2)).toBe(17);
  wb.redo(); expect(wb.nativePivots.tables).toHaveLength(1);
});
it('refuses partial or filtered report clears atomically but permits format-only clears', () => {
  const wb = new Workbook(fixture().toJSON()), id = wb.sheets[1].id, events = [];
  wb.setInput(id, 3, 2, '17'); wb.setInput(id, 8, 0, 'outside');
  const before = JSON.stringify(wb.toJSON());
  wb.addEventListener('change', e => { if (e.detail.type === 'pivot-edit') events.push(e.detail.reason); });
  wb.clearRange(id, { r1: 3, c1: 0, r2: 8, c2: 2 });
  wb.clearRange(id, { r1: 2, c1: 1, r2: 3, c2: 2 }, { skipRow: r => r === 2 });
  expect(JSON.stringify(wb.toJSON())).toBe(before); expect(events).toEqual(['clear-partial', 'clear-partial']);
  wb.clearRange(id, { r1: 2, c1: 1, r2: 3, c2: 2 }, { skipRow: () => true });
  expect(JSON.stringify(wb.toJSON())).toBe(before);
  wb.clearRange(id, { r1: 3, c1: 2, r2: 3, c2: 2 }, { contents: false, styles: true });
  expect(wb.nativePivots.tables).toHaveLength(2); expect(wb.getValue(id, 3, 2)).toBe(17);
});
it('does not remove pivot metadata when a protected cell refuses the clear', () => {
  const wb = new Workbook(fixture().toJSON()), id = wb.sheets[1].id;
  wb.sheets[1].protectedRanges.push({ range: { r1: 7, c1: 1, r2: 7, c2: 1 } });
  const before = wb.nativePivots;
  wb.clearRange(id, { r1: 2, c1: 1, r2: 8, c2: 2 });
  expect(wb.nativePivots).toBe(before);
});
it('freezes a dependent PivotChart as native literal series before deleting its report', async () => {
  const { chartData } = await import('../src/core/charts.js');
  const wb = new Workbook(fixture().toJSON()), sheet = wb.sheets[1], id = sheet.id;
  for (const [r, c, text] of [[2, 1, 'Item'], [2, 2, 'Revenue'], [3, 1, 'Sales'], [3, 2, '17']]) wb.setInput(id, r, c, text);
  sheet.charts[0] = { ...sheet.charts[0], titleRef: 'Report!C3', pivotSource: { name: "'[Source.xlsx]Report'!Summary", standalone: false, formatId: 4 },
    sourceRefs: [{ nameRef: 'Report!C3', categories: 'Report!B4', values: 'Report!C4', valueFormat: '0.00' }] };
  wb.clearRange(id, { r1: 2, c1: 1, r2: 3, c2: 2 }, { contents: true, styles: true });
  expect(sheet.charts[0].pivotSource).toBeUndefined(); expect(sheet.charts[0].title).toBe('Revenue'); expect(sheet.charts[0].titleRef).toBeUndefined();
  expect(chartData(wb, id, sheet.charts[0]).series[0]).toMatchObject({ name: 'Revenue', categories: ['Sales'], values: [17] });
  const out = await nativeRoundTrip(wb), saved = out.wb.sheets[1].charts[0];
  expect(saved.pivotSource).toBeUndefined(); expect(saved.sourceRefs[0].literal.values).toEqual([17]);
  wb.undo(); expect(sheet.charts[0].pivotSource.name).toBe("'[Source.xlsx]Report'!Summary"); expect(wb.getValue(id, 3, 2)).toBe(17);
});

it('keeps numeric date-axis coordinates and number formats when a dependent chart becomes static', async () => {
  const { chartData } = await import('../src/core/charts.js');
  const wb = new Workbook(fixture().toJSON()), sheet = wb.sheets[1], id = sheet.id;
  wb.setInput(id, 3, 1, '2024-01-01'); wb.setInput(id, 3, 2, '12.5');
  sheet.charts[0] = { ...sheet.charts[0], appearance: { dateAxis: true }, pivotSource: { name: '[Book.xlsx]Report!Summary', standalone: false },
    sourceRefs: [{ name: 'Amount', categories: 'Report!B4', values: 'Report!C4', categoryFormat: 'mmm-yy', valueFormat: '$0.00' }] };
  const before = chartData(wb, id, sheet.charts[0]);
  wb.clearRange(id, { r1: 2, c1: 1, r2: 3, c2: 2 });
  const after = chartData(wb, id, sheet.charts[0]);
  expect(after.series[0].values).toEqual(before.series[0].values);
  expect(after.series[0].style).toEqual(before.series[0].style);
  expect(after.series[0].categories).toEqual(['Jan-24']); // Literal numeric categories use their declared chart format.
  expect(after.x).toEqual(before.x); expect(after.xStyle).toEqual(before.xStyle);
  const out = await nativeRoundTrip(wb), reopened = chartData(out.wb, out.wb.sheets[1].id, out.wb.sheets[1].charts[0]);
  expect(reopened.series[0].values).toEqual([12.5]); expect(reopened.x).toEqual(before.x);
});

function reportWithDependentChart() {
  const wb = new Workbook(fixture().toJSON()), report = wb.sheets[1], dashboard = wb.sheets[0];
  wb.setInput(report.id, 2, 1, 'Item'); wb.setInput(report.id, 2, 2, 'Revenue');
  wb.setInput(report.id, 3, 1, 'Sales'); wb.setInput(report.id, 3, 2, '17');
  dashboard.charts = [{ ...report.charts[0], titleRef: 'Report!C3', pivotSource: { name: '[Book.xlsx]Report!Summary', standalone: false, formatId: 4 },
    sourceRefs: [{ nameRef: 'Report!C3', categories: 'Report!B4', values: 'Report!C4', valueFormat: '0.00' }] }];
  dashboard.protected = true;
  return new Workbook(wb.toJSON());
}
it.each(['rows', 'columns', 'cells-up', 'cells-left', 'sheet'])('detaches dependent charts before deleting the report via %s, with one undo step', async route => {
  const wb = reportWithDependentChart(), report = wb.sheets[1].id, dashboard = wb.sheets[0].id;
  if (route === 'rows') wb.deleteLines(report, 'row', [{ from: 2, to: 3 }]);
  else if (route === 'columns') wb.deleteLines(report, 'col', [{ from: 1, to: 2 }]);
  else if (route === 'sheet') wb.deleteSheet(report);
  else wb.deleteCells(report, { r1: 2, c1: 1, r2: 3, c2: 2 }, route === 'cells-up' ? 'up' : 'left');
  expect(wb.undoLabels()).toHaveLength(1);
  const chart = wb.sheet(dashboard).charts[0];
  expect(chart.pivotSource).toBeUndefined(); expect(chart.sourceRefs[0].literal.values).toEqual([17]);
  expect(chart.title).toBe('Revenue'); expect(wb.nativePivots.tables.some(p => p.name === 'Summary')).toBe(false);
  const out = await nativeRoundTrip(wb);
  expect(out.wb.sheets[0].charts[0].sourceRefs[0].literal.values).toEqual([17]);
  expect(out.wb.sheets[0].charts[0].pivotSource).toBeUndefined();
  wb.undo(); expect(wb.sheet(report)).toBeTruthy(); expect(wb.sheet(dashboard).charts[0].pivotSource.name).toBe('[Book.xlsx]Report!Summary');
  expect(wb.getValue(report, 3, 2)).toBe(17); expect(wb.nativePivots.tables.some(p => p.name === 'Summary')).toBe(true);
  expect(wb.canUndo()).toBe(false); expect(wb.sheet(dashboard).protected).toBe(true);
  wb.redo(); expect(wb.sheet(dashboard).charts[0].sourceRefs[0].literal.values).toEqual([17]);
});
it('updates dependent charts on protected sheets for source clears and moves', () => {
  const wb = reportWithDependentChart(), report = wb.sheets[1].id, dashboard = wb.sheets[0].id;
  wb.clearRange(report, { r1: 2, c1: 1, r2: 3, c2: 2 });
  expect(wb.sheet(dashboard).charts[0].pivotSource).toBeUndefined();
  wb.undo(); const target = wb.addSheet('Moved report');
  const targetId = typeof target === 'string' ? target : target.id;
  const range = { r1: 2, c1: 1, r2: 3, c2: 2 };
  wb.placeMoved(targetId, 3, 3, wb.copyCells(report, [2, 3], [1, 2]), { sheetId: report, range });
  expect(wb.sheet(dashboard).charts[0].pivotSource.name).toBe('[Book.xlsx]Moved report!Summary');
  wb.undo(); expect(wb.sheet(dashboard).charts[0].pivotSource.name).toBe('[Book.xlsx]Report!Summary');
});
it('invalidates an explicit cache source when its worksheet is deleted, and restores it on undo', async () => {
  const wb = new Workbook(fixture().toJSON()), id = wb.sheets[0].id;
  wb.deleteSheet(id);
  expect(wb.nativePivots.caches[0]).toMatchObject({ sourceSheetId: null, sourceRef: '#REF!' });
  const out = await nativeRoundTrip(wb);
  expect(out.wb.nativePivots.caches[0].sourceRef).toBe('#REF!');
  wb.undo(); expect(wb.nativePivots.caches[0]).toMatchObject({ sourceSheetId: id, sourceRef: 'A1:A2' });
});

it.each(['[Book.xlsx]report!summary', "'[Book.xlsx]REPORT'!SUMMARY"] )('keeps %s linked through a worksheet rename, deletion and undo', async name => {
  const wb = reportWithDependentChart(), report = wb.sheets[1].id, dashboard = wb.sheets[0].id;
  wb.sheet(dashboard).charts[0].pivotSource.name = name;
  expect(wb.renameSheet(report, "Team's report!")).toBe(true);
  const renamed = wb.sheet(dashboard).charts[0].pivotSource.name;
  expect(renamed).toBe(name.startsWith("'") ? "'[Book.xlsx]Team''s report!'!SUMMARY" : "[Book.xlsx]Team's report!!summary");
  const out = await nativeRoundTrip(wb);
  expect(out.wb.sheets[0].charts[0].pivotSource.name).toBe(renamed);
  expect(out.wb.nativePivots.tables.find(p => p.name === 'Summary').owner).toBe(out.wb.sheets[1].id);
  wb.clearRange(report, { r1: 2, c1: 1, r2: 3, c2: 2 });
  expect(wb.sheet(dashboard).charts[0].pivotSource).toBeUndefined();
  wb.undo(); expect(wb.sheet(dashboard).charts[0].pivotSource.name).toBe(renamed);
  wb.undo(); expect(wb.sheet(dashboard).charts[0].pivotSource.name).toBe(name);
  wb.redo(); expect(wb.sheet(dashboard).charts[0].pivotSource.name).toBe(renamed);
});
it('matches composed identities without rewriting unrelated or standalone PivotCharts', async () => {
  const { pivotChartQualifier, renamePivotChartSheet } = await import('../src/core/native-pivots.js');
  const report = { name: 'Résumé' }, chart = { pivotSource: { name: "'[Book! 1.xlsx]Cafe\u0301'!RE\u0301SUME\u0301", standalone: false, formatId: 7 } };
  expect(pivotChartQualifier(chart.pivotSource.name, 'Café', report.name)).toMatchObject({ prefix: '[Book! 1.xlsx]', quoted: true });
  const renamed = renamePivotChartSheet(chart, [report], 'Café', 'New tab');
  expect(renamed.pivotSource.name).toBe("'[Book! 1.xlsx]New tab'!RE\u0301SUME\u0301");
  expect(renamed.pivotSource.formatId).toBe(7);
  expect(renamePivotChartSheet(chart, [{ name: 'Other' }], 'Café', 'New')).toBe(chart);
  expect(renamePivotChartSheet(chart, [report], 'Other Café', 'New')).toBe(chart);
  const standalone = { pivotSource: { name: chart.pivotSource.name, standalone: true } };
  expect(renamePivotChartSheet(standalone, [report], 'Café', 'New')).toBe(standalone);
  expect(pivotChartQualifier('[Book.xlsxReport!Summary', 'Report', 'Summary')).toBeNull();
  expect(pivotChartQualifier('[Book! 1.xlsx]X!Y!Sales!Total', 'X!Y', 'Sales!Total')).toMatchObject({ prefix: '[Book! 1.xlsx]', suffix: '!Sales!Total' });
});

it('duplicates worksheet reports with distinct names and shared caches through native export and undo', async () => {
  const wb = new Workbook(fixture().toJSON()), source = wb.sheets[1].id, caches = wb.nativePivots.caches;
  wb.nativePivots.tables[0].xml = wb.nativePivots.tables[0].xml.replace('<pivotTableDefinition ', '<pivotTableDefinition xmlns:q="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" q:uid="{00000000-0000-0000-0000-000000000001}" ');
  const copy = wb.duplicateSheet(source), pivot = wb.nativePivots.tables.find(p => p.owner === copy.id);
  expect(pivot).toMatchObject({ name: 'Summary_2', cache: 'shared', ref: 'B3:C4' });
  expect(wb.nativePivots.caches).toBe(caches);
  const root = parseModelXml(pivot.xml), revision = 'http://schemas.microsoft.com/office/spreadsheetml/2014/revision';
  expect(root.getAttribute('name')).toBe(pivot.name);
  expect(root.getAttributeNS(revision, 'uid')).toMatch(/^\{[A-F0-9-]{36}\}$/);
  expect(root.getAttributeNS(revision, 'uid')).not.toBe('{00000000-0000-0000-0000-000000000001}');
  const out = await nativeRoundTrip(wb);
  expect(out.wb.nativePivots.tables.find(p => p.name === 'Summary_2').owner).toBe(out.wb.sheetByName(copy.name).id);
  expect(out.wb.nativePivots.caches).toHaveLength(2);
  wb.undo(); expect(wb.sheet(copy.id)).toBeUndefined(); expect(wb.nativePivots.tables).toHaveLength(2);
  wb.redo(); expect(wb.nativePivots.tables.find(p => p.owner === copy.id).name).toBe('Summary_2');
  const next = wb.duplicateSheet(source); expect(wb.nativePivots.tables.find(p => p.owner === next.id).name).toBe('Summary_3');
});
it('links copied worksheet PivotCharts to copied reports without changing the originals', async () => {
  const wb = new Workbook(fixture().toJSON()), source = wb.sheets[1];
  source.charts[0].pivotSource = { name: "'[Book.xlsx]REPORT'!summary", standalone: false, formatId: 9 };
  const copy = wb.duplicateSheet(source.id);
  expect(copy.charts[0].pivotSource).toEqual({ name: "'[Book.xlsx]Report (2)'!Summary_2", standalone: false, formatId: 9 });
  expect(source.charts[0].pivotSource.name).toBe("'[Book.xlsx]REPORT'!summary");
  const out = await nativeRoundTrip(wb);
  expect(out.wb.sheetByName(copy.name).charts[0].pivotSource.name).toBe(copy.charts[0].pivotSource.name);
  wb.clearRange(copy.id, { r1: 2, c1: 1, r2: 3, c2: 2 });
  expect(wb.nativePivots.tables.some(p => p.owner === source.id)).toBe(true);
  expect(source.charts[0].pivotSource).toBeTruthy(); expect(wb.sheet(copy.id).charts[0].pivotSource).toBeUndefined();
});
it('duplicates a chart-only layout once for multiple copied charts, retaining its shared cache', async () => {
  const wb = new Workbook(fixture().toJSON()), source = wb.sheets[1];
  source.charts.push({ ...source.charts[0], id: 'second', pivotSource: { ...source.charts[0].pivotSource } });
  const copy = wb.duplicateSheet(source.id);
  const standalone = wb.nativePivots.tables.filter(p => p.owner == null);
  expect(standalone.map(p => p.name)).toEqual(['ChartSummary', 'ChartSummary_2']);
  expect(standalone[1].cache).toBe(standalone[0].cache);
  expect(copy.charts.map(c => c.pivotSource.name)).toEqual(['[Source.xlsx]ChartSummary_2', '[Source.xlsx]ChartSummary_2']);
  expect(source.charts[0].pivotSource.name).toBe('[Source.xlsx]ChartSummary');
  const out = await nativeRoundTrip(wb);
  expect(out.wb.nativePivots.tables.filter(p => p.owner == null)).toHaveLength(2);
  expect(out.wb.sheetByName(copy.name).charts[0].pivotSource.name).toBe('[Source.xlsx]ChartSummary_2');
});
it('keeps a copied chart linked to a report on another worksheet', () => {
  const wb = reportWithDependentChart(), source = wb.sheets[0];
  const copy = wb.duplicateSheet(source.id);
  expect(copy.charts[0].pivotSource.name).toBe(source.charts[0].pivotSource.name);
  expect(wb.nativePivots.tables).toHaveLength(2);
});

it('refuses over-limit report duplication before installing a sheet or changing history', () => {
  const wb = new Workbook(fixture().toJSON()), source = wb.sheets[1].id, pivot = wb.nativePivots.tables[0];
  wb.nativePivots.tables = Array.from({ length: 65536 }, (_, i) => ({ ...pivot, name: `Report${i}` }));
  const before = wb.nativePivots, names = [...wb.names], sheets = wb.sheets.length;
  expect(() => wb.duplicateSheet(source)).toThrow(/count limit/);
  expect(wb.nativePivots).toBe(before); expect(wb.sheets).toHaveLength(sheets); expect(wb.names).toEqual(names); expect(wb.canUndo()).toBe(false);
});

function copiedReport(wb) {
  const id = wb.sheets[1].id;
  wb.sheet(id).cells.set('2,1', { v: 'Total' }); wb.sheet(id).cells.set('3,2', { v: 17 });
  return { cells: wb.copyRange(id, { r1: 2, c1: 1, r2: 3, c2: 2 }), nativePivots: wb.copyNativePivots(id, [2, 3], [1, 2]) };
}
it('pastes a complete report with copied values, shared cache, native export and one undo step', async () => {
  const wb = new Workbook(fixture().toJSON()), { cells, nativePivots } = copiedReport(wb), id = wb.sheets[0].id, before = wb.nativePivots;
  wb.pasteCells(id, cells, 5, 4, { r: 2, c: 1 }, null, { nativePivots });
  expect(wb.getValue(id, 6, 5)).toBe(17);
  expect(wb.nativePivots.tables.at(-1)).toMatchObject({ owner: id, name: 'Summary_2', ref: 'E6:F7', cache: 'shared' });
  expect(wb.nativePivots.caches).toBe(before.caches);
  const out = await nativeRoundTrip(wb), p = out.wb.nativePivots.tables.find(p => p.name === 'Summary_2');
  expect(p.ref).toBe('E6:F7'); expect(p.owner).toBe(out.wb.sheets[0].id); expect(out.wb.nativePivots.caches).toHaveLength(2);
  expect(descendants(p.xml, 'location')[0].getAttribute('ref')).toBe('E6:F7');
  wb.undo(); expect(wb.nativePivots).toBe(before); expect(wb.getValue(id, 6, 5)).toBeNull(); expect(wb.canUndo()).toBe(false);
  wb.redo(); expect(wb.getValue(id, 6, 5)).toBe(17); expect(wb.nativePivots.tables.at(-1).name).toBe('Summary_2');
});
it('tiles report copies with independent names and honors the copy-time layout after source deletion', () => {
  const wb = new Workbook(fixture().toJSON()), { cells, nativePivots } = copiedReport(wb), id = wb.sheets[0].id;
  wb.deleteSheet(wb.sheets[1].id);
  wb.pasteCells(id, cells, 5, 4, { r: 2, c: 1 }, { r1: 5, c1: 4, r2: 8, c2: 7 }, { nativePivots });
  expect(wb.nativePivots.tables.filter(p => p.owner === id).map(p => [p.name, p.ref])).toEqual([
    ['Summary_2', 'E6:F7'], ['Summary_3', 'G6:H7'], ['Summary_4', 'E8:F9'], ['Summary_5', 'G8:H9'],
  ]);
});
it('copies partial or discontiguous report selections as ordinary cells', () => {
  const wb = new Workbook(fixture().toJSON()), id = wb.sheets[1].id;
  expect(wb.copyNativePivots(id, [2], [1, 2])).toBeNull();
  expect(wb.copyNativePivots(id, [2, 4], [1, 2])).toBeNull();
  expect(wb.copyNativePivots(id, [2, 3], [2])).toBeNull();
  expect(wb.copyNativePivots(id, [2, 3, 9], [1, 2, 7]).tables[0].range).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 });
});
it.each(['protection', 'merge', 'pivot', 'bounds', 'cache', 'table'])('refuses report paste atomically for %s conflicts', kind => {
  const wb = new Workbook(fixture().toJSON()), { cells, nativePivots } = copiedReport(wb), id = wb.sheets[0].id, sheet = wb.sheet(id);
  let r = 5, c = 4;
  if (kind === 'protection') sheet.protectedRanges.push({ id: 'locked', range: { r1: 6, c1: 5, r2: 6, c2: 5 } });
  if (kind === 'merge') sheet.merges.push({ r1: 5, c1: 4, r2: 6, c2: 5 });
  if (kind === 'pivot') wb.nativePivots.tables.push({ ...wb.nativePivots.tables[0], owner: id, ref: 'F7:G8' });
  if (kind === 'bounds') r = Math.max(sheet.rows, MAX_ROWS) - 1;
  if (kind === 'cache') wb.nativePivots.caches = wb.nativePivots.caches.map(cache => ({ ...cache, records: '' }));
  if (kind === 'table') sheet.tables.push({ id: 'table', name: 'Table', range: { r1: 5, c1: 4, r2: 8, c2: 6 } });
  const before = wb.nativePivots, oldCells = [...sheet.cells];
  expect(wb.pasteCells(id, cells, r, c, { r: 2, c: 1 }, null, { nativePivots, checkOnly: true })).toBe(false);
  wb.pasteCells(id, cells, r, c, { r: 2, c: 1 }, null, { nativePivots });
  expect(wb.nativePivots).toBe(before); expect([...sheet.cells]).toEqual(oldCells); expect(wb.canUndo()).toBe(false);
});
it('keeps copied merge geometry and does not attach a report on a values-only paste', () => {
  const wb = new Workbook(fixture().toJSON()), { cells, nativePivots } = copiedReport(wb), id = wb.sheets[0].id;
  wb.pasteCells(id, cells, 5, 4, { r: 2, c: 1 }, null, { nativePivots, merges: [{ r1: 0, c1: 0, r2: 0, c2: 1 }] });
  expect(wb.sheet(id).merges).toEqual([{ r1: 5, c1: 4, r2: 5, c2: 5 }]);
  expect(wb.nativePivots.tables).toHaveLength(3);
  wb.pasteLiteralValues(id, [['Total', null], [null, 17]], 10, 4);
  expect(wb.nativePivots.tables).toHaveLength(3); expect(wb.getValue(id, 11, 5)).toBe(17);
});

it('refuses worksheet-table creation over a native report before changing headers or history', () => {
  const wb = new Workbook(fixture().toJSON()), id = wb.sheets[1].id, before = wb.toJSON();
  expect(wb.addTable(id, { r1: 2, c1: 1, r2: 3, c2: 2 })).toBeNull();
  expect(wb.toJSON()).toEqual(before); expect(wb.canUndo()).toBe(false);
});
it.each(['resize', 'extend', 'typed'])('keeps a native report out of worksheet-table %s', mode => {
  const wb = new Workbook(fixture().toJSON()), id = wb.sheets[1].id;
  const table = wb.addTable(id, { r1: 0, c1: 0, r2: 1, c2: 2 });
  wb.setInput(id, 1, 1, '=A2*2'); wb.clearHistory();
  const native = wb.nativePivots, before = wb.toJSON();
  if (mode === 'resize') expect(wb.resizeTable(id, table, { r1: 0, c1: 0, r2: 3, c2: 2 })).toBe(false);
  if (mode === 'extend') expect(wb.extendTableToCover(id, { r1: 2, c1: 0, r2: 4, c2: 0 })).toBe(false);
  if (mode === 'typed') wb.setInput(id, 2, 0, '7'); // Outside the report; calculated columns must not fill into it.
  expect(wb.tableById(id, table).range.r2).toBe(1); expect(wb.getValue(id, 2, 1)).toBeNull(); expect(wb.nativePivots).toBe(native);
  if (mode === 'typed') { expect(wb.getValue(id, 2, 0)).toBe(7); wb.undo(); }
  expect(wb.toJSON()).toEqual(before); expect(wb.canUndo()).toBe(false);
});
it.each(['totals', 'row', 'create-with-totals'])('makes room for %s above a native report even when its cached cells are empty', async mode => {
  const wb = new Workbook(fixture().toJSON()), id = wb.sheets[1].id;
  const area = { r1: 0, c1: 1, r2: 1, c2: 2 };
  const table = mode === 'create-with-totals' ? null : wb.addTable(id, area);
  wb.clearHistory(); const before = wb.toJSON();
  if (mode === 'totals') wb.setTableTotals(id, table, true);
  if (mode === 'row') expect(wb.addTableRow(id, table)).toBe(2);
  if (mode === 'create-with-totals') expect(wb.addTable(id, area, { totalsRow: true })).toBeTruthy();
  expect(wb.nativePivots.tables.find(p => p.owner === id).ref).toBe('B4:C5');
  const out = await nativeRoundTrip(wb); expect(out.wb.nativePivots.tables.find(p => p.owner === out.wb.sheets[1].id).ref).toBe('B4:C5');
  expect(wb.undoLabels()).toHaveLength(1); wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo();
  expect(wb.nativePivots.tables.find(p => p.owner === id).ref).toBe('B4:C5');
});
it.each(['create', 'update', 'totals', 'row'].flatMap(mode => [[mode, false], [mode, true]]))('refuses %s atomically when making room would split another report (ordinary content: %s)', (mode, ordinary) => {
  const wb = new Workbook(fixture().toJSON()), id = wb.sheets[1].id, area = { r1: 0, c1: 1, r2: 1, c2: 2 };
  wb.nativePivots.tables.push({ ...wb.nativePivots.tables[0], name: 'Crossing', ref: 'F2:G4' });
  if (ordinary) { wb.nativePivots.tables = wb.nativePivots.tables.filter(p => p.name !== 'Summary'); wb.setNote(id, 2, 1, 'Reserved'); }
  const table = mode === 'create' ? null : wb.addTable(id, area, { name: 'Original' });
  wb.clearHistory(); const before = wb.toJSON();
  if (mode === 'create') expect(wb.addTable(id, area, { totalsRow: true })).toBeNull();
  if (mode === 'update') expect(wb.updateTable(id, table, { name: 'Renamed', style: 'green', totalsRow: true })).toBe(false);
  if (mode === 'totals') wb.setTableTotals(id, table, true);
  if (mode === 'row') expect(wb.addTableRow(id, table)).toBe(-1);
  expect(wb.toJSON()).toEqual(before); expect(wb.canUndo()).toBe(false);
});
it('allows adjacent table growth and ignores native report rectangles owned by other sheets or charts', () => {
  const wb = new Workbook(fixture().toJSON()), id = wb.sheets[1].id;
  const table = wb.addTable(id, { r1: 0, c1: 0, r2: 1, c2: 0 });
  expect(wb.resizeTable(id, table, { r1: 0, c1: 0, r2: 4, c2: 0 })).toBe(true);
  expect(wb.addTable(wb.sheets[0].id, { r1: 2, c1: 1, r2: 3, c2: 2 })).toBeTruthy();
  expect(wb.nativePivots.tables[0].ref).toBe('B3:C4');
});

it('preserves decoded cache records and slicer identity through native-only export after source edits', async () => {
  let wb = fixture();
  const cache = wb.nativePivots.caches[0];
  cache.xml = cache.xml.replace('</pivotCacheDefinition>', '<extLst><ext><x14:pivotCacheDefinition xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" pivotCacheId="31"/></ext></extLst></pivotCacheDefinition>');
  cache.xml = cache.xml.replace('name="Sales"', 'name="Sales_x000A_region"');
  const decoded = () => {
    const data = readNativePivotCache(wb.nativePivots.caches[0]);
    return { ...data, fields: data.fields.map(({ numFmtId, ...field }) => ({ ...field, numberFormat: wb.nativePivots.formats[numFmtId] })) };
  };
  const expected = decoded();
  for (let pass = 0; pass < 2; pass++) {
    wb.setInput(wb.sheets[0].id, 1, 0, String(40 + pass));
    wb = (await nativeRoundTrip(wb)).wb;
    expect(decoded()).toEqual(expected);
    expect(new NativePivotQuery(readNativePivotCache(wb.nativePivots.caches[0])).aggregate(0)).toEqual({ value: 17, records: 1 });
    const slicer = { pivotCacheId: 31, sourceName: 'Sales\nregion', items: [{ index: 0, selected: true }],
      pivotTables: [{ tabId: 17, name: 'Summary' }] };
    const binding = resolveNativePivotSlicers([slicer], wb.nativePivots,
      [{ id: wb.sheets[1].id, tabId: 17, name: wb.sheets[1].name }]).get(slicer);
    expect(binding).toMatchObject({ cacheKey: wb.nativePivots.caches[0].key, field: { index: 0 }, reports: [{ name: 'Summary', sheet: 'Report' }] });
    expect(wb.getValue(wb.sheets[0].id, 1, 0)).toBe(40 + pass);
  }
});

it('retains the field settings needed to rebuild axes through native-only round trips', async () => {
  let wb = fixture();
  wb.nativePivots.tables[0].xml = wb.nativePivots.tables[0].xml
    .replace('<pivotField dataField="1"/>', '<pivotField axis="axisRow" showAll="0" compact="0" outline="0" defaultSubtotal="0"><items count="1"><item x="0"/></items></pivotField>')
    .replace('<dataFields ', '<rowFields count="1"><field x="0"/></rowFields><dataFields ');
  const axis = book => rebuildNativePivotAxis(readNativePivotLayout(book.nativePivots.tables[0], book.nativePivots.caches[0]),
    new NativePivotQuery(readNativePivotCache(book.nativePivots.caches[0])), 'rows');
  const expected = axis(wb);
  const initialLayout = readNativePivotLayout(wb.nativePivots.tables[0], wb.nativePivots.caches[0]);
  wb.nativePivots.tables[0] = writeNativePivotAxes(wb.nativePivots.tables[0], { ...initialLayout, rows: expected });
  expect(expected.items.map(row => [row.type, ...row.members.map(member => member.value)])).toEqual([['data', 17], ['grand']]);
  const expectedPlan = planNativePivotReport(wb.nativePivots.tables[0], wb.nativePivots.caches[0]).cells;
  for (let pass = 0; pass < 2; pass++) {
    wb = (await nativeRoundTrip(wb)).wb;
    expect(axis(wb)).toEqual(expected);
    expect(planNativePivotReport(wb.nativePivots.tables[0], wb.nativePivots.caches[0]).cells).toEqual(expectedPlan);
    const styled = planNativePivotReport(wb.nativePivots.tables[0], wb.nativePivots.caches[0], { nativePivots: wb.nativePivots });
    expect(styled.styleLayers).toHaveLength(1);
    expect(styled.styleLayers[0]).toMatchObject({ type: 'wholeTable', range: { r1: 2, c1: 1, r2: 4, c2: 2 } });
    expect(descendants(styled.styleLayers[0].dxf, 'b')).toHaveLength(1);
    expect(descendants(styled.styleLayers[0].dxf, 'numFmt')[0].getAttribute('formatCode')).toBe('0.00%');
    const paint = nativePivotPaintAt(nativePivotPaintLayers(styled.styleLayers), 3, 2);
    expect(paint).toMatchObject({ bold: true, color: '#123456', fmt: 'custom', code: '0.00%' });
    const layout = readNativePivotLayout(wb.nativePivots.tables[0], wb.nativePivots.caches[0]);
    expect(nativePivotCellNumberFormat(layout, { role: 'value', measure: 0 }, wb.nativePivots.formats)).toEqual({ fmt: 'custom', code: '0.000\" units\"' });
    expect(nativePivotRowLabels(layout).map(c => [c.value, c.type])).toEqual([[17, 'number'], ['Grand Total', 'string']]);
    expect(calculateNativePivotValues(layout, new NativePivotQuery(readNativePivotCache(wb.nativePivots.caches[0]))).map(c => c.value)).toEqual([17, 17]);
    expect(readNativePivotLayout(wb.nativePivots.tables[0], wb.nativePivots.caches[0]).rows).toEqual(expected);
  }
});


it('retains pivot conditional-area bindings through native-only export and moved report axes', async () => {
  let wb = fixture();
  wb.nativePivots.tables[0].xml = wb.nativePivots.tables[0].xml.replace('<pivotTableStyleInfo',
    '<conditionalFormats count="1"><conditionalFormat scope="data" priority="1"><pivotAreas count="1"><pivotArea><references count="1"><reference field="4294967294" count="1" selected="0"><x v="0"/></reference></references></pivotArea></pivotAreas></conditionalFormat></conditionalFormats><pivotTableStyleInfo');
  wb.sheets[1].rules = [{ id: 'negative', type: 'formula', value: 'C4<0', range: { r1: 3, c1: 2, r2: 3, c2: 2 }, style: { color: '#ff0000' } }];
  for (let pass = 0; pass < 2; pass++) {
    wb = (await nativeRoundTrip(wb)).wb;
    const p = wb.nativePivots.tables[0], c = wb.nativePivots.caches.find(c => c.key === p.cache);
    const bindings = readNativePivotConditionalFormats(p);
    expect(bindings).toHaveLength(1); expect(bindings[0]).toMatchObject({ priority: 1, scope: 'data' });
    expect(nativePivotConditionalRanges(readNativePivotLayout(p, c), bindings)).toEqual([{ priority: 1, ranges: [{ r1: 3, c1: 2, r2: 3, c2: 2 }] }]);
  }
  wb.insertRows(wb.sheets[1].id, 0, 3);
  const p = wb.nativePivots.tables[0], c = wb.nativePivots.caches.find(c => c.key === p.cache);
  expect(nativePivotConditionalRanges(readNativePivotLayout(p, c), readNativePivotConditionalFormats(p))[0].ranges).toEqual([{ r1: 6, c1: 2, r2: 6, c2: 2 }]);
});

async function conditionalFixture() {
  const wb = fixture(), pivot = wb.nativePivots.tables[0];
  pivot.xml = pivot.xml.replace('<pivotTableStyleInfo', '<conditionalFormats count="1"><conditionalFormat scope="data" priority="1"><pivotAreas count="1"><pivotArea><references count="1"><reference field="4294967294" count="1"><x v="0"/></reference></references></pivotArea></pivotAreas></conditionalFormat></conditionalFormats><pivotTableStyleInfo');
  wb.sheets[1].rules = [{ id: 'negative', type: 'formula', value: 'C4<0', pivot: true, range: { r1: 3, c1: 2, r2: 3, c2: 2 }, style: { color: '#ff0000' } }];
  return (await nativeRoundTrip(wb)).wb;
}
it('rebinds native pivot rules after insertion, persistence, native-only and private round trips', async () => {
  let wb = await conditionalFixture();
  const binding = wb.nativePivots.tables[0].conditionalRules[0];
  expect(wb.sheets[1].rules[0]).toMatchObject({ pivot: true, pivotRuleIds: [binding.id] });
  wb.sheets[1].rules.unshift({ id: 'first', type: 'formula', value: 'TRUE', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, style: { bold: true } });
  wb = new Workbook(wb.toJSON());
  for (let pass = 0; pass < 2; pass++) {
    const result = await nativeRoundTrip(wb); wb = result.wb;
    expect(descendants(result.get('/xl/pivotTables/pivotTable1.xml'), 'conditionalFormat')[0].getAttribute('priority')).toBe('2');
    expect(result.get('/xl/worksheets/sheet2.xml')).toContain('pivot="1"');
    expect(wb.sheets[1].rules[1].pivotRuleIds).toEqual([wb.nativePivots.tables[0].conditionalRules[0].id]);
    wb = await workbookFromFile(await (await workbookToXlsx(wb)).arrayBuffer());
    expect(wb.sheets[1].rules[1].pivotRuleIds).toEqual([wb.nativePivots.tables[0].conditionalRules[0].id]);
  }
});
it('removes native pivot format bindings when their worksheet rule is deleted', async () => {
  const wb = await conditionalFixture(); wb.sheets[1].rules = [];
  const result = await nativeRoundTrip(wb);
  expect(descendants(result.get('/xl/pivotTables/pivotTable1.xml'), 'conditionalFormat')).toHaveLength(0);
});
it('gives duplicated reports independent conditional rule identities and priorities', async () => {
  const wb = await conditionalFixture(), source = wb.sheets[1];
  const copy = wb.duplicateSheet(source.id), original = wb.nativePivots.tables[0], clone = wb.nativePivots.tables.find(p => p.owner === copy.id);
  expect(copy.rules[0].pivotRuleIds).toEqual([clone.conditionalRules[0].id]);
  expect(copy.rules[0].pivotRuleIds).not.toEqual(source.rules[0].pivotRuleIds);
  copy.rules.unshift({ id: 'first', type: 'formula', value: 'TRUE', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, style: { bold: true } });
  const result = await nativeRoundTrip(wb);
  expect(descendants(result.get('/xl/pivotTables/pivotTable1.xml'), 'conditionalFormat')[0].getAttribute('priority')).toBe('1');
  expect(descendants(result.get('/xl/pivotTables/pivotTable3.xml'), 'conditionalFormat')[0].getAttribute('priority')).toBe('2');
  expect(original.conditionalRules[0].id).not.toBe(clone.conditionalRules[0].id);
});
it('copies rule bindings with repeated native reports and detaches ordinary cell copies', async () => {
  const wb = await conditionalFixture(), sheet = wb.sheets[1], rows = [2, 3], cols = [1, 2];
  const cells = wb.copyRange(sheet.id, { r1: 2, c1: 1, r2: 3, c2: 2 });
  const conditionalFormats = wb.copyConditionalFormats(sheet.id, rows, cols), nativePivots = wb.copyNativePivots(sheet.id, rows, cols);
  wb.pasteCells(sheet.id, cells, 5, 4, { r: 2, c: 1 }, { r1: 5, c1: 4, r2: 8, c2: 5 }, { conditionalFormats, nativePivots });
  const copies = wb.nativePivots.tables.slice(2);
  expect(copies).toHaveLength(2);
  for (const p of copies) expect(sheet.rules.filter(r => r.pivotRuleIds?.includes(p.conditionalRules[0].id))).toHaveLength(1);
  const result = await nativeRoundTrip(wb);
  expect(descendants(result.get('/xl/pivotTables/pivotTable3.xml'), 'conditionalFormat')[0].getAttribute('priority')).toBe('1');
  expect(descendants(result.get('/xl/pivotTables/pivotTable4.xml'), 'conditionalFormat')[0].getAttribute('priority')).toBe('2');
  wb.undo(); expect(wb.nativePivots.tables).toHaveLength(2); wb.redo(); expect(wb.nativePivots.tables).toHaveLength(4);
  wb.pasteCells(sheet.id, cells, 12, 4, { r: 2, c: 1 }, null, { conditionalFormats });
  expect(sheet.rules.find(r => r.range.r1 === 13)).not.toHaveProperty('pivotRuleIds');
  expect(sheet.rules.find(r => r.range.r1 === 13)).not.toHaveProperty('pivot');
});
it('keeps binding identity when one app data bar expands to several native rules', async () => {
  let wb = await conditionalFixture();
  const previous = wb.sheets[1].rules[0];
  wb.sheets[1].rules[0] = { ...previous, type: 'databar', style: {}, barColor: '#123456', barMin: 0, barMax: 10 };
  for (let pass = 0; pass < 2; pass++) {
    wb = await workbookFromFile(await (await workbookToXlsx(wb)).arrayBuffer());
    expect(wb.sheets[1].rules).toHaveLength(1);
    expect(wb.sheets[1].rules[0]).toMatchObject({ type: 'databar', barMin: 0, barMax: 10 });
    expect(wb.nativePivots.tables[0].conditionalRules).toHaveLength(4);
    expect(wb.sheets[1].rules[0].pivotRuleIds).toHaveLength(4);
  }
});
it('keeps native pivot rule identity after moving the complete report', async () => {
  const wb = await conditionalFixture(), sheet = wb.sheets[1], binding = wb.nativePivots.tables[0].conditionalRules[0];
  expect(wb.moveRange(sheet.id, { r1: 2, c1: 1, r2: 3, c2: 2 }, 7, 5)).toBeTruthy();
  expect(sheet.rules[0].pivotRuleIds).toEqual([binding.id]);
  const result = await nativeRoundTrip(wb);
  expect(result.wb.sheets[1].rules[0].range).toEqual({ r1: 8, c1: 6, r2: 8, c2: 6 });
  expect(descendants(result.get('/xl/pivotTables/pivotTable1.xml'), 'conditionalFormat')[0].getAttribute('priority')).toBe('1');
});

it('exports orphaned pivot rules as ordinary formats when their report was removed', async () => {
  const wb = await conditionalFixture();
  const originalRule = structuredClone(wb.sheets[1].rules[0]);
  wb.nativePivots.tables = wb.nativePivots.tables.filter(p => p.owner !== wb.sheets[1].id);
  const result = await nativeRoundTrip(wb);
  expect(result.get('/xl/worksheets/sheet2.xml')).not.toContain('pivot="1"');
  expect(result.wb.sheets[1].rules[0]).not.toHaveProperty('pivotRuleIds');
  expect(wb.sheets[1].rules[0]).toEqual(originalRule);
  const privateBack = await workbookFromFile(await (await workbookToXlsx(wb)).arrayBuffer());
  expect(privateBack.sheets[1].rules[0]).not.toHaveProperty('pivot');
  expect(privateBack.sheets[1].rules[0]).not.toHaveProperty('pivotRuleIds');
});

it('keeps a planned pivot number format through cell copy and native-only worksheet export', async () => {
  const source = fixture(), layout = readNativePivotLayout(source.nativePivots.tables[0], source.nativePivots.caches[0]);
  const numberFormat = nativePivotCellNumberFormat(layout, { role: 'value', measure: 0 }, source.nativePivots.formats);
  const style = nativePivotPaintAt([], 0, 0, { direct: { fmt: 'percent', bg: '#abcdef' }, numberFormat });
  let wb = new Workbook({ sheets: [{ name: 'Materialized report cell', cells: { '0,0': { v: 17, s: style } } }] });
  const id = wb.sheets[0].id;
  wb.pasteCells(id, wb.copyRange(id, { r1: 0, c1: 0, r2: 0, c2: 0 }), 2, 3);
  expect(wb.getCell(id, 2, 3).s).toMatchObject({ fmt: 'custom', code: '0.000" units"', bg: '#abcdef' });
  for (let pass = 0; pass < 2; pass++) {
    wb = (await nativeRoundTrip(wb)).wb;
    for (const [r, c] of [[0, 0], [2, 3]]) {
      expect(wb.getValue(wb.sheets[0].id, r, c)).toBe(17);
      expect(wb.getCell(wb.sheets[0].id, r, c).s).toMatchObject({ fmt: 'custom', code: '0.000" units"', bg: '#abcdef' });
    }
  }
});

it('exports committed report cells and native definitions together through two native-only round trips', async () => {
  let wb = fixture();
  const cache = wb.nativePivots.caches[0];
  const cells = [
    { r: 2, c: 1, cell: { v: 'Total' } }, { r: 2, c: 2, cell: null },
    { r: 3, c: 1, cell: null }, { r: 3, c: 2, cell: { v: 17, s: { fmt: 'custom', code: '0.000" units"' } } },
  ];
  // The normalizer supplies legacy references from the XML at the boundary.
  wb = new Workbook(wb.toJSON());
  const original = wb.nativePivots.tables[0];
  commitNativePivotReports(wb, [{ pivot: original, cache: wb.nativePivots.caches[0], next: { ...original, xml: original.xml.replace('dataCaption="Values"', 'dataCaption="Amounts"') }, cells }]);
  for (let pass = 0; pass < 2; pass++) {
    wb = (await nativeRoundTrip(wb)).wb;
    expect(wb.nativePivots.tables[0].xml).toContain('dataCaption="Amounts"');
    expect(wb.getValue(wb.sheets[1].id, 3, 2)).toBe(17);
    expect(wb.getCell(wb.sheets[1].id, 3, 2).s).toMatchObject({ fmt: 'custom', code: '0.000" units"' });
    expect(wb.nativePivots.caches[0].records).toBe(cache.records);
  }
});

it.each([
  ['0&quot; _x0041_&quot;', '0" A"'],
  ['0&quot; _x005F_x0041_&quot;', '0" _x0041_"'],
])('decodes native pivot format strings once and rebases differential format codes: %s', async (raw, decoded) => {
  let wb = fixture();
  const literal = '0.000" _x0041_\n"';
  wb.nativePivots.formats[190] = literal;
  wb.nativePivots.dxfs[0] = xml('dxf', `<numFmt numFmtId="215" formatCode="${raw}"/>`);
  for (let pass = 0; pass < 2; pass++) {
    const result = await nativeRoundTrip(wb); wb = result.wb;
    const field = descendants(wb.nativePivots.tables[0].xml, 'dataField')[0];
    expect(wb.nativePivots.formats[field.getAttribute('numFmtId')]).toBe(literal);
    const dxf = descendants(wb.nativePivots.dxfs[0], 'numFmt')[0];
    expect(decodeXlsxString(dxf.getAttribute('formatCode'))).toBe(decoded);
    expect(wb.nativePivots.formats[dxf.getAttribute('numFmtId')]).toBe(decoded);
    const formats = descendants(result.get('/xl/styles.xml'), 'numFmt');
    expect(formats.filter(n => decodeXlsxString(n.getAttribute('formatCode')) === literal)).toHaveLength(1);
  }
});

it('retains committed manual selections through native-only export, copy and clearing', async () => {
  let wb = new Workbook(fixture().toJSON());
  const cache = wb.nativePivots.caches[0];
  cache.xml = cache.xml.replace('recordCount="1"', 'recordCount="2"').replace('<sharedItems count="1"><n v="17"/></sharedItems>', '<sharedItems count="2"><n v="17"/><n v="9"/></sharedItems>');
  cache.records = xml('pivotCacheRecords', '<r><n v="17"/></r><r><n v="9"/></r>', 'count="2"');
  const pivot = wb.nativePivots.tables[0];
  pivot.xml = pivot.xml.replace('<pivotField dataField="1"/>', '<pivotField axis="axisRow" showAll="0"><items count="2"><item x="1"/><item x="0"/></items></pivotField>')
    .replace('dataCaption="Values"', 'dataCaption="Values" preserveFormatting="0"')
    .replace('<dataFields ', '<rowFields count="1"><field x="0"/></rowFields><dataFields ')
    .replace(/<formats\b.*?<\/formats>/, '').replace(/<pivotTableStyleInfo[^>]*\/>/, '');
  const options = book => ({ nativePivots: book.nativePivots, paintContext: { numberFormats: book.nativePivots.formats } });
  const plan = planNativePivotReport(pivot, cache, { ...options(wb), selections: [{ field: 0, items: [1] }] });
  wb.sheets[1].cells.set('3,2', { v: 17, s: { bg: '#ff0000', bold: true, fmt: 'percent' } });
  const cells = materializeNativePivotReport(wb, pivot, plan);
  commitNativePivotReports(wb, [{ pivot, cache, next: plan.pivot, cells }]);
  for (let pass = 0; pass < 2; pass++) {
    wb = (await nativeRoundTrip(wb)).wb;
    const next = planNativePivotReport(wb.nativePivots.tables[0], wb.nativePivots.caches[0], options(wb));
    expect(next.cells).toEqual(plan.cells);
    expect(wb.getValue(wb.sheets[1].id, 3, 2)).toBe(9);
    expect(wb.getValue(wb.sheets[1].id, 4, 2)).toBe(9);
    expect(wb.getCell(wb.sheets[1].id, 3, 2).s).toMatchObject({ fmt: 'custom', code: '0.000" units"' });
    expect(wb.getCell(wb.sheets[1].id, 3, 2).s.bg).not.toBe('#ff0000');
  }
  const source = wb.sheets[1].id, target = wb.sheets[0].id;
  const snapshot = wb.copyNativePivots(source, [2, 3, 4], [1, 2]);
  wb.pasteCells(target, wb.copyRange(source, { r1: 2, c1: 1, r2: 4, c2: 2 }), 5, 4, { r: 2, c: 1 }, null, { nativePivots: snapshot });
  wb = (await nativeRoundTrip(wb)).wb;
  const copy = wb.nativePivots.tables.find(p => p.owner === wb.sheets[0].id);
  expect(planNativePivotReport(copy, wb.nativePivots.caches[0]).cells.filter(c => c.role === 'value').map(c => c.value)).toEqual([9, 9]);
  const cleared = planNativePivotReport(copy, wb.nativePivots.caches[0], { ...options(wb), selections: [{ field: 0, items: null }] });
  expect(cleared.cells.filter(c => c.role === 'value').map(c => c.value)).toEqual([9, 17, 26]);
  const beforeClear = wb.toJSON();
  commitNativePivotReports(wb, [{ pivot: copy, cache: wb.nativePivots.caches[0], next: cleared.pivot, cells: materializeNativePivotReport(wb, copy, cleared) }]);
  expect(wb.getValue(copy.owner, 8, 5)).toBe(26);
  wb.undo(); expect(wb.toJSON()).toEqual(beforeClear);
});

it('retains unused shared-member identities through native-only exports for slicer showMissing visibility', async () => {
  let wb=fixture();
  wb.nativePivots.caches[0].xml=wb.nativePivots.caches[0].xml.replace('<sharedItems count="1"><n v="17"/></sharedItems>','<sharedItems count="2"><n v="17"/><n v="99" u="1"/></sharedItems>');
  for(let pass=0;pass<2;pass++){
    wb=(await nativeRoundTrip(wb)).wb;
    const decoded=readNativePivotCache(wb.nativePivots.caches[0]);
    expect(decoded.fields[0].items.map(i=>i.value)).toEqual([17,99]);
    expect(decoded.fields[0].unused).toEqual([false,true]);
    expect(decoded.records[0][0].value).toBe(17);
  }
});

async function externalWorksheetFixture(target, change = xml => xml) {
  const wb = fixture();
  wb.nativePivots.caches = wb.nativePivots.caches.slice(0, 1);
  wb.nativePivots.tables = wb.nativePivots.tables.slice(0, 1); wb.nativePivots.connections = ''; wb.sheets[1].charts = [];
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const get = path => new TextDecoder().decode(X.CFB.find(zip, path)?.content || new Uint8Array());
  const set = (path, xml) => X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(xml));
  const path = '/xl/pivotCache/pivotCacheDefinition1.xml', rels = '/xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels';
  set(path, get(path).replace('<worksheetSource ', '<worksheetSource r:id="externalWorkbook" '));
  const escaped = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  set(rels, change(get(rels).replace('</Relationships>', `<Relationship Id="externalWorkbook" Type="${REL}/externalLinkPath" Target="${escaped}" TargetMode="External"/></Relationships>`)));
  set('/xl/workbook.xml', get('/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}
it.each(['file:///Users/example/Source%20Data.xlsx', '../Data/日次.xlsx', 'https://example.invalid/data.xlsx?a=1&b=2#book'])('preserves external worksheet targets and independent records relationships: %s', async target => {
  let wb = await workbookFromFile(await externalWorksheetFixture(target));
  expect(wb.nativePivots.caches[0].sourceWorkbook).toBe(target);
  expect(wb.nativePivots.caches[0].sourceSheetId).toBeNull();
  wb = new Workbook(wb.toJSON());
  wb.renameSheet(wb.sheets[0].id, 'Local renamed'); wb.insertRows(wb.sheets[0].id, 0, 2);
  for (let i = 0; i < 2; i++) {
    const result = await nativeRoundTrip(wb); wb = result.wb;
    const cache = wb.nativePivots.caches[0];
    expect(cache.sourceWorkbook).toBe(target); expect(cache.sourceRef).toBe('A1:A2');
    expect(descendants(cache.xml, 'worksheetSource')[0].getAttribute('sheet')).toBe('Input');
    const relationships = Array.from(parseModelXml(result.get('/xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels')).getElementsByTagNameNS('http://schemas.openxmlformats.org/package/2006/relationships', 'Relationship'));
    const external = relationships.find(r => r.getAttribute('Type') === `${REL}/externalLinkPath`);
    const records = relationships.find(r => r.getAttribute('Type') === `${REL}/pivotCacheRecords`);
    expect(external.getAttribute('Target')).toBe(target); expect(external.getAttribute('TargetMode')).toBe('External');
    expect(external.getAttribute('Id')).not.toBe(records.getAttribute('Id'));
    expect(descendants(cache.xml, 'worksheetSource')[0].getAttributeNS(REL, 'id')).toBe(external.getAttribute('Id'));
  }
});
it.each(['missing', 'duplicate', 'internal', 'wrong-type', 'empty'])('rejects an invalid external source relationship: %s', async kind => {
  const bytes = await externalWorksheetFixture('file:///Source.xlsx', xml => {
    const match = xml.match(/<Relationship Id="externalWorkbook"[^>]*\/>/)[0];
    if (kind === 'missing') return xml.replace(match, '');
    if (kind === 'duplicate') return xml.replace(match, match + match);
    if (kind === 'internal') return xml.replace('TargetMode="External"', 'TargetMode="Internal"');
    if (kind === 'wrong-type') return xml.replace('/externalLinkPath', '/worksheet');
    return xml.replace('Target="file:///Source.xlsx"', 'Target=""');
  });
  await expect(workbookFromFile(bytes)).rejects.toThrow(/external pivot worksheet source relationship/);
});
it('imports external worksheet caches without rebinding them to destination sheets or tables', async () => {
  const source = await workbookFromFile(await externalWorksheetFixture('file:///Source.xlsx'));
  const destination = new Workbook(source.toJSON()), before = destination.toJSON();
  const added = destination.importSheets(source);
  expect(destination.nativePivots.caches.map(c => c.sourceWorkbook)).toEqual(['file:///Source.xlsx', 'file:///Source.xlsx']);
  expect(destination.nativePivots.tables.find(p => p.owner === added[1].id)).toBeTruthy();
  const result = await nativeRoundTrip(destination);
  expect(result.wb.nativePivots.caches.map(c => c.sourceWorkbook)).toEqual(['file:///Source.xlsx', 'file:///Source.xlsx']);
  destination.undo(); expect(destination.toJSON()).toEqual(before);
});
it('refuses contradictory external source storage and orphaned relationship IDs on export', async () => {
  const wb = await workbookFromFile(await externalWorksheetFixture('file:///Source.xlsx'));
  wb.nativePivots.caches[0].sourceSheetId = wb.sheets[0].id;
  expect(normalizeNativePivots(wb.nativePivots)).toBeNull();
  wb.nativePivots.caches[0].sourceSheetId = null; delete wb.nativePivots.caches[0].sourceWorkbook;
  await expect(workbookToXlsx(wb)).rejects.toThrow(/Missing external pivot workbook target/);
});
it('treats a stored external target as authoritative before package relationship IDs exist', async () => {
  const source = fixture(); source.nativePivots.caches = source.nativePivots.caches.slice(0, 1);
  source.nativePivots.tables = source.nativePivots.tables.slice(0, 1); source.nativePivots.connections = ''; source.sheets[1].charts = [];
  const cache = source.nativePivots.caches[0]; cache.sourceSheetId = null; cache.sourceWorkbook = '../Original.xlsx';
  const destination = new Workbook({ sheets: [{ name: 'Input' }] }); destination.importSheets(source);
  expect(descendants(destination.nativePivots.caches[0].xml, 'worksheetSource')[0].getAttribute('sheet')).toBe('Input');
  const result = await nativeRoundTrip(destination);
  expect(result.wb.nativePivots.caches[0].sourceWorkbook).toBe('../Original.xlsx');
});


it('preserves hidden report data in PivotCharts through sheet copy and native round trips', async () => {
  const { chartData } = await import('../src/core/charts.js');
  let wb = fixture(), sheet = wb.sheets[1];
  wb.setInput(sheet.id, 2, 2, 'Revenue');
  wb.setInput(sheet.id, 3, 1, 'Sales');
  wb.setInput(sheet.id, 3, 2, '17');
  sheet.charts[0] = { ...sheet.charts[0], includeHidden: false,
    pivotSource: { name: '[Source.xlsx]Report!Summary', standalone: false, formatId: 0 },
    sourceRefs: [{ nameRef: 'Report!C3', categories: 'Report!B4', values: 'Report!C4' }] };
  wb.setHidden(sheet.id, 'row', [3], true);
  wb.setHidden(sheet.id, 'col', [1, 2], true);
  const check = () => {
    sheet = wb.sheetByName('Report');
    expect(chartData(wb, sheet.id, sheet.charts[0]).series[0]).toMatchObject({ name: 'Revenue', values: [17], categories: ['Sales'] });
    expect(sheet.charts[0].includeHidden).toBe(false);
    expect(sheet.hiddenCols.has(2)).toBe(true);
    expect(sheet.hiddenRows.has(3)).toBe(true);
  };
  check();
  wb = wb.sheetToWorkbook(sheet.id, { sourceWorkbook: '/Source.xlsx' });
  check();
  for (let pass = 0; pass < 2; pass++) {
    const result = await nativeRoundTrip(wb);
    expect(result.get('/xl/charts/chart1_1.xml')).toContain('<c:plotVisOnly val="1"');
    wb = result.wb;
    check();
  }
});
