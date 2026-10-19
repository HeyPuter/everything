// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.resetModules(); });

const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

async function setup(platform) {
  vi.stubGlobal('navigator', { platform, userAgent: platform === 'MacIntel' ? 'Macintosh' : 'Windows' });
  vi.resetModules();
  const { createGrid } = await import('../src/ui/grid.js');
  const { Workbook } = await import('../src/core/workbook.js');
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, 'hello');
  const commands = [];
  const grid = createGrid({ wb, sheetId: id, announce() {}, onCommand: (cmd, arg) => commands.push([cmd, arg]) });
  document.body.replaceChildren(grid.el);
  return { wb, id, grid, commands, viewport: grid.el.querySelector('.grid-viewport') };
}

// Many Mac keyboards reach F2 only with Fn; Excel for Mac edits the active cell with Control+U as well.
it('edits the active cell with Control+U on a Mac, the caret after its text', async () => {
  const { grid, commands, viewport } = await setup('MacIntel');
  key(viewport, 'u', { ctrlKey: true, code: 'KeyU' });
  expect(grid.editing).toBe(true);
  expect(grid.editState).toMatchObject({ r: 0, c: 0, text: 'hello', mode: 'inplace' });
  expect(commands).toEqual([]);
  grid.destroy();
});

it('keeps Ctrl+U as Underline elsewhere, and ⌘+U as Underline on a Mac', async () => {
  const win = await setup('Win32');
  key(win.viewport, 'u', { ctrlKey: true, code: 'KeyU' });
  expect(win.grid.editing).toBe(false);
  expect(win.commands).toEqual([['underline', undefined]]);
  win.grid.destroy();
  const mac = await setup('MacIntel');
  key(mac.viewport, 'u', { metaKey: true, code: 'KeyU' });
  expect(mac.grid.editing).toBe(false);
  expect(mac.commands).toEqual([['underline', undefined]]);
  mac.grid.destroy();
});
