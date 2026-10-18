// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Text tilted at an angle turned about its own centre after the cell had aligned it unturned: tilted 45° in
// a cell aligned to the bottom left, it stuck out of the bottom and the left of its cell, so its start was
// cut off although the row had been fitted to the turned text. The cell now aligns a box the size of the
// turned text's bounds, and the text turns about the middle of that box, as Excel lines angled text up.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function ({ left, top }) { this.scrollLeft = left; this.scrollTop = top; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { document.body.replaceChildren(); });

const frame = () => new Promise((r) => setTimeout(r, 5));

it('aligns the turned bounds of angled text in its cell, the text turning inside them', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 20, cols: 10 }] });
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Rotated 45');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { rot: 45 });
  wb.setInput(id, 0, 1, 'Two\nlines');
  wb.applyStyle(id, { r1: 0, c1: 1, r2: 0, c2: 1 }, { rot: -30, wrap: true });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.append(grid.el);
  await frame();
  const bounds = (r, c) => grid.el.querySelector(`#gc-${r}-${c} > .rot-bounds`);
  const a1 = bounds(0, 0);
  expect(a1).not.toBeNull();
  // 10 letters 7px wide make 70px of text, one 13px line 1.2 high: turned 45°, both sides are (70 + 15.6) × cos 45°.
  const side = (70 + 13 * 1.2) * Math.SQRT1_2;
  expect(parseFloat(a1.style.width)).toBeCloseTo(side, 1);
  expect(parseFloat(a1.style.height)).toBeCloseTo(side, 1);
  const text = a1.querySelector(':scope > .rot-text');
  expect(text.textContent).toBe('Rotated 45');
  expect(text.style.transform).toBe('translate(-50%, -50%) rotate(-45deg)');
  // Two lines (kept in a wrapped cell) turned -30°: the longest line's width and both lines' height.
  const b1 = bounds(0, 1);
  const w = 5 * 7, h = 2 * 13 * 1.2, cos = Math.cos(Math.PI / 6), sin = Math.sin(Math.PI / 6);
  expect(parseFloat(b1.style.width)).toBeCloseTo(w * cos + h * sin, 1);
  expect(parseFloat(b1.style.height)).toBeCloseTo(w * sin + h * cos, 1);
  grid.destroy();
});

it('keeps vertical text, at 90° either way, stacked in the cell itself', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 20, cols: 10 }] });
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Up');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { rot: 90 });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.append(grid.el);
  await frame();
  const a1 = grid.el.querySelector('#gc-0-0');
  expect(a1.querySelector('.rot-bounds')).toBeNull();
  expect(a1.querySelector(':scope > .rot-text').textContent).toBe('Up');
  grid.destroy();
});
