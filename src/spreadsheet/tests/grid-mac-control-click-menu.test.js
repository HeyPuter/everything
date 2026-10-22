// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  Element.prototype.hasPointerCapture = function hasPointerCapture() { return false; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.resetModules(); });

/** The grid as it loads on the given platform: the modifier key is decided when its module is evaluated. */
async function setup(platform) {
  vi.stubGlobal('navigator', { platform, userAgent: platform === 'MacIntel' ? 'Macintosh' : 'Windows' });
  vi.resetModules();
  const { createGrid } = await import('../src/ui/grid.js');
  const { Workbook, DEFAULT_ROW_HEIGHT, DEFAULT_COL_WIDTH } = await import('../src/core/workbook.js');
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const menus = [];
  const grid = createGrid({ wb, sheetId: id, announce() {}, onContextMenu: (m) => menus.push(m) });
  document.body.replaceChildren(grid.el);
  const at = (r, c) => ({ clientX: (c + 0.5) * DEFAULT_COL_WIDTH, clientY: (r + 0.5) * DEFAULT_ROW_HEIGHT });
  // Control+click as a Mac's browser sends it: a press of the primary button with Control held, then the menu's event.
  const controlClick = (r, c) => {
    const init = { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ctrlKey: true, ...at(r, c) };
    grid.viewport.dispatchEvent(new PointerEvent('pointerdown', init));
    grid.viewport.dispatchEvent(new PointerEvent('pointerup', init));
    grid.viewport.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0, ctrlKey: true, ...at(r, c) }));
  };
  return { grid, menus, controlClick };
}

it('keeps a range selected when it is Control+clicked on a Mac, as a right-click keeps it', async () => {
  const { grid, menus, controlClick } = await setup('MacIntel');
  grid.selectByName('B2:D5');
  controlClick(2, 2);
  expect(grid.range).toEqual({ r1: 1, c1: 1, r2: 4, c2: 3 });
  expect(menus).toHaveLength(1);
});

it('still selects the cell Control+clicked outside the selection on a Mac before its menu opens', async () => {
  const { grid, menus, controlClick } = await setup('MacIntel');
  grid.selectByName('B2:D5');
  controlClick(8, 6);
  expect(grid.range).toEqual({ r1: 8, c1: 6, r2: 8, c2: 6 });
  expect(menus).toHaveLength(1);
});

it('leaves Control+click on Windows adding a cell to the selection', async () => {
  const { grid } = await setup('Win32');
  grid.selectByName('B2:D5');
  const init = { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ctrlKey: true, clientX: 650, clientY: 170 };
  grid.viewport.dispatchEvent(new PointerEvent('pointerdown', init));
  grid.viewport.dispatchEvent(new PointerEvent('pointerup', init));
  expect(grid.ranges).toHaveLength(2);
});
