// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollBy = function scrollBy() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

const press = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'touch' }));
const heading = (grid, axis, i) => grid.el.querySelector(axis === 'col' ? `.grid-colhead .hcell[data-c="${i}"]` : `.grid-rowhead .hcell[data-r="${i}"]`);

function setup() {
  const wb = new Workbook();
  const menus = [];
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id, onContextMenu: (m) => menus.push(m) });
  document.body.replaceChildren(grid.el);
  vi.runOnlyPendingTimers();
  return { grid, menus };
}

// A touch screen has no right-click, and iOS sends no contextmenu event for a long press: the row and
// column menus (insert, delete, hide, width…) could not be opened by touch, while a cell's could.
describe('a long press on a row or column heading', () => {
  it('opens that line\'s menu once, whichever of the press timer and the browser\'s own contextmenu comes first', () => {
    const { grid, menus } = setup();
    const c = heading(grid, 'col', 2);
    press(c, 'pointerdown', 150, 10);
    vi.advanceTimersByTime(500);
    expect(menus).toEqual([{ x: 150, y: 10, kind: 'col' }]);
    expect(grid.range).toMatchObject({ c1: 2, c2: 2 });
    // Android also reports the press as a contextmenu: it opens nothing more.
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 10 }));
    press(c, 'pointerup', 150, 10);
    expect(menus).toHaveLength(1);
    // The browser's contextmenu coming first opens the menu, and the timer then opens no second one.
    vi.advanceTimersByTime(2000);
    const row = heading(grid, 'row', 4);
    press(row, 'pointerdown', 10, 100);
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 100 }));
    vi.advanceTimersByTime(500);
    press(row, 'pointerup', 10, 100);
    expect(menus.map((m) => m.kind)).toEqual(['col', 'row']);
    grid.destroy();
  });

  it('keeps the lines selected with it, so the menu acts on all of them', () => {
    const { grid, menus } = setup();
    grid.selectByName('C:E');
    press(heading(grid, 'col', 3), 'pointerdown', 230, 10);
    vi.advanceTimersByTime(500);
    expect(menus).toHaveLength(1);
    expect(grid.range).toMatchObject({ r1: 0, c1: 2, c2: 4 });
    grid.destroy();
  });

  it('opens nothing for a quick tap or a finger dragged along the headings', () => {
    const { grid, menus } = setup();
    const c = heading(grid, 'col', 2);
    press(c, 'pointerdown', 150, 10);
    vi.advanceTimersByTime(100);
    press(c, 'pointerup', 150, 10);
    vi.advanceTimersByTime(1000);
    press(c, 'pointerdown', 150, 10);
    press(c, 'pointermove', 260, 10);
    vi.advanceTimersByTime(1000);
    expect(menus).toEqual([]);
    grid.destroy();
  });
});
