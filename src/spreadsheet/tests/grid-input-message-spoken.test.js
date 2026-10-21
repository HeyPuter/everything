// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
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

// A validation rule's input message ("Score: Enter a whole number from 1 to 9") shows beside the selected cell,
// but a screen reader moving onto the cell heard only its name and value. The message is now read with them,
// unless the rule hides it.
it('reads a validation input message with the selected cell', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 1, 1, '4');
  wb.addValidation(id, { range: { r1: 0, c1: 1, r2: 9, c2: 1 }, type: 'whole', min: 1, max: 9, promptTitle: 'Score', prompt: 'Enter a whole number from 1 to 9' });
  wb.addValidation(id, { range: { r1: 0, c1: 2, r2: 9, c2: 2 }, type: 'whole', min: 1, max: 9, prompt: 'Hidden', showInputMessage: false });
  const said = [];
  const grid = createGrid({ wb, sheetId: id, announce: (text) => said.push(text) });
  document.body.replaceChildren(grid.el);
  grid.setSelection(S.single(1, 1));
  expect(said.at(-1)).toBe('B2, 4. Score: Enter a whole number from 1 to 9');
  grid.setSelection(S.single(1, 2));
  expect(said.at(-1)).toBe('C2, empty');
  grid.setSelection(S.single(1, 0));
  expect(said.at(-1)).toBe('A2, empty');
  grid.destroy();
});
