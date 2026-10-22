// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// On a Mac, Control+click is the secondary click and opens the object's menu, but the browser first sends it as
// a press of the primary button with Control held, which the grid took as Ctrl-click: an object of several
// selected was taken out of the selection (an unselected one added to it) before its menu opened, so the menu's
// Delete, Duplicate or Bring to Front acted on a different set of objects than a right-click would.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.resetModules(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
// Each test loads the grid afresh for its platform, which takes a while on a busy machine.
const SLOW = 30000;

/** The grid as it loads on the given platform: the modifier key is decided when its module is evaluated. */
async function setup(platform) {
  vi.stubGlobal('navigator', { platform, userAgent: platform === 'MacIntel' ? 'Macintosh' : 'Windows' });
  vi.resetModules();
  const { createGrid } = await import('../src/ui/grid.js');
  const { Workbook } = await import('../src/core/workbook.js');
  const wb = new Workbook(), id = wb.sheets[0].id;
  const a = wb.addChart(id, { type: 'text', text: 'One', anchor: { r: 2, c: 1 }, w: 120, h: 60 });
  const b = wb.addChart(id, { type: 'text', text: 'Two', anchor: { r: 2, c: 5 }, w: 120, h: 60 });
  const c = wb.addChart(id, { type: 'text', text: 'Three', anchor: { r: 9, c: 1 }, w: 120, h: 60 });
  const menus = [];
  const grid = createGrid({ wb, sheetId: id, announce() {}, onContextMenu: (m) => menus.push(m) });
  document.body.replaceChildren(grid.el);
  await flush();
  const box = (o) => grid.el.querySelector(`.chart-box[data-chart="${o}"]`);
  const press = (o, init) => {
    const e = { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', clientX: 5, clientY: 5, ...init };
    box(o).dispatchEvent(new PointerEvent('pointerdown', e));
    box(o).dispatchEvent(new PointerEvent('pointerup', e));
  };
  const controlClick = (o) => {
    press(o, { ctrlKey: true });
    box(o).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: 5, clientY: 5 }));
  };
  return { grid, menus, a, b, c, press, controlClick };
}

it('keeps the objects selected when one of them is Control+clicked on a Mac', async () => {
  const { grid, menus, a, b, press, controlClick } = await setup('MacIntel');
  press(a, {}); press(b, { shiftKey: true });
  await flush();
  controlClick(b);
  await flush();
  expect(grid.selectedCharts.sort()).toEqual([a, b].sort());
  expect(menus).toHaveLength(1);
}, SLOW);

it('selects only the object Control+clicked outside the selection on a Mac, as a right-click does', async () => {
  const { grid, menus, a, c, press, controlClick } = await setup('MacIntel');
  press(a, {});
  await flush();
  controlClick(c);
  await flush();
  expect(grid.selectedCharts).toEqual([c]);
  expect(menus).toHaveLength(1);
}, SLOW);

it('leaves Ctrl+click on Windows adding an object to the selection', async () => {
  const { grid, a, b, press } = await setup('Win32');
  press(a, {}); press(b, { ctrlKey: true });
  await flush();
  expect(grid.selectedCharts.sort()).toEqual([a, b].sort());
}, SLOW);
