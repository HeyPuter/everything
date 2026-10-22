// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';

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

async function mount(prepare) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  prepare(wb, id);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  grid.setSelection(S.single(12, 0));
  await flush();
  return { wb, id, grid, node: (r, c) => grid.el.querySelector(`#gc-${r}-${c}`) };
}

// Center Across Selection was laid out as plain centring in the cell's own column, so a title meant
// to sit over a table (the usual way to centre one without merging) sat over its first column.
describe('Center Across Selection', () => {
  it('centres the text over the blank cells after it that are set the same way', async () => {
    const { node } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, 'Report'); // 42px: fits in A1 alone
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 3 }, { align: 'centerContinuous' });
    });
    const title = node(0, 0);
    expect(title.classList.contains('ac')).toBe(true);
    expect(title.style.left).toBe('0px');
    expect(title.style.width).toBe('400px'); // A1:D1, centred there with no padding of its own
    expect(title.style.paddingLeft).toBe('');
    expect(title.style.paddingRight).toBe('');
    expect(node(0, 1).textContent).toBe('');
  });

  it('stops the run at a filled cell or one aligned otherwise', async () => {
    const { node } = await mount((wb, id) => {
      wb.setInput(id, 2, 0, 'Report');
      wb.applyStyle(id, { r1: 2, c1: 0, r2: 2, c2: 4 }, { align: 'centerContinuous' });
      wb.setInput(id, 2, 3, 'x');
      wb.setInput(id, 4, 0, 'Report');
      wb.applyStyle(id, { r1: 4, c1: 0, r2: 4, c2: 1 }, { align: 'centerContinuous' });
    });
    expect(node(2, 0).style.width).toBe('300px'); // A3:C3; D3 holds a value
    expect(node(4, 0).style.width).toBe('200px'); // A5:B5; C5 is not centred across
  });

  it('keeps the run centre when the text overflows past the run on one side only', async () => {
    const { node } = await mount((wb, id) => {
      wb.setInput(id, 6, 1, 'x'.repeat(50)); // 350px over B7:C7, 200px wide: 76px more each way
      wb.applyStyle(id, { r1: 6, c1: 1, r2: 6, c2: 2 }, { align: 'centerContinuous' });
      wb.setInput(id, 6, 0, 'blocker');
    });
    const title = node(6, 1);
    expect(title.style.left).toBe('100px');
    expect(title.style.width).toBe('300px'); // B7:D7
    expect(title.style.paddingRight).toBe('102px'); // centred on B7:C7, clipped at A7
  });

  it('still centres plain centred text in its own cell', async () => {
    const { node } = await mount((wb, id) => {
      wb.setInput(id, 8, 0, 'Report');
      wb.applyStyle(id, { r1: 8, c1: 0, r2: 8, c2: 3 }, { align: 'center' });
    });
    expect(node(8, 0).classList.contains('spill')).toBe(false);
    expect(node(8, 0).style.width).toBe('100px');
  });
});
