// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';
import { createGrid } from '../src/ui/grid.js';
import { buildPrintRoot } from '../src/ui/print.js';
import { heightForLines, rowPad, wrapLines } from '../src/core/textfit.js';

const text = 'one two three four five six seven eight nine ten eleven twelve';
// The sheet's 19.5px default is a 13px line's row a little roomier, so its automatic rows carry that room too (rowPad).
const height = (value, width = 100, size = 13) => {
  const h = heightForLines(wrapLines(value, width - 5, s => s.length * 7).length, size, 0, rowPad(DEFAULT_ROW_HEIGHT, 13));
  return h === DEFAULT_ROW_HEIGHT ? h : Math.ceil(h); // stored rows take whole pixels
};
const flush = () => new Promise(resolve => setTimeout(resolve, 15));
let grids, glyphWidth, courierWide;
beforeEach(() => {
  grids = []; glyphWidth = 7; courierWide = false;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ font: '', measureText(s) { return { width: s.length * (courierWide && this.font.includes('Courier') ? 14 : glyphWidth) }; } });
  Element.prototype.scrollTo = function () {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { for (const grid of grids) grid.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function mount(wb) {
  const grid = createGrid({ wb, sheetId: wb.activeSheetId }); grids.push(grid);
  document.body.append(grid.el); await flush(); return grid;
}
const book = () => new Workbook({ sheets: [{ rowHeights: { 0: 24, 1: 160, 2: 24, 3: 160 },
  rowHeightModes: { 0: 'auto', 1: 'auto', 2: 'fixed', 3: 'fixed' },
  cells: Object.fromEntries([0, 1, 2, 3].map(r => [`${r},0`, { v: text, s: { wrap: true } }])) }] });

it('fits stale automatic caches both up and down on load without changing fixed heights or creating edits', async () => {
  const wb = book(), id = wb.activeSheetId, version = wb.version; wb.dirty = false;
  await mount(wb);
  expect([0, 1, 2, 3].map(r => wb.rowHeight(id, r))).toEqual([height(text), height(text), 24, 160]);
  expect(wb.version).toBe(version); expect(wb.dirty).toBe(false); expect(wb.canUndo()).toBe(false);
});

it('refits edits, formatting, column sizes, undo and manual resizing while retaining sizing mode', async () => {
  const wb = book(), id = wb.activeSheetId; await mount(wb);
  wb.setInput(id, 0, 0, 'short'); await flush(); expect(wb.rowHeight(id, 0)).toBe(height('short'));
  wb.undo(); await flush(); expect(wb.rowHeight(id, 0)).toBe(height(text));
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { size: 22 }); await flush();
  expect(wb.rowHeight(id, 0)).toBe(height(text, 100, 22));
  wb.undo(); await flush();
  wb.setColWidth(id, 0, 300); await flush();
  expect(wb.rowHeight(id, 0)).toBe(height(text, 300)); expect(wb.rowHeight(id, 2)).toBe(24);
  const fixed = wb.rowHeight(id, 0); wb.setRowHeight(id, 0, fixed);
  wb.setInput(id, 0, 0, text.repeat(5)); await flush(); expect(wb.rowHeight(id, 0)).toBe(fixed);
  wb.undo(); wb.undo(); await flush(); expect(wb.activeSheet.rowHeightModes.get(0)).toBe('auto');
});

it('reflows formula results after edits on another sheet and undo', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Display', rowHeightModes: { 2: 'auto' }, cells: { '2,0': { f: 'Input!A1', s: { wrap: true } } } }, { name: 'Input', cells: { '0,0': { v: 'short' } } }] });
  const id = wb.activeSheetId; await mount(wb);
  wb.setInput(wb.sheets[1].id, 0, 0, text); await flush(); expect(wb.rowHeight(id, 2)).toBe(height(text));
  wb.undo(); await flush(); expect(wb.rowHeight(id, 2)).toBe(height('short'));
});

it('keeps hidden automatic caches until shown and excludes merged cells from automatic sizing', async () => {
  const wb = new Workbook({ sheets: [{ hiddenRows: [0], rowHeights: { 0: 24, 2: 91 }, rowHeightModes: { 0: 'auto', 2: 'auto' },
    merges: [{ r1: 2, c1: 0, r2: 2, c2: 1 }], cells: { '0,0': { v: text, s: { wrap: true } }, '2,0': { v: text, s: { wrap: true } } } }] });
  const id = wb.activeSheetId; await mount(wb);
  expect(wb.activeSheet.rowHeights.get(0)).toBe(24); expect(wb.rowHeight(id, 2)).toBe(wb.activeSheet.defaultRowHeight);
  wb.setHidden(id, 'row', [0], false); await flush(); expect(wb.rowHeight(id, 0)).toBe(height(text));
});

it('fits unmerged cells alongside merges and discards both oversized and undersized automatic caches', async () => {
  const wb = new Workbook({ sheets: [{ rowHeights: { 0: 120, 1: 12, 2: 120, 3: 120 },
    rowHeightModes: { 0: 'auto', 1: 'auto', 2: 'auto', 3: 'fixed' },
    merges: [0, 1, 2, 3].map(r => ({ r1: r, r2: r, c1: 0, c2: 1 })),
    cells: { ...Object.fromEntries([0, 1, 2, 3].map(r => [`${r},0`, { v: text.repeat(3), s: { wrap: true, size: 40 } }])),
      '2,2': { v: 'Large', s: { size: 40 } } } }] });
  const id = wb.activeSheetId; await mount(wb);
  expect([0, 1, 2, 3].map(r => wb.rowHeight(id, r))).toEqual([DEFAULT_ROW_HEIGHT, DEFAULT_ROW_HEIGHT, Math.ceil(heightForLines(1, 40, 0, rowPad(DEFAULT_ROW_HEIGHT, 13))), 120]);
});

it('batches sparse automatic rows instead of rescanning the whole sheet for every row', async () => {
  const cells = {}, modes = {};
  for (let r = 0; r < 4000; r++) { cells[`${r},0`] = { v: text, s: { wrap: true } }; if (r % 37 === 0) modes[r] = 'auto'; }
  const wb = new Workbook({ sheets: [{ rows: 4100, cols: 1000, cells, rowHeightModes: modes }] });
  const spy = vi.spyOn(wb, 'getValue'); await mount(wb);
  expect(spy.mock.calls.length).toBeLessThan(1000);
  const previous = spy.mock.calls.length;
  wb.setInput(wb.activeSheetId, 37, 0, 'short'); await flush();
  expect(spy.mock.calls.length - previous).toBeLessThan(300);
});

it('measures automatic rows when printing sheets that have never been opened in a grid', () => {
  const wb = book(), version = wb.version; wb.dirty = false;
  const root = buildPrintRoot(wb, wb.activeSheetId, 'Height modes', { area: 'workbook', fit: 'actual' });
  expect(root.querySelector('.print-table')).not.toBeNull();
  expect(wb.rowHeight(wb.activeSheetId, 0)).toBe(height(text));
  expect(wb.rowHeight(wb.activeSheetId, 2)).toBe(24);
  expect(wb.version).toBe(version); expect(wb.dirty).toBe(false);
});

it('uses the same custom table font for automatic heights in the grid and print', async () => {
  courierWide = true;
  const wb = new Workbook({ sheets: [{ rowHeightModes: { 0: 'auto' }, cells: { '0,0': { v: text, s: { wrap: true } }, '1,0': { v: 1 } },
    tables: [{ name: 'Items', range: { r1: 0, c1: 0, r2: 1, c2: 0 }, style: 'custom', customStyle: { headerRow: { font: 'courier' } } }] }] });
  const id = wb.activeSheetId;
  const expected = Math.ceil(heightForLines(wrapLines(text, 95, s => s.length * 14).length, 13, 0, rowPad(DEFAULT_ROW_HEIGHT, 13)));
  buildPrintRoot(wb, id, 'Table font', { fit: 'actual' });
  expect(wb.rowHeight(id, 0)).toBe(expected);
  await mount(wb);
  expect(wb.rowHeight(id, 0)).toBe(expected);
});

it('does not remeasure automatic cells for view-only changes', async () => {
  const wb = book(); await mount(wb);
  const measure = vi.spyOn(wb, 'cacheAutoRowHeights');
  wb.setSheetView(wb.activeSheetId, { viewZoom: 1.5 }); await flush();
  expect(measure).not.toHaveBeenCalled();
});

it('refreshes automatic layout when a requested font becomes available', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
  const fonts = new EventTarget(); Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  try {
    const wb = book(), id = wb.activeSheetId; await mount(wb);
    const before = wb.rowHeight(id, 0), version = wb.version;
    glyphWidth = 14; fonts.dispatchEvent(new Event('loadingdone')); await flush();
    expect(wb.rowHeight(id, 0)).toBeGreaterThan(before);
    expect(wb.rowHeight(id, 2)).toBe(24); expect(wb.version).toBe(version);
  } finally {
    glyphWidth = 7; fonts.dispatchEvent(new Event('loadingdone'));
    if (descriptor) Object.defineProperty(document, 'fonts', descriptor); else delete document.fonts;
  }
});

it.each([['Arial', 6, 8], ['Courier New', 12, 28]])('uses Normal %s %spt indentation for automatic grid and print heights', async (name, sz, unit) => {
  const wb = new Workbook({ normalFont: { name, sz }, sheets: [{ rowHeightModes: { 0: 'auto' }, cells: {
    '0,0': { v: text, s: { font: 'arial', size: 13, indent: 2, wrap: true } },
  } }] });
  const id = wb.activeSheetId;
  const expected = heightForLines(wrapLines(text, 95 - 2 * unit, s => s.length * 7).length, 13);
  buildPrintRoot(wb, id, 'Normal indentation', { fit: 'actual' });
  expect(wb.rowHeight(id, 0)).toBe(expected);
  await mount(wb);
  expect(wb.rowHeight(id, 0)).toBe(expected);
  expect(wb.canUndo()).toBe(false);
});


it.each([48, 90])('fits automatic content below a %spx sheet default, retaining empty/merged defaults and fixed rows', async defaultRowHeight => {
  const wb = new Workbook({ sheets: [{ defaultRowHeight,
    rowHeights: { 0: 160, 1: 12, 2: 160, 3: 160, 4: 72 },
    rowHeightModes: { 0: 'auto', 1: 'auto', 2: 'auto', 3: 'auto', 4: 'fixed' },
    merges: [{ r1: 3, c1: 0, r2: 3, c2: 1 }],
    cells: { '0,0': { v: 'Short', s: { wrap: true } }, '0,1': { v: 'Tall', s: { size: 20 } },
      '1,0': { v: 'Short' }, '3,0': { v: text, s: { wrap: true, size: 40 } }, '4,0': { v: 'Fixed' } },
  }] });
  const id = wb.activeSheetId, version = wb.version; wb.dirty = false;
  const expected = [heightForLines(1, 20), heightForLines(1, 13), defaultRowHeight, defaultRowHeight, 72];
  buildPrintRoot(wb, id, 'Automatic heights', { fit: 'actual' });
  expect([0, 1, 2, 3, 4].map(r => wb.rowHeight(id, r))).toEqual(expected);
  await mount(wb);
  expect([0, 1, 2, 3, 4].map(r => wb.rowHeight(id, r))).toEqual(expected);
  expect(wb.version).toBe(version); expect(wb.dirty).toBe(false); expect(wb.canUndo()).toBe(false);
  wb.setInput(id, 1, 0, ''); await flush();
  expect(wb.rowHeight(id, 1)).toBe(defaultRowHeight);
  wb.undo(); await flush(); expect(wb.rowHeight(id, 1)).toBe(heightForLines(1, 13));
});
