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


// The editor was named "Cell editor" whatever cell it was over, so a screen reader moving into it did not say
// where the typing would go.
it('names the editor after the cell it edits', () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  grid.selectByName('C7');
  grid.beginEdit({ text: '', mode: 'type' });
  expect(grid.el.querySelector('.grid-editor').getAttribute('aria-label')).toBe('Editing C7');
  grid.moveEdit(8, 2);
  expect(grid.el.querySelector('.grid-editor').getAttribute('aria-label')).toBe('Editing C9');
});
