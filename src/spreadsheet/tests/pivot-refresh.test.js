// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { buildPivot, refreshPivot, refreshablePivotSheets, pivotDefinitionState, namesWithPivotDefinition } from '../src/core/pivot.js';
import { insertPivotSheet } from '../src/ui/pivotdialog.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// A pivot table built from the PivotTable dialog is a block of live formulas, so it followed its source's values but
// not categories added since: a new region's rows were left out of the table and its totals, and nothing short of
// building the pivot again took them in. Excel refreshes a PivotTable (Alt+F5, Refresh All). The definition now stays
// with the pivot's sheet, and Refresh and Refresh All build it again in place, as one undo step.
beforeEach(() => { vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

function book({ table = false } = {}) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Product', 'Units'], ['East', 'Pens', '5'], ['West', 'Ink', '3'], ['East', 'Ink', '2'], ['West', 'Pens', '4']]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  if (table) wb.addTable(id, { r1: 0, c1: 0, r2: 4, c2: 2 }, { name: 'Sales' });
  return { wb, id };
}
function pivot(wb, id, spec) {
  insertPivotSheet(wb, id, buildPivot(wb, id, { range: { r1: 0, c1: 0, r2: 4, c2: 2 }, rowField: 0, colField: null, valueField: 2, agg: 'sum', filters: [], ...spec }));
  return wb.sheets.at(-1);
}
const grid = (wb, sheet, rows = 6, cols = 2) => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => wb.getValue(sheet.id, r, c)));

it('takes in a category added to the source, as one undo step', () => {
  const { wb, id } = book();
  const p = pivot(wb, id);
  expect(grid(wb, p, 4)).toEqual([['Region', 'Sum of Units'], ['East', 7], ['West', 7], ['Total', 14]]);
  wb.insertRows(id, 3, 1);
  wb.setInput(id, 3, 0, 'North'); wb.setInput(id, 3, 1, 'Ink'); wb.setInput(id, 3, 2, '10');
  expect(grid(wb, p, 4)).toEqual([['Region', 'Sum of Units'], ['East', 7], ['West', 7], ['Total', 14]]); // the new region is left out
  expect(refreshablePivotSheets(wb)).toEqual([p.id]);
  expect(refreshPivot(wb, p.id)).toEqual({ rows: 3 });
  expect(grid(wb, p, 5)).toEqual([['Region', 'Sum of Units'], ['East', 7], ['North', 10], ['West', 7], ['Total', 24]]);
  expect(wb.undoLabels()[0]).toBe('Refresh PivotTable');
  wb.undo();
  expect(grid(wb, p, 5)).toEqual([['Region', 'Sum of Units'], ['East', 7], ['West', 7], ['Total', 14], [null, null]]);
});

it('keeps the value picked in its filter, and a source table grown since', () => {
  const { wb, id } = book({ table: true });
  const p = pivot(wb, id, { rowField: 1, filters: [{ field: 0, value: null }] });
  wb.setInput(p.id, 0, 1, 'West');
  wb.setInput(id, 5, 0, 'West'); wb.setInput(id, 5, 1, 'Clips'); wb.setInput(id, 5, 2, '6'); // the table takes the row in
  expect(refreshPivot(wb, p.id)).toEqual({ rows: 3 });
  expect(wb.getValue(p.id, 0, 1)).toBe('West');
  expect(grid(wb, p, 7).slice(2)).toEqual([['Product', 'Sum of Units'], ['Clips', 6], ['Ink', 3], ['Pens', 4], ['Total', 13]]);
  expect(wb.sheet(p.id).validations.filter((v) => v.type === 'list')).toHaveLength(1);
});

it('rebuilds in place after rows are inserted above it, and asks before covering cells beside it', () => {
  const { wb, id } = book();
  const p = pivot(wb, id);
  wb.insertRows(p.id, 0, 2);
  wb.setInput(p.id, 0, 0, 'My notes');
  wb.setInput(id, 5, 0, 'North'); wb.setInput(id, 5, 2, '1'); // below the source range: not taken in
  wb.insertRows(id, 2, 1); wb.setInput(id, 2, 0, 'South'); wb.setInput(id, 2, 2, '8'); // inside it: taken in
  wb.setInput(p.id, 6, 0, 'Below');
  expect(refreshPivot(wb, p.id)).toMatchObject({ overwrite: true });
  expect(wb.getValue(p.id, 6, 0)).toBe('Below');
  expect(refreshPivot(wb, p.id, { force: true })).toEqual({ rows: 3 });
  expect(grid(wb, p, 8)).toEqual([['My notes', null], [null, null], ['Region', 'Sum of Units'], ['East', 7], ['South', 8], ['West', 7], ['Total', 22], [null, null]]);
});

it('refreshes after the file is saved and opened again', async () => {
  const { wb, id } = book();
  pivot(wb, id);
  const blob = await workbookToXlsx(wb);
  const back = await workbookFromFile(new Uint8Array(await blob.arrayBuffer()), 'Pivot.xlsx');
  const data = back.sheets[0], p = back.sheets[1];
  back.insertRows(data.id, 3, 1); back.setInput(data.id, 3, 0, 'North'); back.setInput(data.id, 3, 2, '10');
  expect(refreshablePivotSheets(back)).toEqual([p.id]);
  expect(refreshPivot(back, p.id)).toEqual({ rows: 3 });
  expect(back.getValue(p.id, 2, 0)).toBe('North');
  expect(back.getValue(p.id, 4, 1)).toBe(24);
});

it('runs from Data ▸ Refresh All', async () => {
  const { editorView } = await import('../src/views/editor.js');
  const { Doc } = await import('../src/lib/doc.js');
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Pivot' });
  const { wb } = doc, id = wb.activeSheetId;
  [['Region', 'Product', 'Units'], ['East', 'Pens', '5'], ['West', 'Ink', '3'], ['East', 'Ink', '2'], ['West', 'Pens', '4']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const p = pivot(wb, id);
  wb.insertRows(id, 3, 1); wb.setInput(id, 3, 0, 'North'); wb.setInput(id, 3, 2, '10');
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await view.run('refreshAll');
  expect(wb.getValue(p.id, 2, 0)).toBe('North');
  view.destroy();
});

// The definition outlives the table: a block cleared and given other data, or typed over, is not the pivot any more,
// and Refresh All must not write a deleted pivot back over it. Refresh rewrites only a block that still holds what the
// last build wrote; Refresh All passes over the others, and Refresh asks first.
it('leaves a cleared or typed-over block alone', () => {
  const { wb, id } = book();
  const p = pivot(wb, id);
  wb.clearRange(p.id, { r1: 0, c1: 0, r2: 3, c2: 1 });
  wb.setInput(p.id, 0, 0, 'My own'); wb.setInput(p.id, 1, 0, 'data');
  expect(pivotDefinitionState(wb, p.id)).toBe('changed');
  expect(refreshablePivotSheets(wb)).toEqual([]);
  expect(refreshPivot(wb, p.id)).toMatchObject({ changed: true });
  expect(grid(wb, p, 3)).toEqual([['My own', null], ['data', null], [null, null]]);
  expect(refreshPivot(wb, p.id, { replaceChanged: true })).toEqual({ rows: 2 }); // only when asked
  expect(wb.getValue(p.id, 1, 0)).toBe('East');

  const typed = pivot(wb, id);
  wb.setInput(typed.id, 1, 1, '99'); // a value over one of the table's formulas
  expect(pivotDefinitionState(wb, typed.id)).toBe('changed');
  expect(refreshablePivotSheets(wb)).toEqual([p.id]);
  wb.undo();
  expect(pivotDefinitionState(wb, typed.id)).toBe('intact');
});

it('adds and removes the definition with the table on undo and redo, one per sheet', () => {
  const { wb, id } = book();
  const count = () => wb.names.filter((n) => n.hidden).length;
  const p = pivot(wb, id);
  expect(count()).toBe(3);
  wb.undo();
  expect(count()).toBe(0);
  wb.redo();
  expect(count()).toBe(3);
  const again = buildPivot(wb, id, { range: { r1: 0, c1: 0, r2: 4, c2: 2 }, rowField: 1, colField: null, valueField: 2, agg: 'sum', filters: [] });
  expect(namesWithPivotDefinition(wb, id, again, wb.sheets.at(-1).name, { r1: 0, c1: 0, r2: 3, c2: 1 }).filter((n) => n.hidden)).toHaveLength(3);
  expect(pivotDefinitionState(wb, wb.sheets.at(-1).id)).toBe('intact');
  expect(wb.sheets.at(-1).id).toBe(p.id);
});

it('asks before Refresh rewrites a changed block, and Refresh All passes it over', async () => {
  const { editorView } = await import('../src/views/editor.js');
  const { Doc } = await import('../src/lib/doc.js');
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Pivot' });
  const { wb } = doc, id = wb.activeSheetId;
  [['Region', 'Product', 'Units'], ['East', 'Pens', '5'], ['West', 'Ink', '3'], ['East', 'Ink', '2'], ['West', 'Pens', '4']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const p = pivot(wb, id);
  wb.clearRange(p.id, { r1: 0, c1: 0, r2: 3, c2: 1 });
  wb.setInput(p.id, 0, 0, 'Mine');
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await view.run('refreshAll');
  expect(wb.getValue(p.id, 0, 0)).toBe('Mine');
  wb.setActiveSheet(p.id);
  await new Promise((r) => setTimeout(r, 0));
  const asked = view.run('refreshQuery');
  await new Promise((r) => setTimeout(r, 0));
  const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  expect(dialog.textContent).toMatch(/cleared or changed since it was built/);
  [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
  await asked;
  expect(wb.getValue(p.id, 0, 0)).toBe('Mine');
  view.destroy();
});
