// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { setAppOptions } from '../src/lib/app-options.js';
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
afterEach(() => { setAppOptions({ commentIndicators: 'hover' }); document.body.replaceChildren(); });

// A cell's note shows beside the selected cell, but a screen reader moving onto the cell heard only its address and
// value: the note was not reachable at all without sight, its popover being outside the grid's focus. The note is
// now read with the cell, as a validation input message is, unless notes are set not to show.
it('reads a note with the selected cell', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 1, 1, '4');
  wb.setNote(id, 1, 1, 'Checked by Dana');
  const said = [];
  const grid = createGrid({ wb, sheetId: id, announce: (text) => said.push(text) });
  document.body.replaceChildren(grid.el);
  grid.setSelection(S.single(1, 1));
  expect(said.at(-1)).toBe('B2, 4. Note: Checked by Dana');
  grid.setSelection(S.single(1, 0));
  expect(said.at(-1)).toBe('A2, empty');
  setAppOptions({ commentIndicators: 'none' });
  grid.setSelection(S.single(1, 1));
  expect(said.at(-1)).toBe('B2, 4');
  grid.destroy();
});
