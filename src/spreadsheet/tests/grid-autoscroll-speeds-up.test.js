// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

let scrolled = [];
beforeEach(() => {
  scrolled = [];
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollBy = function scrollBy(x, y) { scrolled.push([x, y]); };
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  Element.prototype.hasPointerCapture = function hasPointerCapture() { return false; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

// Dragging a selection past the edge of the grid scrolled the sheet 24px a tick however far past the edge
// the pointer went: selecting down to row 1,000 took some 40 seconds. As in Excel, the sheet now goes
// faster the farther out the pointer is.
it('scrolls faster the farther past the edge a drag goes', () => {
  const wb = new Workbook();
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id, announce() {} });
  document.body.replaceChildren(grid.el);
  const vp = grid.viewport;
  vp.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
  vi.advanceTimersByTime(5);
  const pe = (type, x, y) => vp.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'mouse' }));
  pe('pointerdown', 150, 50);
  pe('pointermove', 150, 410);
  vi.advanceTimersByTime(50);
  expect(scrolled.at(-1)).toEqual([0, 24]);
  pe('pointermove', 150, 480);
  vi.advanceTimersByTime(50);
  const far = scrolled.at(-1)[1];
  expect(far).toBeGreaterThan(24);
  pe('pointermove', 150, 900);
  vi.advanceTimersByTime(50);
  expect(scrolled.at(-1)[1]).toBeGreaterThan(far);
  expect(scrolled.at(-1)[1]).toBeLessThanOrEqual(200);
  // Past the left edge too, sideways only.
  pe('pointermove', -100, 200);
  vi.advanceTimersByTime(50);
  expect(scrolled.at(-1)[0]).toBeLessThan(-24);
  expect(scrolled.at(-1)[1]).toBe(0);
  pe('pointerup', -100, 200);
  grid.destroy();
});
