import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { readNativePivotLayout } from '../src/core/native-pivot-layout.js';
import { formatNativePivotSelection, pasteNativePivotStyles } from '../src/core/native-pivot-style-selection.js';
import { nativePivotPaintAt, nativePivotPaintLayers } from '../src/core/native-pivot-paint.js';
import { readNativePivotFormats, nativePivotFormatLayers } from '../src/core/native-pivot-formats.js';
import { nativeRoundTrip } from './helpers/linked-model-workbook.js';
const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const xml = (tag, body, attrs = '') => `<${tag} xmlns="${main}" ${attrs}>${body}</${tag}>`;
const data = { r1: 5, r2: 6, c1: 4, c2: 5 };

// Center Across Selection, Fill, Justify and Distributed, and Excel's hairline, dash-dot and medium dashed border
// lines, open from Excel files and are kept in cells, but a PivotTable's own formats wrote and read only Left, Center
// and Right and the six lines the app first drew: Paste Formats or the format painter from such a cell onto a
// PivotTable was refused, and so was opening a file whose PivotTable formats carry them.
function fixture() {
  const wb = new Workbook({ sheets: [{ id: 'report', name: 'Report' }, { name: 'Source', cells: {
    '0,0': { v: 'Region' }, '0,1': { v: 'Quarter' }, '0,2': { v: 'Amount' },
    '1,0': { v: 'East' }, '1,1': { v: 'Q1' }, '1,2': { v: 3 },
    '2,0': { v: 'East' }, '2,1': { v: 'Q2' }, '2,2': { v: 5 },
    '3,0': { v: 'West' }, '3,1': { v: 'Q1' }, '3,2': { v: 8 },
    '4,0': { v: 'West' }, '4,1': { v: 'Q2' }, '4,2': { v: 13 },
  } }] });
  const cache = { key: 'cache', xml: xml('pivotCacheDefinition', '<cacheSource type="worksheet"><worksheetSource sheet="Source" ref="A1:C5"/></cacheSource><cacheFields count="3"><cacheField name="Region"><sharedItems count="2"><s v="East"/><s v="West"/></sharedItems></cacheField><cacheField name="Quarter"><sharedItems count="2"><s v="Q1"/><s v="Q2"/></sharedItems></cacheField><cacheField name="Amount"/></cacheFields>', 'recordCount="4"'), records: xml('pivotCacheRecords', '<r><x v="0"/><x v="0"/><n v="3"/></r><r><x v="0"/><x v="1"/><n v="5"/></r><r><x v="1"/><x v="0"/><n v="8"/></r><r><x v="1"/><x v="1"/><n v="13"/></r>', 'count="4"') };
  const pivot = { owner: 'report', cache: 'cache', name: 'Matrix', ref: 'D5:F8', xml: xml('pivotTableDefinition', '<location ref="D5:F8" firstHeaderRow="0" firstDataRow="1" firstDataCol="1"/><pivotFields count="3"><pivotField axis="axisRow"><items count="2"><item x="0"/><item x="1"/></items></pivotField><pivotField axis="axisCol"><items count="2"><item x="0"/><item x="1"/></items></pivotField><pivotField dataField="1"/></pivotFields><rowFields count="1"><field x="0"/></rowFields><rowItems count="3"><i><x v="0"/></i><i><x v="1"/></i><i t="grand"><x/></i></rowItems><colFields count="1"><field x="1"/></colFields><colItems count="2"><i><x v="0"/></i><i><x v="1"/></i></colItems><dataFields count="1"><dataField fld="2" name="Amount"/></dataFields>', 'name="Matrix" dataCaption="Values" rowGrandTotals="0"') };
  // Formatting uses saved axes and cells; it must not rebuild column headers.
  wb.nativePivots = { version: 1, caches: [cache], tables: [pivot], dxfs: [], formats: {} };
  const values = [['Region', 'Q1', 'Q2'], ['East', 3, 5], ['West', 8, 13], ['Grand Total', 11, 18]];
  wb.setCells('report', values.flatMap((row, r) => row.map((v, c) => ({ r: r + 4, c: c + 3, cell: { v } }))));
  wb.clearHistory(); return wb;
}
function paint(wb, r, c) {
  const p = wb.nativePivots.tables[0];
  const layout = readNativePivotLayout(p, wb.nativePivots.caches[0]);
  const layers = nativePivotFormatLayers(layout, readNativePivotFormats(p, wb.nativePivots));
  const result = nativePivotPaintAt(nativePivotPaintLayers(layers, {}, { numberFormats: wb.nativePivots.formats }), r, c);
  // Shared pen summaries are redundant; each edge descriptor is authoritative.
  delete result.bs; delete result.bc; return result;
}

it.each([
  [{ align: 'centerContinuous' }], [{ align: 'distributed' }], [{ align: 'justify' }], [{ align: 'fill' }],
  [{ bt: true, btBorder: { bs: 'hair', bc: null } }], [{ bb: true, bbBorder: { bs: 'mediumDashDot', bc: '#ff0000' } }],
  [{ bl: true, blBorder: { bs: 'slantDashDot', bc: null } }, ],
])('formats PivotTable cells with %j and keeps it through a save', async (patch) => {
  let wb = fixture();
  expect(formatNativePivotSelection(wb, new Map([['report', [data]]]), patch)).toBe(true);
  expect(paint(wb, 5, 4)).toMatchObject(patch);
  wb = await nativeRoundTrip(wb);
  expect(paint(wb, 6, 5)).toMatchObject(patch);
});

it('pastes such formats onto a PivotTable', () => {
  const wb = fixture();
  const source = [[{ s: { font: 'arial', size: 16, align: 'centerContinuous', bb: true, bbBorder: { bs: 'dashDotDot', bc: null } } }]];
  expect(pasteNativePivotStyles(wb, 'report', source, 5, 4, data)).toBe(true);
  expect(paint(wb, 6, 5)).toMatchObject({ align: 'centerContinuous', bb: true, bbBorder: { bs: 'dashDotDot' } });
});

// A cell's double or accounting underline is kept by name, and a PivotTable's formats refused it the same way.
it.each(['double', 'singleAccounting', 'doubleAccounting'])('pastes a %s underline onto a PivotTable and keeps it through a save', async (underline) => {
  let wb = fixture();
  expect(pasteNativePivotStyles(wb, 'report', [[{ s: { font: 'arial', size: 16, underline } }]], 5, 4, data)).toBe(true);
  expect(paint(wb, 6, 5)).toMatchObject({ underline });
  wb = await nativeRoundTrip(wb);
  expect(paint(wb, 5, 4)).toMatchObject({ underline });
});
