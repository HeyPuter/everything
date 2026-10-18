// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Excel saves panes frozen while the sheet was scrolled with the pane's own first row and column (C5 here,
// two rows and one column frozen from there). Ctrl+Home counted the frozen lines from A1 instead, landing on
// B3, a cell above and left of the panes that is not drawn, so the cursor vanished and typing went nowhere
// to be seen; Home went to column B likewise. Both go to the first cell after the panes now, D7 and column D.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function ({ left, top }) { this.scrollLeft = left; this.scrollTop = top; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { document.body.replaceChildren(); });

function mount(sheet) {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 100, cols: 20, ...sheet }] });
  const grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} });
  document.body.append(grid.el);
  grid.viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
  const key = (k, init = {}) => grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  return { grid, key };
}

it('goes to the first cell after panes frozen from C5 with Ctrl+Home, and to their first column with Home', () => {
  const { grid, key } = mount({ frozenRows: 2, frozenCols: 1, frozenOrigin: { r: 4, c: 2 } });
  grid.selectByName('H30');
  key('Home', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 6, c: 3 });
  // On the screen, just past the frozen panes.
  const rect = grid.cellRect(6, 3);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  grid.selectByName('H30');
  key('Home');
  expect(grid.active).toEqual({ r: 29, c: 3 });
  grid.destroy();
});

it('still goes to the cell after panes frozen from A1', () => {
  const { grid, key } = mount({ frozenRows: 1, frozenCols: 2 });
  grid.selectByName('H30');
  key('Home', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 1, c: 2 });
  grid.destroy();
});
