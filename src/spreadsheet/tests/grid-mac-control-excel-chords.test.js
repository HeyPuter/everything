// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Excel for Mac takes Control as well as ⌘ for Fill Down and Fill Right (⌃+D, ⌃+R), today's date (⌃+;), hiding
// and showing rows and columns (⌃+9, ⌃+0, with Shift to show), inserting and deleting cells (⌃+Shift+=, ⌃+-),
// Format Cells (⌃+1) and Insert Link (⌃+K). Here those Control chords did nothing on a Mac.
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

const key = (target, k, code, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true, ...init }));

async function setup(platform) {
  vi.stubGlobal('navigator', { platform, userAgent: platform === 'MacIntel' ? 'Macintosh' : 'Windows' });
  vi.resetModules();
  const { createGrid } = await import('../src/ui/grid.js');
  const { Workbook } = await import('../src/core/workbook.js');
  const S = await import('../src/core/selection.js');
  const wb = new Workbook();
  const commands = [];
  const grid = createGrid({ wb, sheetId: wb.sheets[0].id, announce() {}, onCommand: (cmd, arg) => commands.push(arg === undefined ? [cmd] : [cmd, arg]) });
  document.body.replaceChildren(grid.el);
  grid.setSelection(S.single(2, 1));
  return { grid, commands, viewport: grid.el.querySelector('.grid-viewport') };
}

const CHORDS = [
  ['d', 'KeyD', {}, ['fillDown']],
  ['r', 'KeyR', {}, ['fillRight']],
  [';', 'Semicolon', {}, ['insertDate']],
  ['9', 'Digit9', {}, ['hide', 'row']],
  ['0', 'Digit0', {}, ['hide', 'col']],
  ['(', 'Digit9', { shiftKey: true }, ['unhide', 'row']],
  [')', 'Digit0', { shiftKey: true }, ['unhide', 'col']],
  ['+', 'Equal', { shiftKey: true }, ['insertDialog']],
  ['-', 'Minus', {}, ['deleteDialog']],
  ['1', 'Digit1', {}, ['formatCells']],
  ['k', 'KeyK', {}, ['link']],
];

it('runs Excel for Mac\'s Control chords on a Mac, as ⌘ runs them', { timeout: 90000 }, async () => {
  const { grid, commands, viewport } = await setup('MacIntel');
  try {
    for (const [k, code, init, expected] of CHORDS) {
      key(viewport, k, code, { ctrlKey: true, ...init });
      expect(commands.pop(), `⌃+${init.shiftKey ? 'Shift+' : ''}${code}`).toEqual(expected);
      key(viewport, k, code, { metaKey: true, ...init });
      expect(commands.pop(), `⌘+${init.shiftKey ? 'Shift+' : ''}${code}`).toEqual(expected);
    }
    // Control+Shift+1 stays the Number format, and other Control letters are left alone.
    key(viewport, '!', 'Digit1', { ctrlKey: true, shiftKey: true });
    expect(commands.pop()).toEqual(['fmt', 'number']);
    key(viewport, 'a', 'KeyA', { ctrlKey: true });
    key(viewport, 's', 'KeyS', { ctrlKey: true });
    expect(commands).toEqual([]);
    expect(grid.editing).toBe(false);
  } finally { grid.destroy(); }
});

it('leaves Windows\' Ctrl chords as they were', { timeout: 90000 }, async () => {
  const { grid, commands, viewport } = await setup('Win32');
  try {
    key(viewport, 'd', 'KeyD', { ctrlKey: true });
    expect(commands.pop()).toEqual(['fillDown']);
    key(viewport, 'd', 'KeyD', { metaKey: true }); // the Windows key is not a modifier of the grid's
    expect(commands).toEqual([]);
  } finally { grid.destroy(); }
});
