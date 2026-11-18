// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid, COL_HEADER_H } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';

const ROW = Math.round(DEFAULT_ROW_HEIGHT); // a default row on screen at 100%
const HALF_ROW = Math.round(DEFAULT_ROW_HEIGHT * 0.5); // a default row on screen at 50%

const grids = [];
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.isConnected ? 800 : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.isConnected ? 400 : 0; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function ({ left, top }) { if (this.isConnected) { this.scrollLeft = Math.max(0, left); this.scrollTop = Math.max(0, top); } };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { for (const grid of grids.splice(0)) grid.destroy(); document.body.replaceChildren(); });
const flush = () => new Promise(r => setTimeout(r, 10));
function create(sheet = {}, options = {}) {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 120, cols: 30, ...sheet }] });
  const grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {}, ...options });
  grids.push(grid);
  return { wb, grid, id: wb.activeSheetId };
}

it('restores only after mounting, independently of an offscreen active cell', async () => {
  const { wb, grid } = create({ viewOrigin: { r: 42, c: 5 }, viewSelection: { active: { r: 89, c: 10 }, ranges: [{ r1: 89, c1: 10, r2: 89, c2: 10 }] } });
  expect(grid.viewport.scrollTop).toBe(0);
  document.body.append(grid.el);
  await flush();
  expect(grid.viewport.scrollTop).toBe(42 * ROW);
  expect(grid.viewport.scrollLeft).toBe(5 * 100);
  expect(grid.active).toEqual({ r: 89, c: 10 });
  expect(wb.dirty).toBe(false); expect(wb.canUndo()).toBe(false);
  // The empty rows the file kept past a new sheet's size were given back when it was shown; the restoring scroll adds none.
  expect(wb.activeSheet.rows).toBe(100);
  grid.viewport.dispatchEvent(new Event('scroll'));
  expect(wb.activeSheet.rows).toBe(100);
});

it('uses hidden-line geometry and preserves the saved origin at another zoom', async () => {
  const { wb, grid } = create({ viewOrigin: { r: 20, c: 8 }, hiddenRows: [1, 3], hiddenCols: [2], rowHeights: { 5: 40 }, colWidths: { 4: 160 } });
  document.body.append(grid.el); await flush();
  // Origin row 20 lies past 18 visible rows (rows 1 and 3 are hidden): 17 default rows and row 5 at 40px.
  expect(grid.viewport.scrollTop).toBe(17 * ROW + 40);
  expect(grid.viewport.scrollLeft).toBe(7 * 100 + 60);
  grid.setZoom(0.5);
  expect(grid.viewport.scrollTop).toBe(17 * HALF_ROW + 20);
  expect(grid.viewport.scrollLeft).toBe(7 * 50 + 30);
  expect(wb.activeSheet.viewOrigin).toEqual({ r: 20, c: 8 });
});

it('renders offset frozen bands while restoring their independently scrolled pane', async () => {
  const { wb, grid, id } = create({ frozenRows: 3, frozenCols: 2, frozenOrigin: { r: 4, c: 3 }, viewOrigin: { r: 19, c: 7 } });
  document.body.append(grid.el); await flush();
  expect(grid.frozen).toEqual({ rows: 3, cols: 2 });
  expect(grid.viewport.scrollTop).toBe((19 - 4 - 3) * ROW);
  expect(grid.viewport.scrollLeft).toBe((7 - 3 - 2) * 100);
  const rows = [...grid.el.querySelectorAll('.grid-rowhead-frozen > .hcell[data-r]')].map(n => Number(n.dataset.r));
  expect(rows).toEqual([4, 5, 6]);
  grid.setSelection(S.single(4, 3));
  grid.beginEdit({ text: 'visible frozen cell' });
  const editor = grid.el.querySelector('.grid-editor');
  expect(editor.style.left).toBe('48px'); expect(editor.style.top).toBe(`${COL_HEADER_H}px`); // just below the column header
  grid.cancelEdit();
  wb.setFrozen(id, 0, 0); await flush();
  expect(grid.viewport.scrollTop).toBe(19 * ROW);
  expect(grid.viewport.scrollLeft).toBe(7 * 100);
  wb.undo(); await flush();
  expect(grid.frozen).toEqual({ rows: 3, cols: 2 });
  expect(grid.viewport.scrollTop).toBe(12 * ROW);
});

it('records scrolling and restores a sheet first visited later without changing selection', async () => {
  const { wb, grid } = create();
  const next = wb.addSheet('Later');
  wb.setSheetOrigin(next.id, { r: 23, c: 2 });
  document.body.append(grid.el); await flush();
  grid.viewport.scrollTop = 15 * ROW + 7;
  grid.viewport.dispatchEvent(new Event('scroll'));
  expect(wb.sheets[0].viewOrigin).toEqual({ r: 15, c: 0 });
  grid.setSheet(next.id); await flush();
  expect(grid.viewport.scrollTop).toBe(23 * ROW);
  expect(grid.active).toEqual({ r: 0, c: 0 });
  grid.setSheet(wb.sheets[0].id);
  expect(grid.viewport.scrollTop).toBe(15 * ROW + 7);
});

it('lets explicit navigation supersede a pending saved view', async () => {
  const { grid } = create({ viewOrigin: { r: 42, c: 5 } });
  document.body.append(grid.el);
  grid.selectByName('A1');
  await flush();
  expect(grid.viewport.scrollTop).toBe(0); expect(grid.viewport.scrollLeft).toBe(0);
});

it('restores a distant viewport with enough sparse grid to fill the window', async () => {
  const { wb, grid } = create({ viewOrigin: { r: 50000, c: 2000 }, defaultRowHeight: 1, defaultColWidth: 200 });
  document.body.append(grid.el); await flush();
  expect(wb.activeSheet.rows).toBe(50400);
  expect(wb.activeSheet.cols).toBe(2004);
  expect(wb.activeSheet.cells.size).toBe(0);
  expect(grid.viewport.scrollTop).toBe(50000);
  expect(grid.viewport.scrollLeft).toBe(400000);
  expect(wb.dirty).toBe(false); expect(wb.canUndo()).toBe(false);
});

it('keeps the scrolling pane origin when zoom rounds differently sized frozen lines', async () => {
  const { wb, grid } = create({ frozenRows: 3, frozenCols: 2, frozenOrigin: { r: 4, c: 3 }, viewOrigin: { r: 19, c: 7 },
    rowHeights: { 4: 27, 5: 29, 6: 31, 8: 37, 10: 43, 16: 33 }, colWidths: { 3: 101, 4: 103, 5: 107 } });
  document.body.append(grid.el); await flush();
  grid.setZoom(0.5);
  expect(wb.activeSheet.viewOrigin).toEqual({ r: 19, c: 7 });
});


it('does not change an offset frozen band when its drag handle is released in place', async () => {
  const changes = [];
  const { grid } = create({ frozenRows: 3, frozenCols: 2, frozenOrigin: { r: 4, c: 3 }, viewOrigin: { r: 19, c: 7 } },
    { onCommand: (command, dimensions) => changes.push({ command, dimensions }) });
  document.body.append(grid.el); await flush();
  for (const axis of ['h', 'v']) {
    const handle = grid.el.querySelector(`.freeze-bar.${axis}`);
    handle.setPointerCapture = () => {};
    handle.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
    handle.dispatchEvent(new MouseEvent('pointerup', { button: 0, bubbles: true }));
  }
  expect(changes).toEqual([{ command: 'freeze', dimensions: { rows: 3 } }, { command: 'freeze', dimensions: { cols: 2 } }]);
});

it('records the visible scrolling corner when a freeze change changes it without a scroll event', async () => {
  const { wb, grid, id } = create({ frozenRows: 3, frozenCols: 2, frozenOrigin: { r: 4, c: 3 }, viewOrigin: { r: 19, c: 7 } });
  document.body.append(grid.el); await flush();
  wb.setFrozen(id, 1, 2); await flush();
  expect(wb.activeSheet.frozenOrigin).toEqual({ r: 4, c: 3 });
  expect(wb.activeSheet.viewOrigin).toEqual({ r: 17, c: 7 });
});

it('uses the mounted viewport size when deciding which frozen bands fit during restoration', async () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.isConnected ? 1600 : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.isConnected ? 800 : 0; } });
  const { wb, grid } = create({ frozenRows: 15, frozenCols: 8, viewOrigin: { r: 30, c: 10 } });
  document.body.append(grid.el); await flush();
  expect(grid.frozen).toEqual({ rows: 15, cols: 8 });
  expect(grid.viewport.scrollTop).toBe(15 * ROW);
  expect(grid.viewport.scrollLeft).toBe(2 * 100);
  expect(wb.activeSheet.viewOrigin).toEqual({ r: 30, c: 10 });
});
