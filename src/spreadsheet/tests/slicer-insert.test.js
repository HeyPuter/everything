// @vitest-environment jsdom
import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { insertTableSlicers, insertPivotSlicers, pivotSlicerFields, nativePivotAt, tableSlicerProblem, freeSlicerCacheName } from '../src/core/slicer-insert.js';
import { slicerItems, setSlicerSelection } from '../src/core/slicer.js';
import { setTableHeaderRow } from '../src/core/table-header-row.js';
import { readNativePivotCache } from '../src/core/native-pivot-cache.js';
import { pivotBook } from './helpers/native-pivot-report-fixture.js';

const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function tableBook() {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Region', 'Rep', 'Amount'], ['East', 'Ann', '4'], ['West', 'Bob', '9'], ['East', 'Cy', '2']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const tableId = wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 2 }, { name: 'Sales' });
  return { wb, id, tableId };
}
async function roundTrip(wb) {
  const blob = await workbookToXlsx(wb);
  const bytes = new Uint8Array(await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsArrayBuffer(blob); }));
  const zip = X.CFB.read(bytes, { type: 'array' });
  const get = path => { const f = X.CFB.find(zip, path); return f ? new TextDecoder().decode(f.content) : null; };
  // Native-only reopening: drop the app's own sidecar so only the Excel parts speak.
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  part.content = new TextEncoder().encode(get('/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')); part.size = part.content.length;
  return { get, back: await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'slicers.xlsx') };
}

it('inserts one slicer per chosen table column, styled and placed beside the table', () => {
  const { wb, id, tableId } = tableBook();
  const ids = insertTableSlicers(wb, id, tableId, ['Region', 'Rep']);
  expect(ids).toHaveLength(2);
  const [a, b] = ids.map(x => wb.chartById(id, x));
  expect(a).toMatchObject({ type: 'slicer', title: 'Region', tableRef: 'Sales[Region]', anchor: { r: 0, c: 4 }, w: 192, h: 256, rowHeight: 241300 });
  // 24 pixels down and right of the first, anchored to the 19.5-pixel row its corner lies in.
  expect(b).toMatchObject({ title: 'Rep', anchor: { r: 1, c: 4 }, dx: 24, dy: 4.5 });
  expect(a.paint.items.selectedItemWithData).toBeTruthy();
  expect(slicerItems(wb, a).map(i => [i.value, i.selected])).toEqual([['East', true], ['West', true]]);
  // One undo step takes them all away.
  wb.undo();
  expect(wb.sheet(id).charts).toHaveLength(0);
});

it('filters the table from the slicer, several items at once, and Clear shows every row', () => {
  const { wb, id, tableId } = tableBook();
  const [sid] = insertTableSlicers(wb, id, tableId, ['Region']);
  expect(setSlicerSelection(wb, id, sid, ['West'])).toBe(true);
  expect([1, 2, 3].map(r => wb.sheet(id).filterHidden.has(r))).toEqual([true, false, true]);
  setSlicerSelection(wb, id, sid, ['West', 'East']);
  expect(wb.sheet(id).filterHidden.size).toBe(0);
  setSlicerSelection(wb, id, sid, ['East']);
  setSlicerSelection(wb, id, sid, null);
  expect(wb.sheet(id).filterHidden.size).toBe(0);
});

it('gives a table without a filter one with its buttons hidden, and refuses a headerless table', () => {
  const { wb, id, tableId } = tableBook();
  setTableHeaderRow(wb, id, tableId, false);
  expect(tableSlicerProblem(wb, id, wb.tableById(id, tableId))).toMatch(/Header Row/);
  setTableHeaderRow(wb, id, tableId, true);
  const filter = wb.filtersForSheet(id)[0];
  wb._setFilter(wb.sheet(id), null, 'Remove', { target: filter });
  expect(wb.filtersForSheet(id)).toHaveLength(0);
  insertTableSlicers(wb, id, tableId, ['Rep']);
  expect(wb.filtersForSheet(id)[0]).toMatchObject({ showButtons: false });
});

it('exports inserted table slicers as native slicer caches and views that reopen and still filter', async () => {
  const { wb, id, tableId } = tableBook();
  const [sid] = insertTableSlicers(wb, id, tableId, ['Region']);
  setSlicerSelection(wb, id, sid, ['East']);
  const { get, back } = await roundTrip(wb);
  expect(get('/xl/slicerCaches/slicerCache1.xml')).toContain('sourceName="Region"');
  expect(get('/xl/slicerCaches/slicerCache1.xml')).toContain('x15:tableSlicerCache');
  expect(get('/xl/slicers/slicer1.xml')).toMatch(/caption="Region"[^>]*rowHeight="241300"/);
  expect(get('/xl/workbook.xml')).toContain('x15:slicerCaches');
  expect(get('/xl/worksheets/sheet1.xml')).toContain('x14:slicerList');
  expect(get('/xl/tables/table1.xml')).toContain('<filter val="East"/>');
  const control = back.sheets[0].charts.find(c => c.type === 'slicer');
  expect(control).toMatchObject({ title: 'Region', tableRef: 'Sales[Region]' });
  expect(slicerItems(back, control).map(i => [i.value, i.selected])).toEqual([['East', true], ['West', false]]);
});


it('finds the PivotTable under a cell and lists its fields, every one sliceable once indexed', () => {
  const { wb, report, pivot } = pivotBook();
  expect(nativePivotAt(wb, report.id, 3, 0)).toBe(pivot);
  expect(nativePivotAt(wb, report.id, 10, 0)).toBeNull();
  expect(pivotSlicerFields(wb, pivot).map(f => [f.name, f.problem])).toEqual([['Region', null], ['Amount', null], ['When', null]]);
  expect(freeSlicerCacheName(wb, 'Region')).toBe('Slicer_Region');
});

it('inserts a PivotTable slicer bound to the report, and choosing items rebuilds the report', () => {
  const { wb, report, pivot } = pivotBook();
  const [sid] = insertPivotSlicers(wb, report.id, pivot, [0]);
  const control = wb.chartById(report.id, sid);
  expect(control).toMatchObject({ type: 'slicer', pivotCache: 'Slicer_Region', title: 'Region', anchor: { r: 2, c: 3 } });
  expect(wb.nativePivots.slicers).toHaveLength(1);
  expect(readNativePivotCache(wb.nativePivots.caches[0], { includeRecords: false }).slicerCacheId).toBe(1);
  expect(slicerItems(wb, control).map(i => [i.value, i.selected])).toEqual([['East', true], ['West', true]]);
  expect(setSlicerSelection(wb, report.id, sid, [1])).not.toBe(false);
  expect(slicerItems(wb, wb.chartById(report.id, sid)).map(i => i.selected)).toEqual([false, true]);
  expect(wb.nativePivots.tables[0].xml).toContain('<item x="0" h="1"/>');
  expect(wb.getValue(report.id, 3, 0)).toBe('West');
  expect(wb.getValue(report.id, 4, 1)).toBe(9);
  wb.undo(); wb.undo();
  expect(wb.nativePivots.slicers || []).toHaveLength(0);
  expect(wb.sheet(report.id).charts).toHaveLength(0);
});

it('indexes a field kept inline in the records before slicing it', () => {
  const { wb, report, pivot } = pivotBook();
  const [sid] = insertPivotSlicers(wb, report.id, pivot, [1]);
  const cache = wb.nativePivots.caches[0];
  expect(cache.records).toContain('<x v="2"/>');
  expect(slicerItems(wb, wb.chartById(report.id, sid)).map(i => i.value)).toEqual(['2', '4', '9']);
});

it('shows a date field’s members as dates', () => {
  const { wb, report, pivot } = pivotBook({ dateField: true });
  const [sid] = insertPivotSlicers(wb, report.id, pivot, [2]);
  expect(slicerItems(wb, wb.chartById(report.id, sid)).map(i => i.value)).toEqual(['1/1/2024', '4/1/2024', '1/1/2025']);
});

it('keeps PivotTable slicers out of the Excel parts, with the filter in the PivotTable and the slicer in the app data', async () => {
  const { wb, report, pivot } = pivotBook();
  const [sid] = insertPivotSlicers(wb, report.id, pivot, [0]);
  setSlicerSelection(wb, report.id, sid, [0]);
  // Excel repaired the PivotTable slicer parts away, so none are written; the filter is the report's hidden item.
  const { get, back } = await roundTrip(wb);
  expect(get('/xl/slicerCaches/slicerCache1.xml')).toBeNull();
  expect(get('/xl/workbook.xml')).not.toContain('slicerCaches');
  expect(get('/xl/worksheets/sheet2.xml')).not.toContain('slicerList');
  expect(get('/xl/pivotTables/pivotTable1.xml')).toContain('<item x="1" h="1"/>');
  expect(back.sheets[1].charts.filter(c => c.type === 'slicer')).toHaveLength(0);
  // With the app's own data the slicer comes back, still filtering.
  const blob = await workbookToXlsx(wb);
  const bytes = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsArrayBuffer(blob); });
  const full = await workbookFromFile(new Uint8Array(bytes), 'slicers.xlsx');
  const control = full.sheets[1].charts.find(c => c.type === 'slicer');
  expect(control).toMatchObject({ pivotCache: 'Slicer_Region', title: 'Region' });
  expect(slicerItems(full, control).map(i => [i.value, i.selected])).toEqual([['East', true], ['West', false]]);
  expect(setSlicerSelection(full, full.sheets[1].id, control.id, null)).not.toBe(false);
  expect(full.getValue(full.sheets[1].id, 4, 0)).toBe('West');
});

it('readies the PivotTable for Excel: version 3 or later and an item list for every sliced field', () => {
  const { wb, report, pivot } = pivotBook();
  const [, sid] = insertPivotSlicers(wb, report.id, pivot, [0, 1]);
  const [cache] = wb.nativePivots.caches, [table] = wb.nativePivots.tables;
  expect(cache.xml).toMatch(/createdVersion="3" refreshedVersion="3" minRefreshableVersion="3"/);
  expect(table.xml).toMatch(/createdVersion="3" updatedVersion="3" minRefreshableVersion="3"/);
  expect(table.xml).toContain('<pivotField dataField="1" showAll="0"><items count="4"><item x="0"/><item x="1"/><item x="2"/><item t="default"/></items></pivotField>');
  // The value field's own slicer then filters the report through those items.
  expect(setSlicerSelection(wb, report.id, sid, [1])).not.toBe(false);
  expect(wb.nativePivots.tables[0].xml).toContain('<item x="0" h="1"/><item x="1"/><item x="2" h="1"/><item t="default"/>');
  expect(wb.getValue(report.id, 3, 0)).toBe('West');
});
