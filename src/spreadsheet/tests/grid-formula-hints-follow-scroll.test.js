// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// While a formula is typed into a cell, the list of functions (or the argument hint) opens under
// the cell. Scrolling the sheet moved the cell and its editor, but the list stayed where it had
// opened, floating over other cells away from the formula it belongs to.

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

describe('formula hints while the sheet scrolls', () => {
  it('follow the cell being typed into', async () => {
    const wb = new Workbook();
    const grid = createGrid({ wb, sheetId: wb.sheets[0].id });
    document.body.replaceChildren(grid.el);
    await flush();
    const editor = grid.el.querySelector('.grid-editor');
    let top = 200;
    editor.getBoundingClientRect = () => ({ left: 100, right: 200, top, bottom: top + 20, width: 100, height: 20 });
    grid.beginEdit({ text: '=SU', mode: 'type' });
    grid.setEditText('=SU');
    const list = grid.el.querySelector('.fx-hints');
    expect(list.hidden).toBe(false);
    const before = parseFloat(list.style.top);
    top = 100; // the sheet scrolled down by 100px, taking the cell up with it
    grid.viewport.dispatchEvent(new Event('scroll'));
    expect(parseFloat(list.style.top)).toBe(before - 100);
    grid.destroy();
  });
});
