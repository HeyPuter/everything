// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

let scrolls;
beforeEach(() => {
  scrolls = [];
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  // The viewport ends partway down a row, as it usually does: that row is only partly in view.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 390; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo(o) { scrolls.push(o); };
  Element.prototype.setPointerCapture = function () {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

const contextmenu = (target, x, y) => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
const touch = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'touch' }));

function setup() {
  const wb = new Workbook();
  const menus = [];
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id, onContextMenu: (m) => menus.push(m), announce() {} });
  document.body.replaceChildren(grid.el);
  vi.runOnlyPendingTimers();
  scrolls.length = 0;
  return { grid, menus, viewport: grid.viewport };
}

// The menu opens where the pointer is and closes as soon as the sheet scrolls under it: selecting a
// partly visible cell for its menu must not scroll it into view, or the menu shuts the moment it opens.
it('right-clicking a partly visible cell selects it without scrolling the sheet', () => {
  const { grid, menus, viewport } = setup();
  contextmenu(viewport, 50, 388);
  expect(menus).toHaveLength(1);
  expect(grid.active.r).toBeGreaterThan(0);
  expect(grid.active.c).toBe(0);
  expect(scrolls).toEqual([]);
  grid.destroy();
});

it('a long press on a partly visible cell selects it without scrolling the sheet', () => {
  const { grid, menus, viewport } = setup();
  touch(viewport, 'pointerdown', 50, 388);
  vi.advanceTimersByTime(600);
  expect(menus).toHaveLength(1);
  expect(grid.active.r).toBeGreaterThan(0);
  expect(scrolls).toEqual([]);
  touch(viewport, 'pointerup', 50, 388);
  grid.destroy();
});

it('a plain click on the same cell still brings it into view', () => {
  const { grid, viewport } = setup();
  viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 50, clientY: 388, pointerId: 1, button: 0, pointerType: 'mouse' }));
  expect(scrolls.length).toBeGreaterThan(0);
  viewport.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: 50, clientY: 388, pointerId: 1, button: 0, pointerType: 'mouse' }));
  grid.destroy();
});
