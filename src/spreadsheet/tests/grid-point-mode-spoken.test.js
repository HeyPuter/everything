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

// While a formula is typed, the arrows pick the cells it refers to (=SUM(B2:B4)). The reference goes into the
// text under the caret, which a screen reader does not speak, so to someone listening the arrows did
// nothing. The reference picked is now read out.
it('reads out each reference the arrows pick in a formula', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const spoken = [];
  const grid = createGrid({ wb, sheetId: id, announce: (m) => spoken.push(m) });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('D1');
  grid.beginEdit({ text: '=SUM(', mode: 'type' });
  const editor = grid.el.querySelector('.grid-editor');
  key(editor, 'ArrowLeft');
  expect(grid.editState.text).toBe('=SUM(C1');
  expect(spoken.at(-1)).toBe('C1');
  key(editor, 'ArrowDown', { shiftKey: true });
  key(editor, 'ArrowDown', { shiftKey: true });
  expect(grid.editState.text).toBe('=SUM(C1:C3');
  expect(spoken.at(-1)).toBe('C1:C3');
  grid.destroy();
});
