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
const LONG = 'x'.repeat(40); // 280px of text in a 100px column: 188px too wide for it

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

// Only left-aligned text ran over its empty neighbours; a right-aligned label was cut at its
// left edge and a centred title at both. They now overflow the way they face.
describe('text too wide for its cell', () => {
  it('overflows leftwards over empty neighbours when right-aligned', async () => {
    const { node } = await mount((wb, id) => {
      wb.setInput(id, 0, 2, LONG);
      wb.applyStyle(id, { r1: 0, c1: 2, r2: 0, c2: 2 }, { align: 'right' });
    });
    const label = node(0, 2);
    expect(label.classList.contains('spill')).toBe(true);
    expect(label.classList.contains('ar')).toBe(true);
    expect(label.style.left).toBe('0px'); // over B1 and A1
    expect(label.style.width).toBe('300px');
    expect(node(0, 1).textContent).toBe(''); // the blank cells it covers stay blank
    expect(node(0, 0).textContent).toBe('');
  });

  it('overflows both ways, by equal amounts, when centred', async () => {
    const { node } = await mount((wb, id) => {
      wb.setInput(id, 2, 2, LONG);
      wb.applyStyle(id, { r1: 2, c1: 2, r2: 2, c2: 2 }, { align: 'center' });
    });
    const label = node(2, 2);
    expect(label.classList.contains('spill')).toBe(true);
    expect(label.style.left).toBe('100px'); // over B3 and D3
    expect(label.style.width).toBe('300px');
    expect(label.style.paddingLeft).toBe('');
    expect(label.style.paddingRight).toBe('');
  });

  it('stays centred on its own cell when one side is blocked, overflowing the other way alone', async () => {
    const { node } = await mount((wb, id) => {
      wb.setInput(id, 4, 1, 'blocker');
      wb.setInput(id, 4, 2, LONG);
      wb.applyStyle(id, { r1: 4, c1: 2, r2: 4, c2: 2 }, { align: 'center' });
    });
    const label = node(4, 2);
    expect(label.style.left).toBe('200px');
    expect(label.style.width).toBe('200px'); // C5 and D5
    // The text keeps C5's centre: the box it is centred in runs from C5's left edge to as far past C5's centre
    // on the other side, and the cell clips it at the blocker. Padded on the left instead, it was centred on D5.
    expect(label.style.paddingRight).toBe('102px');
    expect(label.style.paddingLeft).toBe('');
  });

  it('stays centred on its own cell when it runs further left than right', async () => {
    const { node } = await mount((wb, id) => {
      wb.setInput(id, 4, 3, 'blocker');
      wb.setInput(id, 4, 2, LONG);
      wb.applyStyle(id, { r1: 4, c1: 2, r2: 4, c2: 2 }, { align: 'center' });
    });
    const label = node(4, 2);
    expect(label.style.left).toBe('100px');
    expect(label.style.width).toBe('200px'); // B5 and C5
    expect(label.style.paddingLeft).toBe('102px');
    expect(label.style.paddingRight).toBe('');
  });

  it('is clipped, not moved, when the cell it would overflow is not empty', async () => {
    const { node } = await mount((wb, id) => {
      wb.setInput(id, 6, 1, 'blocker');
      wb.setInput(id, 6, 2, LONG);
      wb.applyStyle(id, { r1: 6, c1: 2, r2: 6, c2: 2 }, { align: 'right' });
    });
    expect(node(6, 2).classList.contains('spill')).toBe(false);
    expect(node(6, 2).style.left).toBe('200px');
    expect(node(6, 2).style.width).toBe('100px');
  });

  it('keeps its opaque backing to the own cell and the unpainted run beside it when it overflows a painted cell', async () => {
    const { node } = await mount((wb, id) => {
      wb.setInput(id, 8, 2, LONG);
      wb.applyStyle(id, { r1: 8, c1: 2, r2: 8, c2: 2 }, { align: 'right' });
      wb.applyStyle(id, { r1: 8, c1: 1, r2: 8, c2: 1 }, { bg: '#ffcc00' });
    });
    const label = node(8, 2);
    expect(label.style.width).toBe('300px');
    expect(label.classList.contains('spill-over-fill')).toBe(true);
    expect(label.style.getPropertyValue('--spill-back-x')).toBe('200px'); // the backing starts at C9's own edge
    expect(label.style.getPropertyValue('--spill-opaque')).toBe('100px');
    expect(node(8, 1).style.backgroundColor).not.toBe('');
  });

  it('is still drawn from a column right of the view when it reaches into it', async () => {
    const { node } = await mount((wb, id) => {
      wb.setInput(id, 10, 14, 'x'.repeat(100)); // O11: 700px of text, 608px too wide
      wb.applyStyle(id, { r1: 10, c1: 14, r2: 10, c2: 14 }, { align: 'right' });
    });
    const label = node(10, 14); // the view ends at column K, with the buffer
    expect(label).toBeTruthy();
    expect(label.style.left).toBe('700px'); // over H11 to N11
    expect(label.style.width).toBe('800px');
  });

  it('still overflows rightwards when left-aligned, as before', async () => {
    const { node } = await mount((wb, id) => { wb.setInput(id, 0, 0, LONG); });
    expect(node(0, 0).style.left).toBe('0px');
    expect(node(0, 0).style.width).toBe('300px');
  });
});
