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

/** The grid as it loads on the given platform: the platform is read when its module is evaluated. */
async function setup(platform) {
  vi.stubGlobal('navigator', { platform, userAgent: platform === 'MacIntel' ? 'Macintosh' : 'Windows' });
  vi.resetModules();
  const { createGrid } = await import('../src/ui/grid.js');
  const { Workbook } = await import('../src/core/workbook.js');
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const commands = [];
  const grid = createGrid({ wb, sheetId: id, announce() {}, onCommand: (cmd, arg) => commands.push([cmd, arg]) });
  document.body.replaceChildren(grid.el);
  return { grid, commands };
}

// A Mac types ©, €, π and ü with Option. Option+G on a selected cell started no entry, where Excel for Mac
// starts one with ©: the grid took every Alt chord for a shortcut. The Option shortcuts it does answer
// to (Option+=, Option+;) still come first, and on Windows Alt+letter is still no typing.
it('starts an entry with a character typed with Option on a Mac', async () => {
  const { grid, commands } = await setup('MacIntel');
  key(grid.viewport, '©', { altKey: true, code: 'KeyG' });
  expect(grid.editState).toMatchObject({ r: 0, c: 0, text: '©' });
  key(grid.el.querySelector('.grid-editor'), 'Escape');
  key(grid.viewport, '≠', { altKey: true, code: 'Equal' });
  expect(commands).toContainEqual(['autosum', undefined]);
  expect(grid.editState).toBe(null);
  grid.destroy();
});

it('leaves Alt+letter alone on Windows', async () => {
  const { grid } = await setup('Win32');
  key(grid.viewport, 'g', { altKey: true, code: 'KeyG' });
  expect(grid.editState).toBe(null);
  grid.destroy();
});
