// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

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

/** A General number in a column too narrow for it; the test canvas measures 7px a character. */
async function shown(text, width) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, text);
  wb.setColWidth(id, 0, width);
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  const out = grid.el.querySelector('#gc-0-0').textContent;
  grid.destroy();
  return out;
}

// 1.005 and 2.675 sit just under their halfway points in binary, as Excel stores them too; Excel rounds the
// digits it shows (fifteen of them), so a column too narrow for 1.005 shows 1.01, as 0.00 formats it.
describe('General numbers shortened to fit round the digits shown', () => {
  it('rounds the dropped decimals half up', async () => {
    expect(await shown('1.005', 34)).toBe('1.01');
    expect(await shown('2.675', 34)).toBe('2.68');
    expect(await shown('-2.675', 41)).toBe('-2.68');
    expect(await shown('2.675', 30)).toBe('2.7');
  });

  it('rounds a scientific form the same way', async () => {
    expect(await shown('0.0000002675', 62)).toBe('2.68E-07');
    expect(await shown('-0.0000002675', 69)).toBe('-2.68E-07');
    expect(await shown('0.0000002675', 56)).toBe('2.7E-07');
    // A carry into the next power of ten reads 1E, not 10E.
    expect(await shown('0.00000099996', 52)).toBe('1E-06');
  });
});
