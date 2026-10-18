// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

const touch = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'touch' }));
const touchEnd = (target) => {
  const ev = new Event('touchend', { bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev.defaultPrevented;
};

function setup() {
  const wb = new Workbook();
  const menus = [];
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id, onContextMenu: (m) => menus.push(m), announce() {} });
  document.body.replaceChildren(grid.el);
  vi.runOnlyPendingTimers();
  return { grid, menus, viewport: grid.viewport };
}

// The cell menu opens under the finger while it is still held. Lifting it must not be taken as a tap:
// the browser's click for the release would land on whichever menu item is under the finger and run it.
it('the release of a long press that opened the cell menu sends no click', () => {
  const { grid, menus, viewport } = setup();
  const cell = viewport.querySelector('.cell') || viewport;
  touch(cell, 'pointerdown', 50, 13);
  vi.advanceTimersByTime(600);
  expect(menus).toHaveLength(1);
  touch(cell, 'pointerup', 50, 13);
  expect(touchEnd(cell)).toBe(true);
  grid.destroy();
});

it('a plain tap still ends as a tap', () => {
  const { grid, menus, viewport } = setup();
  const cell = viewport.querySelector('.cell') || viewport;
  touch(cell, 'pointerdown', 50, 13);
  vi.advanceTimersByTime(100);
  touch(cell, 'pointerup', 50, 13);
  expect(touchEnd(cell)).toBe(false);
  expect(menus).toHaveLength(0);
  // Nor does a tap after a long press inherit its release being held back.
  touch(cell, 'pointerdown', 50, 13);
  vi.advanceTimersByTime(600);
  touch(cell, 'pointerup', 50, 13);
  touchEnd(cell);
  touch(cell, 'pointerdown', 50, 13);
  vi.advanceTimersByTime(100);
  touch(cell, 'pointerup', 50, 13);
  expect(touchEnd(cell)).toBe(false);
  grid.destroy();
});
