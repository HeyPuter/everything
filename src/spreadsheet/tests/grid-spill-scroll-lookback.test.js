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

/** A 60-column sheet whose A1 holds `chars` characters (7px each) in 100px columns; the view is 800px wide with a two-column buffer. */
async function mount(chars, prepare) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.ensureSize(id, 100, 60);
  wb.setInput(id, 0, 0, 'x'.repeat(chars));
  wb.setInput(id, 50, 59, 'far'); // keeps the sheet 60 columns wide (empty ones are given back once it is shown), out of the label's row
  prepare?.(wb, id);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  let left = 0;
  Object.defineProperty(grid.viewport, 'scrollLeft', { configurable: true, get: () => left, set: (v) => { left = v; } });
  grid.setSelection(S.single(12, 0));
  await flush();
  const scrollTo = async (x) => { left = x; grid.viewport.dispatchEvent(new Event('scroll')); await flush(); };
  return { wb, id, grid, scrollTo, label: () => grid.el.querySelector('#gc-0-0') };
}

// A label was looked for twelve columns left of the view while its text could run much further,
// so a long sentence disappeared from the middle of the screen once its own cell was twelve columns
// away, and came back on scrolling towards it.
describe('a label spilling far to the right of its cell', () => {
  it('stays drawn wherever the view is over its text', async () => {
    const { scrollTo, label } = await mount(300); // 2100px of text: 21 columns
    expect(label().style.width).toBe('2200px');
    await scrollTo(1200); // the view begins at column M, the buffer at K
    expect(label()).toBeTruthy();
    expect(label().style.width).toBe('2200px');
    await scrollTo(1600); // the buffer begins at column O, fourteen columns from A
    expect(label()).toBeTruthy();
    expect(label().style.width).toBe('2200px');
    await scrollTo(2000); // column S: the text still runs under the first two columns of the view
    expect(label()).toBeTruthy();
  });

  it('is looked for exactly as far left as its text may run, and no further', async () => {
    const { scrollTo, label } = await mount(5000); // far more text than any label may spill
    expect(label().style.width).toBe('3300px'); // its own cell and the 32 columns it may run over
    await scrollTo(3000); // the buffer begins at column AC (28): the text still covers it
    expect(label()).toBeTruthy();
    await scrollTo(3400); // the buffer begins at column AG (32): the text's last column
    expect(label()).toBeTruthy();
    await scrollTo(3500); // the buffer begins at column AH (33): past the text, and past the search
    expect(label()).toBeNull();
  });

  it('runs over hidden columns without counting them', async () => {
    const { label } = await mount(5000, (wb, id) => { wb.setHidden(id, 'col', [2, 3], true); });
    expect(label().style.width).toBe('3300px'); // 32 shown columns, plus the two hidden ones at no width
  });
});
