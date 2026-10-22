// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as notifications from '../src/ui/toast.js';
import { DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';

// Commands that take one range (sort, filter, table, chart, subtotals, banding, merge across or
// down, insert rows or columns, the selection as CSV, paste) read `grid.range`, the last range of a
// Ctrl/Cmd+click selection, and acted on it alone without a word: C1:C3 sorted while A1:A3 stayed,
// a paste landed in the last range. These commands now refuse a multiple
// selection, with a notice. Select cells of a kind searches every range instead.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const ROW = Math.round(DEFAULT_ROW_HEIGHT); // a default row on screen at 100%
const item = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);
const column = (wb, id, c, n) => Array.from({ length: n }, (_, r) => wb.getValue(id, r, c));

async function open(cells) {
  const doc = new Doc({ name: 'Ranges', path: 'Spreadsheets/Ranges.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  for (const [r, c, text] of cells) wb.setInput(id, r, c, text);
  wb.clearHistory();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  const pe = (type, r, c, init = {}) => viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: c * 100 + 50, clientY: r * ROW + ROW / 2, pointerId: 7, button: 0, pointerType: 'mouse', ...init }));
  const select = async (first, ...more) => {
    view.goTo(`Sheet1!${first}`);
    await vi.advanceTimersByTimeAsync(1);
    for (const rg of more) {
      pe('pointerdown', rg.r1, rg.c1, { ctrlKey: true, metaKey: true });
      if (rg.r2 !== rg.r1 || rg.c2 !== rg.c1) pe('pointermove', rg.r2, rg.c2, { ctrlKey: true, metaKey: true });
      pe('pointerup', rg.r2, rg.c2, { ctrlKey: true, metaKey: true });
    }
    await vi.advanceTimersByTimeAsync(1);
    viewport.focus();
    expect(view.el.querySelector('.status-left .status-item').textContent.split(', ')).toHaveLength(more.length + 1);
  };
  const menu = async (...path) => {
    view.el.querySelector(`[data-menu="${path[0]}"]`).click();
    for (const label of path.slice(1)) { item(label).click(); await vi.advanceTimersByTimeAsync(1); }
  };
  const toast = vi.spyOn(notifications, 'toast');
  const ranges = () => view.el.querySelector('.status-left .status-item').textContent.split(', ');
  return { wb, id, viewport, select, menu, toast, ranges };
}

const A = ['b', 'a', 'c'];
const C = ['z', 'y', 'x'];
const cells = [...A.map((v, r) => [r, 0, v]), ...C.map((v, r) => [r, 2, v])];
const refused = (toast, what) => toast.mock.calls.some(([msg]) => msg === `Select one range to ${what}`);

it('refuses to sort, filter, band, subtotal or tabulate several ranges, and says so', async () => {
  const { wb, id, select, menu, toast } = await open(cells);
  await select('A1:A3', { r1: 0, c1: 2, r2: 2, c2: 2 });
  await menu('data', 'Sort', 'Sort range A to Z');
  expect(refused(toast, 'sort')).toBe(true);
  expect(column(wb, id, 2, 3)).toEqual(C);
  expect(column(wb, id, 0, 3)).toEqual(A);
  await menu('data', 'Filter');
  expect(refused(toast, 'create a filter')).toBe(true);
  expect(wb.sheet(id).filter).toBeFalsy();
  await menu('data', 'Create table…');
  expect(refused(toast, 'create a table')).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await menu('format', 'Alternating colors');
  expect(refused(toast, 'add alternating colors')).toBe(true);
  expect(wb.sheet(id).rules?.length || 0).toBe(0);
  // Ranges over the same rows chart together, as in Excel (chart-multiple-ranges.test.js).
  await menu('insert', 'Chart…');
  expect(refused(toast, 'insert a chart')).toBe(false);
  expect(document.querySelector('[role="dialog"][aria-label="Insert Chart"]')).not.toBeNull();
  closeAllModals(); await vi.advanceTimersByTimeAsync(1000);
  await menu('data', 'Subtotals…');
  expect(refused(toast, 'add subtotals')).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(wb.undoLabels()).toEqual([]);
});

it('refuses to merge across or down, insert rows or columns, or export several ranges', async () => {
  const { wb, id, select, menu, toast } = await open(cells);
  await select('A1:B3', { r1: 0, c1: 3, r2: 2, c2: 4 });
  await menu('format', 'Merge cells', 'Merge horizontally');
  expect(refused(toast, 'merge')).toBe(true);
  expect(wb.sheet(id).merges).toHaveLength(0);
  await menu('insert', 'Rows and columns', 'Row above');
  expect(refused(toast, 'insert rows')).toBe(true);
  expect(column(wb, id, 0, 3)).toEqual(A);
  await menu('insert', 'Rows and columns', 'Column left');
  expect(refused(toast, 'insert columns')).toBe(true);
  expect(column(wb, id, 2, 3)).toEqual(C);
  await menu('file', 'Download', 'Selection as .csv');
  expect(refused(toast, 'export the selection')).toBe(true);
  expect(wb.undoLabels()).toEqual([]);
});

it('refuses to paste into several ranges, from the keyboard and the menu, and leaves the selection as it was', async () => {
  const { wb, id, viewport, select, menu, toast, ranges } = await open(cells);
  await select('A1', { r1: 0, c1: 3, r2: 0, c2: 3 });
  const before = ranges();
  const data = { getData: (type) => (type === 'text/plain' ? 'pasted' : ''), files: [] };
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: data });
  viewport.dispatchEvent(e);
  await vi.advanceTimersByTimeAsync(1);
  expect(refused(toast, 'paste into')).toBe(true);
  expect(wb.getValue(id, 0, 3)).toBeNull();
  expect(wb.getValue(id, 0, 0)).toBe('b');
  expect(ranges()).toEqual(before);
  await menu('edit', 'Paste');
  await vi.advanceTimersByTimeAsync(1500);
  expect(toast.mock.calls.filter(([msg]) => msg === 'Select one range to paste into')).toHaveLength(2);
  expect(wb.getValue(id, 0, 3)).toBeNull();
  expect(wb.undoLabels()).toEqual([]);
});

it('selects cells of a kind within every selected range', async () => {
  const { select, menu, toast, ranges } = await open([[0, 0, 'b'], [2, 0, 'c'], [0, 2, 'z'], [1, 2, 'y']]);
  await select('A1:A3', { r1: 0, c1: 2, r2: 2, c2: 2 });
  await menu('edit', 'Select', 'Blank cells');
  expect(toast).toHaveBeenCalledWith('Selected 2 cells: blank cells', expect.anything());
  expect(ranges()).toEqual(['A2', 'C3']);
});

// Seven more commands read `grid.range` alone — the last range of a Ctrl/Cmd+click selection — and acted on
// it without a word: Resize rows even counted only its lines in the dialog. They follow the same rule now,
// except Fit rows to content, which fits every selected range as Fit columns to content already did.
describe('the commands 36a9880 missed', () => {
  it('refuses to resize rows or columns, and says how many it would have resized', async () => {
    const { wb, id, select, menu, toast } = await open(cells);
    await select('A1:A2', { r1: 5, c1: 0, r2: 6, c2: 0 });
    await menu('format', 'Rows and columns', 'Resize rows…');
    expect(refused(toast, 'resize rows')).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await menu('format', 'Rows and columns', 'Resize columns…');
    expect(refused(toast, 'resize columns')).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(wb.rowHeight(id, 0)).toBe(wb.rowHeight(id, 5));
    expect(wb.undoLabels()).toEqual([]);
  });

  it('refuses to group or ungroup several ranges', async () => {
    const { wb, id, select, menu, toast } = await open(cells);
    await select('A1:A3', { r1: 0, c1: 3, r2: 2, c2: 3 });
    await menu('view', 'Group', 'Group columns');
    expect(refused(toast, 'group rows or columns')).toBe(true);
    expect(wb.outlineGroups(id, 'col')).toEqual([]);
    await menu('view', 'Group', 'Ungroup columns');
    expect(refused(toast, 'ungroup rows or columns')).toBe(true);
    expect(wb.undoLabels()).toEqual([]);
  });

  it('refuses to freeze up to a selection of several ranges', async () => {
    const { wb, id, select, menu, toast } = await open(cells);
    await select('A1:A2', { r1: 5, c1: 0, r2: 6, c2: 0 });
    await menu('view', 'Freeze', 'Rows up to the selection');
    expect(refused(toast, 'freeze rows')).toBe(true);
    expect(wb.sheet(id).frozenRows).toBe(0);
    await menu('view', 'Freeze', 'Columns up to the selection');
    expect(refused(toast, 'freeze columns')).toBe(true);
    expect(wb.sheet(id).frozenCols).toBe(0);
  });

  it('refuses to paint formatting onto several ranges, and keeps the painter armed', async () => {
    const { wb, id, select, menu, toast } = await open(cells);
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
    await select('A1');
    await menu('format', 'Paint format');
    await select('B1:B3', { r1: 0, c1: 3, r2: 2, c2: 3 });
    await menu('format', 'Paint format');
    expect(refused(toast, 'paint formatting onto')).toBe(true);
    expect(wb.getCell(id, 0, 1)?.s?.bold).toBeUndefined();
    expect(wb.getCell(id, 0, 3)?.s?.bold).toBeUndefined();
    // Still armed: one range picked now is painted.
    await select('B1');
    await menu('format', 'Paint format');
    expect(wb.getCell(id, 0, 1).s.bold).toBe(true);
  });

  it('refuses AutoSum over several ranges rather than summing the last one', async () => {
    const { wb, id, select, menu, toast } = await open([[0, 0, '1'], [1, 0, '2'], [0, 2, '10'], [1, 2, '20']]);
    await select('A1:A2', { r1: 0, c1: 2, r2: 1, c2: 2 });
    await menu('insert', 'Function', 'AutoSum');
    expect(refused(toast, 'insert a function')).toBe(true);
    expect(wb.getValue(id, 2, 0)).toBeNull();
    expect(wb.getValue(id, 2, 2)).toBeNull();
    expect(wb.undoLabels()).toEqual([]);
  });

  it('fits the rows of every selected range, not the last one alone', async () => {
    const { wb, id, select, menu } = await open([[0, 0, 'one\ntwo\nthree'], [5, 0, 'one\ntwo\nthree']]);
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { wrap: true });
    wb.applyStyle(id, { r1: 5, c1: 0, r2: 5, c2: 0 }, { wrap: true });
    const plain = wb.rowHeight(id, 2);
    await select('A1', { r1: 5, c1: 0, r2: 5, c2: 0 });
    await menu('format', 'Rows and columns', 'Fit rows to content');
    expect(wb.rowHeight(id, 0)).toBeGreaterThan(plain);
    expect(wb.rowHeight(id, 5)).toBeGreaterThan(plain);
    // One undo step puts both back.
    expect(wb.undoLabels()[0]).toBe('Fit rows');
    wb.undo();
    expect([wb.rowHeight(id, 0), wb.rowHeight(id, 5)]).toEqual([plain, plain]);
  });
});

it('still runs them on a single range', async () => {
  const { wb, id, select, menu, toast } = await open(cells);
  await select('A1:A3');
  await menu('data', 'Sort', 'Sort range A to Z');
  expect(toast).toHaveBeenCalledWith('Sorted A to Z');
  expect(column(wb, id, 0, 3)).toEqual(['a', 'b', 'c']);
});
