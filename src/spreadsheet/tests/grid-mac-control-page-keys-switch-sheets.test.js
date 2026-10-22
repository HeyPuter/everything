// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Excel for Mac goes to the next and previous sheet with Control+Page Down and Control+Page Up. Here only
// ⌘+Page Down did: Control+Page Down moved the active cell a screen down instead, and mid-entry did nothing.
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
  const S = await import('../src/core/selection.js');
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const commands = [];
  const grid = createGrid({ wb, sheetId: id, announce() {}, onCommand: (cmd, arg) => commands.push([cmd, arg]) });
  document.body.replaceChildren(grid.el);
  return { grid, S, commands, viewport: grid.el.querySelector('.grid-viewport') };
}

it('switches sheets with Control+Page Down and Control+Page Up on a Mac', { timeout: 90000 }, async () => {
  const { grid, S, commands, viewport } = await setup('MacIntel');
  try {
    grid.setSelection(S.single(2, 0));
    key(viewport, 'PageDown', { ctrlKey: true });
    expect(commands.pop()).toEqual(['sheet', 'next']);
    key(viewport, 'PageUp', { ctrlKey: true });
    expect(commands.pop()).toEqual(['sheet', 'prev']);
    expect(grid.active).toEqual({ r: 2, c: 0 }); // the active cell has not moved a screen
    key(viewport, 'PageDown', { metaKey: true }); // ⌘ still does
    expect(commands.pop()).toEqual(['sheet', 'next']);
    // Mid-entry too, to pick a reference on the next sheet.
    grid.beginEdit({ text: '=' });
    key(grid.el.querySelector('.grid-editor'), 'PageDown', { ctrlKey: true });
    expect(commands.pop()).toEqual(['sheet', 'next']);
  } finally { grid.destroy(); }
});

it('still pages down with Page Down alone on a Mac, and leaves Windows\' Ctrl+Page Down as it was', { timeout: 90000 }, async () => {
  const mac = await setup('MacIntel');
  try {
    mac.grid.setSelection(mac.S.single(2, 0));
    key(mac.viewport, 'PageDown');
    expect(mac.commands).toEqual([]);
    expect(mac.grid.active.r).toBeGreaterThan(2);
  } finally { mac.grid.destroy(); }
  const win = await setup('Win32');
  try {
    key(win.viewport, 'PageDown', { ctrlKey: true });
    expect(win.commands.pop()).toEqual(['sheet', 'next']);
  } finally { win.grid.destroy(); }
});
