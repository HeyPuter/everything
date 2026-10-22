// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { addComment, setThreadResolved } from '../src/core/comments.js';

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

// A cell with a comment thread carries a mark in its corner, but a screen reader selecting it heard only
// its address and value, as for any other cell (a note was read out; a comment was not mentioned). It
// now says the cell has a comment, or a resolved one.
it('says a selected cell has a comment', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 1, 1, '42');
  addComment(wb, id, 1, 1, 'Check this figure', { name: 'Ana' });
  const spoken = [];
  const grid = createGrid({ wb, sheetId: id, announce: (m) => spoken.push(m) });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.selectByName('B2');
  expect(spoken.at(-1)).toBe('B2, 42. Has a comment');
  setThreadResolved(wb, id, 1, 1, true);
  grid.selectByName('B2');
  expect(spoken.at(-1)).toBe('B2, 42. Has a resolved comment');
  grid.selectByName('C2');
  expect(spoken.at(-1)).toBe('C2, empty');
  grid.destroy();
});
