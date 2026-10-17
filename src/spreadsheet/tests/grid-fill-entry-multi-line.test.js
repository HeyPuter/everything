// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
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
const key = (target, k, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

// A line break typed with Alt+Enter turns wrapping on so the lines show; Ctrl+Enter into a selection
// of several cells filled them with the text but left wrapping off, so only the first line showed.
it('wraps and fits every cell a multi-line Ctrl+Enter entry fills, as a single entry does', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const base = wb.rowHeight(id, 0);
  grid.selectByName('A1:B2');
  grid.beginEdit({ text: 'one\ntwo', mode: 'type' });
  key(grid.el.querySelector('.grid-editor'), 'Enter', { ctrlKey: true, metaKey: true });
  for (const [r, c] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    expect(wb.getValue(id, r, c)).toBe('one\ntwo');
    expect(wb.styleAt(id, r, c)?.wrap).toBe(true);
  }
  expect(wb.rowHeight(id, 0)).toBeGreaterThan(base);
  expect(wb.rowHeight(id, 1)).toBeGreaterThan(base);
  expect(wb.rowHeight(id, 2)).toBe(base);
  // One step takes the whole entry back.
  wb.undo();
  expect(wb.getValue(id, 1, 1)).toBe(null);
  expect(wb.styleAt(id, 1, 1)?.wrap).toBeFalsy();
  expect(wb.rowHeight(id, 0)).toBe(base);
  grid.destroy();
});

it('leaves wrapping alone for a one-line Ctrl+Enter entry', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('A1:B2');
  grid.beginEdit({ text: 'one', mode: 'type' });
  key(grid.el.querySelector('.grid-editor'), 'Enter', { ctrlKey: true, metaKey: true });
  expect(wb.getValue(id, 1, 1)).toBe('one');
  expect(wb.styleAt(id, 1, 1)?.wrap).toBeFalsy();
  grid.destroy();
});
