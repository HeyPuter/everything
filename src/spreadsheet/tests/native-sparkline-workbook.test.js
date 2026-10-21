import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { nativeSparklineExtension, readNativeSparklineGroups } from '../src/core/xlsx-sparklines.js';
const make = () => new Workbook({ sheets: [
  { id: 'data', name: 'Data', cells: { '0,0': { v: 1 }, '1,0': { v: 2 }, '2,0': { v: 3 } } },
  { id: 'view', name: 'View', cells: { '2,3': { v: 'Keep text' } }, sparklineGroups: [{ type: 'column', dateAxis: true, dateFormula: 'Data!B1:B3', minAxisType: 'group', high: true, colorSeries: { theme: 4, tint: -0.25 }, sparklines: [{ ref: 'D3', formula: 'Data!A1:A3' }, { ref: 'D6', formula: 'View!A6:C6' }] }] },
] });
const groups = w => w.sheet('view').sparklineGroups;
const get = (zip, path) => new TextDecoder().decode(X.CFB.find(zip, path).content);
const set = (zip, path, xml) => X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(xml));
const save = async wb => X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
const open = async zip => {
  set(zip, '/xl/workbook.xml', get(zip, '/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  return workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
};
it('keeps groups distinct from scalar values, clones snapshots and writes native metadata', async () => {
  let wb = make(); const expected = groups(wb);
  expect(wb.getValue('view', 2, 3)).toBe('Keep text'); expect(wb.getValue('view', 5, 3)).toBeNull();
  const json = wb.toJSON(), clone = new Workbook(json);
  clone.sheet('view').sparklineGroups[0].colorSeries.tint = 0.5;
  expect(groups(wb)[0].colorSeries.tint).toBe(-0.25);
  expect(json.sheets[1].sparklineGroups[0].colorSeries.tint).toBe(-0.25);
  for (let i = 0; i < 2; i++) {
    const zip = await save(wb);
    expect(readNativeSparklineGroups(get(zip, '/xl/worksheets/sheet2.xml'))).toEqual(expected);
    wb = await open(zip);
    expect(wb.sheets[1].sparklineGroups).toEqual(expected);
    expect(wb.getValue(wb.sheets[1].id, 2, 3)).toBe('Keep text');
  }
});
it('imports original native groups without private metadata or destination values', async () => {
  const wb = new Workbook(), zip = await save(wb);
  const expected = [{ type: 'stacked', sparklines: [{ ref: 'Z150', formula: 'Sheet1!A1:C1' }] }];
  set(zip, '/xl/worksheets/sheet1.xml', get(zip, '/xl/worksheets/sheet1.xml').replace('</worksheet>', `<extLst>${nativeSparklineExtension(expected)}</extLst></worksheet>`));
  const loaded = await open(zip), sheet = loaded.sheets[0];
  expect(sheet.sparklineGroups[0]).toMatchObject(expected[0]);
  expect(loaded.getValue(sheet.id, 149, 25)).toBeNull();
  expect(sheet.rows).toBeGreaterThanOrEqual(150);
  expect(loaded.usedRange(sheet.id)).toEqual({ r1: 0, c1: 0, r2: 149, c2: 25 });
});
it('updates both axis data and series references after source insert/delete with exact undo/redo', () => {
  const wb = make(), before = wb.toJSON();
  wb.insertRows('data', 1, 2);
  expect(groups(wb)[0]).toMatchObject({ dateFormula: 'Data!B1:B5', sparklines: [{ ref: 'D3', formula: 'Data!A1:A5' }, { ref: 'D6', formula: 'View!A6:C6' }] });
  const after = wb.toJSON(); wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
  wb.deleteRows('data', 0, 5);
  expect(groups(wb)[0].sparklines[0].formula).toContain('#REF!');
  expect(groups(wb)[0].dateFormula).toContain('#REF!');
  expect(groups(wb)[0].sparklines).toHaveLength(2);
});
it('moves destinations with inserted/deleted rows and columns and removes empty groups', () => {
  const wb = make(), before = wb.toJSON();
  wb.insertRows('view', 1, 2); wb.insertCols('view', 2, 1);
  expect(groups(wb)[0].sparklines.map(s => s.ref)).toEqual(['E5', 'E8']);
  expect(groups(wb)[0].sparklines[1].formula).toBe('View!A8:D8');
  wb.deleteRows('view', 4, 1);
  expect(groups(wb)[0].sparklines.map(s => s.ref)).toEqual(['E7']);
  wb.deleteCols('view', 4, 1); expect(groups(wb)).toEqual([]);
  for (let i = 0; i < 4; i++) wb.undo(); expect(wb.toJSON()).toEqual(before);
});
it('renames, duplicates and deletes sheets while keeping source bindings and independent group identities', () => {
  const wb = make(); wb.renameSheet('data', "O'Brien");
  expect(groups(wb)[0].sparklines[0].formula).toBe("'O''Brien'!A1:A3");
  const copy = wb.duplicateSheet('view');
  expect(copy.sparklineGroups[0].uid).not.toBe(groups(wb)[0].uid);
  expect(copy.sparklineGroups[0].sparklines[1].formula).toBe("'View (2)'!A6:C6");
  copy.sparklineGroups[0].colorSeries.tint = 0.75;
  expect(groups(wb)[0].colorSeries.tint).toBe(-0.25);
  wb.deleteSheet('data'); expect(groups(wb)[0].dateFormula).toContain('#REF!');
  wb.undo(); expect(groups(wb)[0].dateFormula).toBe("'O''Brien'!B1:B3");
});
it('tracks line moves, including formulas on other sheets, only once', () => {
  const wb = make(), before = wb.toJSON();
  wb.moveRows('view', 2, 1, 7);
  expect(groups(wb)[0].sparklines[0].ref).toBe('D7');
  expect(groups(wb)[0].sparklines[1]).toEqual({ ref: 'D5', formula: 'View!A5:C5' });
  wb.moveRows('data', 0, 3, 8);
  expect(groups(wb)[0].sparklines[0].formula).toBe('Data!A6:A8');
  expect(groups(wb)[0].dateFormula).toBe('Data!B6:B8');
  wb.undo(); wb.undo(); expect(wb.toJSON()).toEqual(before);
});
it('tracks destination and source cells through band insertion/deletion without moving neighboring sparklines', () => {
  const wb = make(), before = wb.toJSON();
  wb.insertCells('view', { r1: 2, c1: 3, r2: 2, c2: 3 }, 'down');
  expect(groups(wb)[0].sparklines.map(s => s.ref)).toEqual(['D4', 'D7']);
  expect(groups(wb)[0].sparklines[1].formula).toBe('View!A6:C6');
  wb.deleteCells('view', { r1: 3, c1: 3, r2: 3, c2: 3 }, 'up');
  expect(groups(wb)[0].sparklines.map(s => s.ref)).toEqual(['D6']);
  wb.undo(); wb.undo(); expect(wb.toJSON()).toEqual(before);
});
it('refuses inserts that would push a blank sparkline destination outside the grid', () => {
  const wb = new Workbook({ sheets: [{ id: 'edge', name: 'Edge', sparklineGroups: [{ sparklines: [{ ref: 'XFD1048576', formula: 'A1:C1' }] }] }] });
  expect(wb.insertRows('edge', 0, 1)).toBe(false); expect(wb.insertCols('edge', 0, 1)).toBe(false);
  expect(wb.insertCells('edge', { r1: 1048575, r2: 1048575, c1: 16383, c2: 16383 }, 'down')).toBe(false);
  expect(wb.sheet('edge').sparklineGroups[0].sparklines[0].ref).toBe('XFD1048576');
});
it('parses extension metadata without applying DOM node limits to a large cell grid', () => {
  const ext = nativeSparklineExtension([{ sparklines: [{ ref: 'B1', formula: 'A1:A2' }] }]);
  const xml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${'<row><c><v>1</v></c></row>'.repeat(40000)}</sheetData><!-- <extLst> --><extLst>${ext}</extLst></worksheet>`;
  expect(readNativeSparklineGroups(xml)[0].sparklines[0].ref).toBe('B1');
});
it('moves and overwrites destinations while retaining groups and undoing exactly', () => {
  const wb = make(), before = wb.toJSON();
  const src = { r1: 2, c1: 3, r2: 2, c2: 3 };
  wb.moveRange('view', src, 5, 3);
  expect(groups(wb)[0].sparklines).toEqual([{ ref: 'D6', formula: 'Data!A1:A3' }]);
  wb.undo(); expect(wb.toJSON()).toEqual(before);
  const cells = wb.copyRange('view', src);
  wb.placeMoved('data', 4, 5, cells, { sheetId: 'view', range: src });
  expect(groups(wb)[0].sparklines).toEqual([{ ref: 'D6', formula: 'View!A6:C6' }]);
  expect(wb.sheet('data').sparklineGroups[0].sparklines).toEqual([{ ref: 'F5', formula: 'Data!A1:A3' }]);
  expect(wb.sheet('data').sparklineGroups[0].uid).not.toBe(groups(wb)[0].uid);
  const after = wb.toJSON(); wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
});
it('keeps unqualified source references and local names bound to the old sheet after a cross-sheet cut', () => {
  const wb = make();
  groups(wb)[0].sparklines[0].formula = 'A1:C1'; groups(wb)[0].dateFormula = 'LocalDates';
  wb.defineName('LocalDates', 'View!A8:C8', 'View');
  const src = { r1: 2, c1: 3, r2: 2, c2: 3 }, before = wb.toJSON();
  wb.placeMoved('data', 4, 5, wb.copyRange('view', src), { sheetId: 'view', range: src });
  expect(wb.sheet('data').sparklineGroups[0]).toMatchObject({ dateFormula: 'View!LocalDates', sparklines: [{ ref: 'F5', formula: 'View!A1:C1' }] });
  wb.undo(); expect(wb.toJSON()).toEqual(before);
});
it('keeps named series dependencies when exporting a single sheet', () => {
  const wb = make(); wb.defineName('SeriesValues', 'Data!A1:A3');
  groups(wb)[0].sparklines[0].formula = 'SeriesValues';
  const one = wb.sheetToWorkbook('view', { sourceWorkbook: '../Source.xlsx' });
  expect(one.names.some(name => name.name === 'SeriesValues')).toBe(true);
  expect(one.sheets[0].sparklineGroups[0].sparklines[0].formula).toBe('SeriesValues');
});

it('removes destinations on the last allocated line when deleting every line', () => {
  const wb = make();
  const sheet = wb.sheet('view');
  sheet.sparklineGroups[0].sparklines[0].ref = 'D' + sheet.rows;
  const before = wb.toJSON();
  wb.deleteRows('view', 0, sheet.rows);
  expect(groups(wb)).toEqual([]);
  wb.undo(); expect(wb.toJSON()).toEqual(before);
});
it('budgets history for sparkline-only sheets even when they have no stored cells', () => {
  const wb = new Workbook({ sheets: [{ id: 'sparks', name: 'Sparks', sparklineGroups: [{ sparklines: [{ ref: 'D3', formula: 'A1:C1' }, { ref: 'D5', formula: 'A2:C2' }] }] }] });
  wb._snapshotBudget = 1;
  for (let i = 0; i < 5; i++) wb.insertRows('sparks', 0, 1);
  expect(wb._history).toHaveLength(1);
  wb.undo(); expect(wb.canUndo()).toBe(false);
  expect(wb.sheet('sparks').sparklineGroups[0].sparklines[0].ref).toBe('D7');
  wb.redo(); expect(wb.sheet('sparks').sparklineGroups[0].sparklines[0].ref).toBe('D8');
});
it('exports filled native sparklines without relying on private workbook metadata', async () => {
  const wb = make();
  wb.fillDirection('view', { r1: 2, c1: 3, r2: 4, c2: 3 }, 'down');
  const expected = structuredClone(groups(wb));
  const loaded = await open(await save(wb));
  expect(loaded.sheets[1].sparklineGroups).toEqual(expected);
  expect(expected[0].sparklines.slice(2)).toEqual([
    { ref: 'D4', formula: 'Data!A2:A4' }, { ref: 'D5', formula: 'Data!A3:A5' },
  ]);
});
it('exports pasted native groups with distinct cross-sheet identities without private metadata', async () => {
  const wb = make(), cells = wb.copyCells('view', [2], [3]);
  const nativeSparklines = wb.copyNativeSparklines('view', [2], [3]);
  wb.pasteCells('view', cells, 8, 3, { r: 2, c: 3 }, null, { nativeSparklines });
  wb.pasteCells('data', cells, 8, 3, { r: 2, c: 3 }, null, { nativeSparklines });
  const expected = wb.sheets.map(s => structuredClone(s.sparklineGroups));
  expect(expected[0][0].uid).not.toBe(expected[1][0].uid);
  const loaded = await open(await save(wb));
  expect(loaded.sheets.map(s => s.sparklineGroups)).toEqual(expected);
});
it('exports packed cross-sheet cut destinations and source references natively', async () => {
  const wb = make();
  wb.transaction('Move cells', () => wb.moveNativeSparklinesFromCells('view', 'data', [2, 5], [3], 9, 4));
  const expected = wb.sheets.map(s => structuredClone(s.sparklineGroups));
  const loaded = await open(await save(wb));
  expect(loaded.sheets.map(s => s.sparklineGroups)).toEqual(expected);
  expect(expected[0][0].sparklines.map(s => s.ref)).toEqual(['E10', 'E11']);
});
it('round-trips scalar and named dependencies after a packed cut', async () => {
  const wb = make(); wb.setInput('view', 0, 0, '=Data!A3'); wb.defineName('PackedValue', 'Data!A3');
  const cells = wb.copyCells('data', [0, 2], [0]);
  wb.transaction('Move cells', () => {
    const carried = wb.preparePackedMoveCells('data', 'data', [0, 2], [0], 4, 3, cells);
    wb.setCells('data', [{ r: 0, c: 0, cell: null }, { r: 2, c: 0, cell: null }]);
    wb.pasteCells('data', carried, 4, 3, null);
    wb.moveNativeSparklinesFromCells('data', 'data', [0, 2], [0], 4, 3);
  });
  const loaded = await open(await save(wb));
  expect(loaded.getCell(loaded.sheets[1].id, 0, 0).f).toBe('Data!D6');
  expect(loaded.getValue(loaded.sheets[1].id, 0, 0)).toBe(3);
  expect(loaded.namedEntry('PackedValue').ref).toBe('Data!D6');
});
it('exports edited native settings and series bindings without private metadata', async () => {
  const wb = make();
  expect(wb.updateNativeSparkline('view', 'D3', { settings: { type: 'stacked', displayHidden: true, rightToLeft: true, colorSeries: { rgb: 'FFAA0033' }, minAxisType: 'custom', manualMin: -20 }, formula: 'Data!A1:A2' })).toBeNull();
  const expected = structuredClone(groups(wb));
  const loaded = await open(await save(wb)); expect(loaded.sheets[1].sparklineGroups).toEqual(expected);
  const copied = wb.copyNativeSparklines('view', [2], [3]); wb.pasteCells('view', wb.copyCells('view', [2], [3]), 8, 3, { r: 2, c: 3 }, null, { nativeSparklines: copied });
  expect(groups(wb)[0].sparklines.at(-1)).toEqual({ ref: 'D9', formula: 'Data!A7:A8' });
  expect(groups(wb)[0].colorSeries).toEqual({ rgb: 'FFAA0033' });
});
it('round-trips native groups after importing a block and copying its blank destination', async () => {
  const source = new Workbook({ sheets: [{ id: 'source', name: 'Original', cells: { '0,0': { v: 3 }, '0,1': { v: 7 } }, sparklineGroups: [{ sparklines: [{ ref: 'C1', formula: 'Original!A1:B1' }] }] }] });
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.placeSheetAt(id, source, 'source', 4, 2);
  const copied = wb.copyNativeSparklines(id, [4], [4]);
  wb.pasteCells(id, wb.copyCells(id, [4], [4]), 5, 4, { r: 4, c: 4 }, null, { nativeSparklines: copied });
  const loaded = await open(await save(wb));
  expect(loaded.sheets[0].sparklineGroups).toEqual(wb.sheet(id).sparklineGroups);
  expect(loaded.sheets[0].sparklineGroups[0].sparklines).toEqual([{ ref: 'E5', formula: 'C5:D5' }, { ref: 'E6', formula: 'C6:D6' }]);
});
it('exports the table rows and calculated formulas created by a native-only fill', async () => {
  const wb = new Workbook({ sheets: [{ id: 's', cells: { '0,0': { v: 'Trend' }, '0,1': { v: 'Calc' } }, sparklineGroups: [{ sparklines: [{ ref: 'A2', formula: 'D2:E2' }] }] }] });
  wb.addTable('s', { r1: 0, c1: 0, r2: 1, c2: 1 }, { name: 'Trends' });
  wb.setInput('s', 1, 1, '=ROW()*2'); wb.fillDirection('s', { r1: 1, c1: 0, r2: 3, c2: 0 }, 'down');
  const loaded = await open(await save(wb)), sheet = loaded.sheets[0];
  expect(sheet.tables[0].range).toEqual({ r1: 0, c1: 0, r2: 3, c2: 1 });
  expect(sheet.sparklineGroups).toEqual(wb.sheet('s').sparklineGroups);
  expect(loaded.getValue(sheet.id, 3, 1)).toBe(8);
  const copied = loaded.copyNativeSparklines(sheet.id, [3], [0]);
  loaded.pasteCells(sheet.id, loaded.copyCells(sheet.id, [3], [0]), 5, 0, { r: 3, c: 0 }, null, { nativeSparklines: copied });
  expect(sheet.sparklineGroups[0].sparklines.at(-1)).toEqual({ ref: 'A6', formula: 'D6:E6' });
});
it('exports cleared native groups without clearing scalar cells and keeps later copies empty', async () => {
  const wb = make();
  expect(wb.clearNativeSparklines('view', [{ r1: 2, r2: 2, c1: 3, c2: 3 }])).toBe(1);
  const partial = await open(await save(wb));
  expect(partial.sheets[1].sparklineGroups[0].sparklines).toEqual([{ ref: 'D6', formula: 'View!A6:C6' }]);
  expect(partial.getValue(partial.sheets[1].id, 2, 3)).toBe('Keep text');
  expect(wb.copyNativeSparklines('view', [2], [3]).groups).toEqual([]);
  expect(wb.clearNativeSparklines('view', [{ r1: 5, r2: 5, c1: 3, c2: 3 }], { groups: true })).toBe(1);
  const empty = await open(await save(wb)); expect(empty.sheets[1].sparklineGroups).toEqual([]);
  expect(empty.getValue(empty.sheets[1].id, 2, 3)).toBe('Keep text');
});
it('round-trips independent and regrouped native settings and copies their resulting membership', async () => {
  const wb = make();
  wb.regroupNativeSparklines('view', [{ r1: 2, r2: 2, c1: 3, c2: 3 }], { ungroup: true });
  wb.updateNativeSparkline('view', 'D3', { settings: { type: 'stacked' } });
  const split = await open(await save(wb));
  expect(split.sheets[1].sparklineGroups).toEqual(groups(wb));
  expect(groups(wb).find(g => g.sparklines[0].ref === 'D6').type).toBe('column');
  expect(wb.regroupNativeSparklines('view', [{ r1: 2, r2: 5, c1: 3, c2: 3 }], { templateRef: 'D3' })).toBeNull();
  const grouped = await open(await save(wb)); expect(grouped.sheets[1].sparklineGroups).toEqual(groups(wb));
  const copied = wb.copyNativeSparklines('view', [2], [3]);
  wb.pasteCells('view', wb.copyCells('view', [2], [3]), 8, 3, { r: 2, c: 3 }, null, { nativeSparklines: copied });
  expect(groups(wb)).toHaveLength(1); expect(groups(wb)[0].type).toBe('stacked'); expect(groups(wb)[0].sparklines).toHaveLength(3);
});

it('preserves per-member dynamic date names through grouping, native export and copying', async () => {
  const { nativeSparklineData } = await import('../src/core/native-sparkline-data.js');
  const wb = new Workbook({ names: [{ name: 'Dates', ref: 'OFFSET(Data!$A$4,0,0,1,ROW()+2)' }], sheets: [{ id: 's', name: 'Data',
    cells: { '0,0': { v: 1 }, '0,1': { v: 2 }, '0,2': { v: 3 }, '1,0': { v: 4 }, '1,1': { v: 5 }, '1,2': { v: 6 }, '1,3': { v: 7 },
      '3,0': { v: 45000 }, '3,1': { v: 45001 }, '3,2': { v: 45002 }, '3,3': { v: 45003 } },
    sparklineGroups: [
      { dateAxis: true, dateFormula: 'Dates', sparklines: [{ ref: 'E1', formula: 'A1:C1' }] },
      { sparklines: [{ ref: 'E2', formula: 'A2:D2' }] },
    ],
  }] });
  expect(wb.regroupNativeSparklines('s', [{ r1: 0, r2: 1, c1: 4, c2: 4 }], { templateRef: 'E1' })).toBeNull();
  const reopened = await open(await save(wb)), id = reopened.sheets[0].id;
  for (let r = 0; r < 2; r++) {
    expect(nativeSparklineData(reopened, id, r, 4)).toMatchObject({ unavailable: false, count: r + 3 });
    expect(nativeSparklineData(reopened, id, r, 4).points.map(p => p.x)).toEqual([45000, 45001, 45002, 45003].slice(0, r + 3));
  }
  const nativeSparklines = reopened.copyNativeSparklines(id, [1], [4]);
  reopened.pasteCells(id, reopened.copyCells(id, [1], [4]), 1, 6, { r: 1, c: 4 }, null, { nativeSparklines });
  expect(nativeSparklineData(reopened, id, 1, 6)).toMatchObject({ unavailable: false });
  expect(nativeSparklineData(reopened, id, 1, 6).points).toHaveLength(4);
  const copied = await open(await save(reopened));
  expect(copied.sheets[0].sparklineGroups).toEqual(reopened.sheets[0].sparklineGroups);
});

it('exports newly created native groups and preserves their live copy and settings behavior', async () => {
  const wb = make();
  expect(wb.createNativeSparklines('view', { source: 'Data!A1:A3', location: 'J1', type: 'stacked' })).toBeNull();
  const created = groups(wb).at(-1); expect(created.sparklines).toEqual([{ ref: 'J1', formula: 'Data!A1:A3' }]);
  const reopened = await open(await save(wb)), id = reopened.sheets[1].id;
  expect(reopened.sheets[1].sparklineGroups).toEqual(groups(wb));
  reopened.pasteCells(id, reopened.copyCells(id, [0], [9]), 1, 9, { r: 0, c: 9 }, null, { nativeSparklines: reopened.copyNativeSparklines(id, [0], [9]) });
  expect(reopened.sheets[1].sparklineGroups.at(-1).sparklines).toEqual([{ ref: 'J1', formula: 'Data!A1:A3' }, { ref: 'J2', formula: 'Data!A2:A4' }]);
  expect(reopened.updateNativeSparkline(id, 'J2', { settings: { type: 'column' } })).toBeNull();
  const copied = await open(await save(reopened)); expect(copied.sheets[1].sparklineGroups).toEqual(reopened.sheets[1].sparklineGroups);
});
