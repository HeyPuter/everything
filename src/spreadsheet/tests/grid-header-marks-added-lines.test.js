// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const pointer = (target, type, init) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ...init }));
const marks = (head) => [...head.querySelectorAll('.hcell')].map((h) => (h.classList.contains('sel') ? 'sel' : h.classList.contains('hl') ? 'hl' : '-')).join(' ');

// Columns (or rows) picked by their headings and then added to with Ctrl/Cmd+click were marked differently:
// the last one as selected whole, the ones before it only as crossed by the selection, as cells are, though
// each is a whole column selected. Every whole line of the selection is now marked as selected.
it('marks every column picked by its letter as selected whole, the ones added with Ctrl/Cmd+click too', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  const clip = grid.el.querySelector('.grid-colhead-clip');
  const press = (c, init = {}) => {
    pointer(clip.querySelector(`.hcell[data-c="${c}"]`), 'pointerdown', { clientX: c * 100 + 50, clientY: 10, ...init });
    pointer(clip, 'pointerup', { clientX: c * 100 + 50, clientY: 10, ...init });
  };
  press(1);
  press(3, { ctrlKey: true, metaKey: true });
  await flush();
  expect(marks(clip).split(' ').slice(0, 5).join(' ')).toBe('- sel - sel -');
  // A block of cells added beside them is marked as crossed, as before.
  grid.setRanges([{ r1: 0, c1: 1, r2: 1048575, c2: 1 }, { r1: 2, c1: 4, r2: 3, c2: 4 }]);
  await flush();
  expect(marks(clip).split(' ').slice(0, 5).join(' ')).toBe('- sel - - hl');
  grid.destroy();
});
