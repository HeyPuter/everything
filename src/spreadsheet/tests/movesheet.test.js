// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { openMoveSheetDialog } from '../src/ui/movesheet.js';
import { placeSheet } from '../src/core/sheet-placement.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: true })); });
afterEach(() => { closeAllModals(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const names = wb => wb.sheets.map(s => s.name);
const setup = () => new Workbook({ sheets: ['First', 'Hidden', 'Second', 'Third'].map(name => ({ name, hidden: name === 'Hidden' })) });
const dialog = () => document.querySelector('.modal-root:not(.closing) .modal-panel');

it.each([
  ['First', 'Third', ['Hidden', 'Second', 'First', 'Third']],
  ['Third', 'First', ['Third', 'First', 'Hidden', 'Second']],
  ['First', null, ['Hidden', 'Second', 'Third', 'First']],
])('moves %s before %s with exact undo and redo, retaining hidden sheets', (from, before, expected) => {
  const wb = setup();
  const original = wb.toJSON();
  wb.clearHistory();
  expect(placeSheet(wb, wb.sheetByName(from).id, { before: before && wb.sheetByName(before).id })).toBeTruthy();
  expect(names(wb)).toEqual(expected);
  expect(wb.activeSheet.name).toBe('First');
  const moved = wb.toJSON();
  wb.undo();
  expect(wb.toJSON()).toEqual(original);
  expect(wb.canUndo()).toBe(false);
  wb.redo();
  expect(wb.toJSON()).toEqual(moved);
});

it('copies before the source with self references, styles, names and unique tables in one undo step', () => {
  const wb = setup();
  const id = wb.activeSheetId;
  [['Item', 'Value'], ['Notebook', '12']].forEach((row, r) => row.forEach((value, c) => wb.setInput(id, r, c, value)));
  wb.addTable(id, parseRange('A1:B2'), { name: 'Supplies' });
  wb.setInput(id, 1, 3, '=First!B2*2');
  wb.applyStyle(id, parseRange('B2:D2'), { fmt: 'currency', bold: true, bg: '#ddeeff' });
  wb.defineName('Amount', 'First!$B$2', 'First');
  wb.setSheetProtected(id, true);
  const original = wb.toJSON();
  wb.clearHistory();
  const copy = placeSheet(wb, id, { before: id, copy: true });
  expect(names(wb).slice(0, 2)).toEqual(['First (2)', 'First']);
  expect(wb.activeSheetId).toBe(copy.id);
  expect(wb.getValue(copy.id, 1, 3)).toBe(24);
  expect(wb.getCell(copy.id, 1, 3).f).toContain("'First (2)'!B2");
  expect(wb.getDisplay(copy.id, 1, 3)).toBe('$24.00');
  expect(wb.styleAt(copy.id, 1, 3).bg).toBe('#ddeeff');
  expect(copy.protected).toBe(true);
  expect(copy.tables[0].name).not.toBe('Supplies');
  expect(wb.names.find(n => n.sheet === copy.name && n.name === 'Amount').ref).toContain(copy.name);
  const copied = wb.toJSON();
  wb.undo();
  expect(wb.toJSON()).toEqual(original);
  expect(wb.canUndo()).toBe(false);
  wb.redo();
  expect(wb.toJSON()).toEqual(copied);
});

it('keeps no-op and unavailable destinations from altering the workbook or history', () => {
  const wb = setup();
  const id = wb.activeSheetId;
  wb.clearHistory();
  const original = wb.toJSON();
  placeSheet(wb, id, { before: id });
  expect(wb.canUndo()).toBe(false);
  expect(placeSheet(wb, id, { before: 'missing', copy: true })).toBeNull();
  expect(placeSheet(wb, id, { before: wb.sheetByName('Hidden').id })).toBeNull();
  expect(placeSheet(wb, 'missing', { copy: true })).toBeNull();
  expect(wb.toJSON()).toEqual(original);
  expect(wb.canUndo()).toBe(false);
});

it('lists visible destinations, isolates draft changes and returns focus on Cancel', () => {
  const wb = setup();
  const grid = { focus: vi.fn() };
  const original = wb.toJSON();
  wb.clearHistory();
  openMoveSheetDialog({ wb, grid, doc: { name: 'Test book' } }, wb.activeSheetId);
  const list = dialog().querySelector('[aria-label="Before sheet"]');
  expect(list.size).toBe(8);
  expect([...list.options].map(o => o.textContent)).toEqual(['First', 'Second', 'Third', 'End of workbook']);
  expect(list.value).toBe(wb.activeSheetId);
  expect(document.activeElement).toBe(list);
  list.value = '';
  list.dispatchEvent(new Event('change'));
  dialog().querySelector('input[type="checkbox"]').click();
  expect(dialog().querySelector('[type="submit"]').textContent).toBe('Copy');
  [...dialog().querySelectorAll('button')].find(b => b.textContent === 'Cancel').click();
  expect(wb.toJSON()).toEqual(original);
  expect(wb.canUndo()).toBe(false);
  expect(grid.focus).toHaveBeenCalledOnce();
});

it('does not silently pick a new destination when a chosen sheet is removed', () => {
  const wb = setup();
  openMoveSheetDialog({ wb }, wb.activeSheetId);
  const list = dialog().querySelector('[aria-label="Before sheet"]');
  list.value = wb.sheetByName('Second').id;
  list.dispatchEvent(new Event('change'));
  wb.deleteSheet(list.value);
  expect(list.selectedIndex).toBe(-1);
  expect(dialog().querySelector('[type="submit"]').disabled).toBe(true);
  expect(dialog().textContent).toContain('Choose another destination');
  list.value = '';
  list.dispatchEvent(new Event('change'));
  expect(dialog().querySelector('[type="submit"]').disabled).toBe(false);
  wb.setSheetHidden(wb.activeSheetId, true);
  expect(dialog().querySelector('[type="submit"]').disabled).toBe(true);
  expect(dialog().textContent).toContain('This sheet is no longer available');
});

it('uses the existing cross-file copy workflow without moving the current sheet', () => {
  const wb = setup();
  const run = vi.fn();
  const original = wb.toJSON();
  openMoveSheetDialog({ wb, run }, wb.activeSheetId);
  [...dialog().querySelectorAll('button')].find(b => b.textContent === 'Copy to another spreadsheet…').click();
  expect(run).toHaveBeenCalledWith('copySheetTo', wb.activeSheetId);
  expect(wb.toJSON()).toEqual(original);
  expect(dialog()).toBeNull();
});

it('refuses to open if an unfinished edit cannot commit', () => {
  const wb = setup();
  const grid = { editing: true, commitEdit: vi.fn(() => false) };
  expect(openMoveSheetDialog({ wb, grid }, wb.activeSheetId)).toBeNull();
  expect(dialog()).toBeNull();
  expect(grid.commitEdit).toHaveBeenCalledOnce();
});

it('preserves a chart sheet and its drawing when copying before a worksheet', () => {
  const wb = new Workbook({ sheets: [{ name: 'Data', cells: { '0,0': { v: 12 } } },
    { name: 'Overview', kind: 'chart', charts: [{ type: 'column', title: 'Results', anchor: { r: 0, c: 0 }, w: 600, h: 300,
      range: parseRange('A1:A1'), sourceRefs: [{ name: 'Values', values: 'Data!$A$1' }] }] }] });
  const original = wb.toJSON();
  wb.clearHistory();
  const source = wb.sheets[1];
  const copy = placeSheet(wb, source.id, { before: wb.sheets[0].id, copy: true });
  expect(names(wb)).toEqual(['Overview (2)', 'Data', 'Overview']);
  expect(copy.kind).toBe('chart');
  expect(copy.charts[0]).toMatchObject({ title: 'Results', w: 600, h: 300, sourceRefs: source.charts[0].sourceRefs });
  expect(copy.charts[0].id).not.toBe(source.charts[0].id);
  wb.undo();
  expect(wb.toJSON()).toEqual(original);
  expect(wb.canUndo()).toBe(false);
});
