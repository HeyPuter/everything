import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { slicerItems, slicerTableReference, setSlicerSelection, slicerTarget } from '../src/core/slicer.js';
import { readXlsxSlicers } from '../src/core/xlsx-slicers.js';
const paint = { frame: { wholeTable: { bg: '#123456' }, headerRow: { bold: true } }, items: {
  selectedItemWithData: { bg: '#654321', color: '#ffffff' },
  hoveredSelectedItemWithData: { gradient: { type: 'path', left: .2, right: .8, top: .1, bottom: .9,
    stops: [{ position: 0, color: '#112233' }, { position: 1, color: '#445566' }] } },
} };
function make() {
  const wb = new Workbook(), sheet = wb.activeSheet;
  [['Region [Code]', 'Value'], ['East', 1], ['West', 2], ['East', 3]].forEach((row, r) => row.forEach((v, c) => wb.setInput(sheet.id, r + 2, c + 3, String(v))));
  wb.addTable(sheet.id, { r1: 2, c1: 3, r2: 5, c2: 4 }, { name: 'Sales' });
  const owner = wb.addSheet('Views');
  const id = wb.addChart(owner.id, { type: 'slicer', tableRef: slicerTableReference('Sales', 'Region [Code]'), title: 'Regions & places',
    anchor: { r: 7, c: 2 }, dx: 1.25, dy: 2.75, w: 211, h: 135, columnCount: 2, rowHeight: 200000,
    startItem: 1, showCaption: false, lockedPosition: true, print: false, hidden: true,
    sortOrder: 'descending', customListSort: false, crossFilter: 'showItemsWithNoData', paint });
  return { wb, sheet, owner, id };
}
async function bytes(wb) { return new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()); }
function editPackage(bytes, edit = () => {}, removeMeta = false) {
  const zip = X.CFB.read(bytes, { type: 'array' });
  const get = path => new TextDecoder().decode(X.CFB.find(zip, path).content);
  const set = (path, xml) => X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(xml));
  if (removeMeta) set('/xl/workbook.xml', get('/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  edit({ get, set });
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}
const open = bytes => workbookFromFile(bytes, 'roundtrip.xlsx');
it.each([false, true])('round trips a live cross-sheet slicer with private metadata removed=%s', async removeMeta => {
  const { wb, sheet, owner, id } = make();
  expect(setSlicerSelection(wb, owner.id, id, ['West'])).toBe(true);
  const original = wb.chartById(owner.id, id), output = editPackage(await bytes(wb), undefined, removeMeta), restored = await open(output);
  const controls = restored.sheetByName('Views').charts;
  expect(controls).toHaveLength(1);
  const control = controls[0];
  for (const key of ['type', 'anchor', 'w', 'h', 'columnCount', 'rowHeight', 'startItem', 'showCaption', 'lockedPosition', 'print', 'hidden', 'paint', 'tableRef', 'title', 'sortOrder', 'customListSort', 'crossFilter']) expect(control[key]).toEqual(original[key]);
  for (const key of ['dx', 'dy']) expect(Math.abs(control[key] - original[key])).toBeLessThanOrEqual(.5 / 9525);
  expect(slicerItems(restored, control).map(i => [i.value, i.selected])).toEqual([['West', true], ['East', false]]);
  expect(setSlicerSelection(restored, restored.sheetByName('Views').id, control.id, ['East'])).toBe(true);
  expect([...restored.sheets[0].filterHidden]).toEqual([4]);
  restored.undo(); expect([...restored.sheets[0].filterHidden]).toEqual([3, 5]);
  expect([...sheet.filterHidden]).toEqual([3, 5]);
});
it('shares caches across views and remaps exported table/column identities after structural edits', async () => {
  const { wb, sheet, owner, id } = make();
  wb.duplicateChart(owner.id, id);
  wb.insertCols(sheet.id, 0);
  wb.setInput(sheet.id, 2, 4, 'New & header');
  const output = await bytes(wb), native = readXlsxSlicers(X.read(output, { type: 'array', bookFiles: true, cellStyles: true }));
  expect(native.views).toHaveLength(2); expect(native.caches).toHaveLength(1);
  expect(native.caches[0]).toMatchObject({ tableId: 1, columnId: 1, sourceName: 'New & header', table: { name: 'Sales', column: { name: 'New & header', index: 0 } } });
  const restored = await open(editPackage(output, undefined, true));
  const views = restored.sheetByName('Views');
  expect(slicerTarget(restored, views.charts[0]).col).toBe(4);
  expect(setSlicerSelection(restored, views.id, views.charts[0].id, ['East'])).toBe(true);
  expect(slicerItems(restored, views.charts[1]).filter(i => i.selected).map(i => i.value)).toEqual(['East']);
});
it('reads native external view/style edits instead of stale private slicer metadata', async () => {
  const { wb } = make();
  const output = editPackage(await bytes(wb), ({ get, set }) => {
    const p = '/xl/slicers/slicer2.xml'; set(p, get(p).replace('caption="Regions &amp; places"', 'caption="Edited"').replace('columnCount="2"', 'columnCount="3"'));
    set('/xl/styles.xml', get('/xl/styles.xml').replaceAll('FF654321', 'FFABCDEF'));
  });
  const control = (await open(output)).sheetByName('Views').charts[0];
  expect(control.title).toBe('Edited'); expect(control.columnCount).toBe(3);
  expect(control.paint.items.selectedItemWithData.bg).toBe('#abcdef');
});
it('does not resurrect an externally deleted native view', async () => {
  const { wb } = make();
  const output = editPackage(await bytes(wb), ({ get, set }) => {
    const p = '/xl/slicers/slicer2.xml'; set(p, get(p).replace(/<x14:slicer\b[^>]*\/>/, ''));
    set('/xl/drawings/drawing2.xml', get('/xl/drawings/drawing2.xml').replace(/<xdr:oneCellAnchor>[\s\S]*?<\/xdr:oneCellAnchor>/, ''));
  });
  expect((await open(output)).sheetByName('Views').charts).toEqual([]);
});
it('coexists with ordinary drawings and preserves absolute anchors', async () => {
  const { wb, owner, id } = make();
  wb.updateChart(owner.id, id, { anchorMode: 'absolute', anchor: { r: 0, c: 0 }, dx: 31.5, dy: 47.75 });
  wb.addChart(owner.id, { type: 'text', title: 'Note', text: 'A separate drawing', anchor: { r: 12, c: 5 }, w: 100, h: 30 });
  const restored = await open(await bytes(wb)), charts = restored.sheetByName('Views').charts;
  expect(charts.filter(c => c.type === 'slicer')).toHaveLength(1);
  const control = charts.find(c => c.type === 'slicer');
  expect(control.anchorMode).toBe('absolute');
  expect(Math.abs(control.dx - 31.5)).toBeLessThanOrEqual(.5 / 9525 + 1e-12);
  expect(Math.abs(control.dy - 47.75)).toBeLessThanOrEqual(.5 / 9525 + 1e-12);
  expect(charts.find(c => c.type === 'text').text).toBe('A separate drawing');
});
it('rejects missing bindings and unsupported styles instead of writing an invalid native cache', async () => {
  const { wb, owner, id } = make();
  wb.updateChart(owner.id, id, { tableRef: slicerTableReference('Sales', 'Nowhere') });
  await expect(bytes(wb)).rejects.toThrow(/missing table column/);
  wb.undo(); wb.updateChart(owner.id, id, { paint: null });
  await expect(bytes(wb)).rejects.toThrow(/supported style/);
});
// A table converted to a range, or the column a slicer filters deleted, takes its slicers along, as Excel does:
// left behind, they filtered nothing and the workbook could no longer be saved.
it('deletes a table’s slicers with the table or their column, so the workbook still saves', async () => {
  const { wb, sheet, owner, id } = make();
  wb.deleteTable(sheet.id, sheet.tables[0].id);
  expect(owner.charts).toEqual([]);
  expect(wb.undoLabels()[0]).toBe('Convert table to range');
  await expect(bytes(wb)).resolves.toBeInstanceOf(Uint8Array);
  wb.undo();
  expect(wb.chartById(owner.id, id)?.tableRef).toBe(slicerTableReference('Sales', 'Region [Code]'));
  wb.deleteCols(sheet.id, 4); // the Value column: the slicer stays
  expect(wb.chartById(owner.id, id)).toBeTruthy();
  wb.undo();
  wb.deleteCols(sheet.id, 3); // its own column
  expect(wb.chartById(owner.id, id)).toBeFalsy();
  await expect(bytes(wb)).resolves.toBeInstanceOf(Uint8Array);
  wb.undo();
  expect(slicerTarget(wb, wb.chartById(owner.id, id))?.col).toBe(3);
  wb.deleteCells(sheet.id, { r1: 0, c1: 3, r2: 20, c2: 3 }, 'left'); // the column's cells, shifted left
  expect(wb.chartById(owner.id, id)).toBeFalsy();
  wb.undo();
  expect(wb.chartById(owner.id, id)).toBeTruthy();
  wb.deleteRows(sheet.id, 2, 4); // the whole table
  expect(wb.chartById(owner.id, id)).toBeFalsy();
  wb.undo();
  expect(wb.chartById(owner.id, id)).toBeTruthy();
});
it('keeps worksheet slicer extensions outside nested conditional-format extensions', async () => {
  const { wb, owner } = make();
  wb.setInput(owner.id, 0, 0, '10');
  wb.addRule(owner.id, { type: 'databar', range: { r1: 0, c1: 0, r2: 2, c2: 0 }, style: {}, barColor: '#abcdef', barNegativeColor: '#ff0000' });
  const restored = await open(editPackage(await bytes(wb), undefined, true));
  expect(restored.sheetByName('Views').charts.filter(c => c.type === 'slicer')).toHaveLength(1);
  expect(restored.sheetByName('Views').rules[0].type).toBe('databar');
});
it('rejects an orphan native view rather than silently dropping it', async () => {
  const { wb } = make();
  const output = editPackage(await bytes(wb), ({ get, set }) => {
    const p = '/xl/workbook.xml'; set(p, get(p).replace(/<x15:slicerCaches\b[^>]*>[\s\S]*?<\/x15:slicerCaches>/, ''));
  });
  await expect(open(output)).rejects.toThrow(/missing slicer cache/);
});

it('avoids cache-name collisions with defined names and table names', async () => {
  const { wb, sheet } = make();
  wb.names.push({ name: 'puterslicercache1', ref: 'Views!A1' });
  wb.updateTable(sheet.id, sheet.tables[0].id, { name: 'PuterSlicerCache2' });
  const native = readXlsxSlicers(X.read(await bytes(wb), { type: 'array', bookFiles: true, cellStyles: true }));
  expect(native.caches[0].name).toBe('PuterSlicerCache3');
});

it('preserves native view/cache names independently of captions, header renames and private metadata', async () => {
  const { wb, sheet, owner, id } = make();
  const nativeName = '地域 <&> "North"\tView', nativeCacheName = 'Slicer_地区';
  wb.updateChart(owner.id, id, { nativeName, nativeCacheName });
  const snapshot = new Workbook(wb.toJSON());
  expect(snapshot.sheetByName('Views').charts[0]).toMatchObject({ nativeName, nativeCacheName });
  const imported = await open(editPackage(await bytes(snapshot), undefined, true));
  const control = imported.sheetByName('Views').charts[0];
  expect(control).toMatchObject({ nativeName, nativeCacheName });
  imported.updateChart(imported.sheetByName('Views').id, control.id, { title: 'Different caption' });
  imported.setInput(imported.sheets[0].id, 2, 3, 'New column');
  const native = readXlsxSlicers(X.read(await bytes(imported), { type: 'array', bookFiles: true, cellStyles: true }));
  expect(native.views[0]).toMatchObject({ name: nativeName, caption: 'Different caption', cache: nativeCacheName, drawing: { name: nativeName } });
  expect(native.caches[0]).toMatchObject({ name: nativeCacheName, sourceName: 'New column' });
  expect(sheet.tables[0].name).toBe('Sales');
});
it('reserves imported names before allocating earlier new views and shares their source cache', async () => {
  const { wb, sheet, owner, id } = make();
  wb.updateChart(owner.id, id, { nativeName: 'PuterSlicer1', nativeCacheName: 'PuterSlicerCache1' });
  wb.addChart(sheet.id, { ...wb.chartById(owner.id, id), nativeName: undefined, nativeCacheName: undefined });
  const native = readXlsxSlicers(X.read(await bytes(wb), { type: 'array', bookFiles: true, cellStyles: true }));
  expect(native.views.map(v => [v.owner, v.name])).toEqual([[sheet.name, 'PuterSlicer2'], ['Views', 'PuterSlicer1']]);
  expect(native.caches.map(c => c.name)).toEqual(['PuterSlicerCache1']);
});
it('retains distinct named caches for the same source rather than silently merging their identities', async () => {
  const { wb, owner, id } = make();
  wb.updateChart(owner.id, id, { nativeName: 'Original', nativeCacheName: 'CacheOne' });
  wb.addChart(owner.id, { ...wb.chartById(owner.id, id), nativeName: 'Second', nativeCacheName: 'CacheTwo' });
  const native = readXlsxSlicers(X.read(await bytes(wb), { type: 'array', bookFiles: true, cellStyles: true }));
  expect(native.caches.map(c => c.name)).toEqual(['CacheOne', 'CacheTwo']);
  expect(native.views.map(v => v.cache)).toEqual(['CacheOne', 'CacheTwo']);
});
it('gives copied controls new view names without stealing original names after reordering', async () => {
  const { wb, owner, id } = make();
  wb.updateChart(owner.id, id, { nativeName: 'Original', nativeCacheName: 'OriginalCache' });
  const duplicate = wb.duplicateChart(owner.id, id);
  expect(wb.chartById(owner.id, duplicate).nativeName).toBeUndefined();
  expect(wb.chartById(owner.id, duplicate).nativeCacheName).toBe('OriginalCache');
  const copy = wb.duplicateSheet(owner.id); wb.moveSheet(copy.id, 0);
  expect(copy.charts.every(c => !c.nativeName && !c.nativeCacheName)).toBe(true);
  const native = readXlsxSlicers(X.read(await bytes(wb), { type: 'array', bookFiles: true, cellStyles: true }));
  expect(native.views.find(v => v.name === 'Original').owner).toBe('Views');
  expect(new Set(native.views.map(v => v.name.toUpperCase())).size).toBe(4);
  expect(native.caches.map(c => c.name)).toEqual(['OriginalCache']);
});
it('allocates a distinct cache when a copied sheet contains the source table', async () => {
  const { wb, sheet, owner, id } = make();
  wb.addChart(sheet.id, { ...wb.chartById(owner.id, id), nativeName: 'Local', nativeCacheName: 'LocalCache' });
  const copy = wb.duplicateSheet(sheet.id); wb.moveSheet(copy.id, 0);
  expect(copy.charts[0].nativeCacheName).toBeUndefined();
  const native = readXlsxSlicers(X.read(await bytes(wb), { type: 'array', bookFiles: true, cellStyles: true }));
  expect(native.caches).toHaveLength(2);
  expect(native.caches.find(c => c.name === 'LocalCache').table.name).toBe('Sales');
  expect(native.caches.find(c => c.name !== 'LocalCache').table.name).toBe(copy.tables[0].name);
});
it('resolves case-insensitive cache and view name collisions without dangling native references', async () => {
  const { wb, owner, id } = make();
  wb.updateChart(owner.id, id, { nativeName: 'Same', nativeCacheName: 'Existing' });
  wb.names.push({ name: 'existing', ref: 'Views!A1' });
  wb.addChart(owner.id, { ...wb.chartById(owner.id, id), nativeName: 'same', nativeCacheName: 'existing' });
  const native = readXlsxSlicers(X.read(await bytes(wb), { type: 'array', bookFiles: true, cellStyles: true }));
  expect(native.caches).toHaveLength(1); expect(native.caches[0].name.toLowerCase()).not.toBe('existing');
  expect(new Set(native.views.map(v => v.name.toUpperCase())).size).toBe(2);
  for (const view of native.views) { expect(view.cache).toBe(native.caches[0].name); expect(view.drawing.name).toBe(view.name); }
});
it('counts supplementary Unicode characters correctly and refuses invalid cache syntax', async () => {
  const { wb, owner, id } = make();
  const nativeName = '𠜎'.repeat(20000), nativeCacheName = '𠜎'.repeat(255);
  wb.updateChart(owner.id, id, { nativeName, nativeCacheName });
  const native = readXlsxSlicers(X.read(await bytes(wb), { type: 'array', bookFiles: true, cellStyles: true }));
  expect(native.views[0].name).toBe(nativeName); expect(native.caches[0].name).toBe(nativeCacheName);
  wb.updateChart(owner.id, id, { nativeCacheName: 'A1' });
  await expect(bytes(wb)).rejects.toThrow(/Invalid slicer cache name/);
  expect(() => wb.updateChart(owner.id, id, { nativeName: '\ud800' })).toThrow(/Invalid stored slicer name/);
});
it('preserves an existing cache companion name and emits the required companion for new caches', async () => {
  const { wb, owner, id } = make();
  wb.updateChart(owner.id, id, { nativeName: 'View', nativeCacheName: 'CacheIdentity' });
  wb.names.push({ name: 'CacheIdentity', ref: '#N/A' });
  const inspect = async workbook => {
    const book = X.read(await bytes(workbook), { type: 'array', bookFiles: true, cellStyles: true });
    const native = readXlsxSlicers(book);
    for (const cache of native.caches) expect(book.Workbook.Names.filter(n => n.Name.toUpperCase() === cache.name.toUpperCase() && n.Sheet == null)).toEqual([{ Name: cache.name, Ref: '#N/A' }]);
    return native;
  };
  expect((await inspect(wb)).caches[0].name).toBe('CacheIdentity');
  const restored = await open(editPackage(await bytes(wb), undefined, true));
  expect((await inspect(restored)).caches[0].name).toBe('CacheIdentity');
  const fresh = make(); expect((await inspect(fresh.wb)).caches).toHaveLength(1);
});
it('does not consume an unrelated #N/A name when allocating a new cache', async () => {
  const { wb } = make(); wb.names.push({ name: 'PuterSlicerCache1', ref: '#N/A' });
  const book = X.read(await bytes(wb), { type: 'array', bookFiles: true, cellStyles: true });
  expect(readXlsxSlicers(book).caches[0].name).toBe('PuterSlicerCache2');
  expect(book.Workbook.Names.map(n => n.Name).sort()).toEqual(['PuterSlicerCache1', 'PuterSlicerCache2']);
});

it('encodes SpreadsheetML slicer identities and captions without encoding plain DrawingML names', async () => {
  const { wb, sheet, owner, id } = make();
  const nativeName = 'View_x0041_', nativeCacheName = 'Cache_x0042_', header = 'Cost_x0043_\nnet';
  const title = 'Line\r\n\t<&>\u0001_x0041_𠜎';
  wb.updateTable(sheet.id, sheet.tables[0].id, { name: 'Sales_x0044_' });
  wb.setInput(sheet.id, 2, 3, header);
  wb.renameSheet(owner.id, 'Views_x0045_');
  wb.updateChart(owner.id, id, { nativeName, nativeCacheName, title });
  const first = await bytes(wb);
  const zip = X.CFB.read(first, { type: 'array' });
  const xml = path => new TextDecoder().decode(X.CFB.find(zip, path).content);
  expect(xml('/xl/slicers/slicer2.xml')).toContain('name="View_x005F_x0041_"');
  expect(xml('/xl/slicers/slicer2.xml')).toContain('_x000D__x000A__x0009_');
  expect(xml('/xl/drawings/drawing2.xml')).toContain('name="View_x0041_"');
  expect(xml('/xl/workbook.xml')).toContain('name="Cache_x005F_x0042_"');
  expect(xml('/xl/tables/table1.xml')).toContain('name="Cost_x005F_x0043__x000A_net"');
  for (const input of [first, await bytes(await open(editPackage(first, undefined, true)))]) {
    const restored = await open(editPackage(input, undefined, true));
    const control = restored.sheetByName('Views_x0045_').charts[0];
    expect(control).toMatchObject({ nativeName, nativeCacheName, title });
    expect(slicerTarget(restored, control)?.table.name).toBe('Sales_x0044_');
    const native = readXlsxSlicers(X.read(input, { type: 'array', bookFiles: true }));
    expect(native.caches[0].sourceName).toBe(header);
    expect(native.caches[0].table.column.name).toBe(header);
    expect(restored.names.filter(n => n.name === nativeCacheName)).toEqual([{ name: nativeCacheName, ref: '#N/A' }]);
  }
});
it('decodes a view style reference while retaining the plain XML style definition name', async () => {
  const { wb } = make(), original = await bytes(wb);
  const native = readXlsxSlicers(X.read(original, { type: 'array', bookFiles: true }));
  const old = native.views[0].style;
  const external = editPackage(original, ({ get, set }) => {
    set('/xl/styles.xml', get('/xl/styles.xml').replaceAll(old, 'Style_x0041_'));
    set('/xl/slicers/slicer2.xml', get('/xl/slicers/slicer2.xml').replace(`style="${old}"`, 'style="Style_x005F_x0041_"'));
  }, true);
  const restored = await open(external);
  expect(restored.sheetByName('Views').charts[0].paint).toEqual(paint);
  expect(readXlsxSlicers(X.read(external, { type: 'array', bookFiles: true })).views[0].style).toBe('Style_x0041_');
});

it('retains hide-no-data through native-only round trips and copies without exporting an invented attribute', async () => {
  const f = make(); let wb = f.wb;
  wb.updateChart(f.owner.id, f.id, { hideItemsWithNoData: true, crossFilter: 'none' });
  wb.setFilterCriteria(f.sheet.id, 4, { op: 'gt', value: '2' });
  wb.duplicateChart(f.owner.id, f.id);
  for (let pass = 0; pass < 2; pass++) {
    const output = editPackage(await bytes(wb), ({get}) => {
      const cache = get('/xl/slicerCaches/slicerCache1.xml');
      expect(cache).toContain('slicerCacheHideItemsWithNoData'); expect(cache).not.toContain('hideItemsWithNoData=');
    }, true);
    wb = await open(output);
    const views = wb.sheetByName('Views').charts;
    expect(views).toHaveLength(2); expect(views.every(c => c.hideItemsWithNoData)).toBe(true);
    expect(slicerItems(wb, views[0]).map(i => [i.value,i.hidden])).toEqual([['West',true],['East',false]]);
  }
});
it('honors external removal of hide-no-data despite saved private control metadata', async () => {
  const {wb,owner,id} = make(); wb.updateChart(owner.id,id,{hideItemsWithNoData:true});
  const output = editPackage(await bytes(wb), ({get,set}) => {
    const p='/xl/slicerCaches/slicerCache1.xml'; set(p,get(p).replace(/<x15:slicerCacheHideItemsWithNoData\s*\/>/,''));
  });
  expect((await open(output)).sheetByName('Views').charts[0].hideItemsWithNoData).toBe(false);
});
