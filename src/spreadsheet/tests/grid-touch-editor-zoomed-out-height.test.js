// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

let coarse = false;
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = (q) => ({ matches: q.includes('coarse') ? coarse : false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); coarse = false; });

const flush = () => new Promise((r) => setTimeout(r, 5));

async function edit(zoom) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, 'text');
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  grid.setZoom(zoom);
  await flush();
  grid.beginEdit({ mode: 'inplace' });
  const editor = grid.el.querySelector('.grid-editor');
  const row = parseFloat(grid.el.querySelector('.grid-row').style.height);
  grid.destroy();
  return { font: parseFloat(editor.style.fontSize), height: parseFloat(editor.style.height), row };
}

// On a touch screen the editor's text is never under 16px, so iOS does not zoom the page into it. Zoomed
// out, a row is shorter than that line (10px at 50%), and the editor, kept to the row's height, showed a
// sliver of what was typed. It now grows down to hold its line; with a mouse it keeps the row's height.
describe('the in-cell editor zoomed out', () => {
  it('is tall enough for its 16px line on a touch screen', async () => {
    coarse = true;
    const { font, height, row } = await edit(0.5);
    expect(font).toBe(16);
    expect(row).toBeLessThan(16);
    expect(height).toBeGreaterThanOrEqual(16 * 1.2);
  });

  it('keeps to the row with a mouse, its text zoomed with the cells', async () => {
    const { font, height, row } = await edit(0.5);
    expect(font).toBeLessThan(8);
    expect(height).toBe(row);
  });

  it('keeps to the row on a touch screen at 100%, where the line fits', async () => {
    coarse = true;
    const { height, row } = await edit(1);
    expect(height).toBe(row);
  });
});
