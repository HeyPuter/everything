// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Typing a formula, Shift+arrow stretches the reference being pointed at, as Excel does. The stretched range
// was kept by its top-left and bottom-right corners rather than by where it started and where it had got to,
// so stretching up or left a second time pulled the far end back instead: =C9, Shift+Up gave =C8:C9 and a
// second Shift+Up =C8, where Excel gives =C7:C9.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function ({ left, top }) { this.scrollLeft = left; this.scrollTop = top; };
  Element.prototype.setPointerCapture = function () {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { document.body.replaceChildren(); });

function mount() {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 100, cols: 20 }] });
  const grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} });
  document.body.append(grid.el);
  grid.viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
  const editor = grid.el.querySelector('.grid-editor');
  const key = (k, init = {}) => editor.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  return { grid, key };
}

it('stretches the pointed range up and left with each Shift+arrow, as it does down and right', () => {
  const { grid, key } = mount();
  grid.selectByName('C10');
  grid.beginEdit({ text: '=', mode: 'type' });
  const steps = [['ArrowUp', false, '=C9'], ['ArrowUp', true, '=C8:C9'], ['ArrowUp', true, '=C7:C9'], ['ArrowLeft', true, '=B7:C9'],
    ['ArrowLeft', true, '=A7:C9'], ['ArrowDown', true, '=A8:C9'], ['ArrowRight', true, '=B8:C9']];
  for (const [k, shiftKey, text] of steps) {
    key(k, { shiftKey });
    expect(grid.editState.text).toBe(text);
  }
  grid.destroy();
});

it('stretches from the cell picked by a click with Shift+click, then on with Shift+arrows', () => {
  const { grid, key } = mount();
  grid.selectByName('E20');
  grid.beginEdit({ text: '=SUM(', mode: 'type' });
  const press = (r, c, shiftKey = false) => {
    const rect = grid.cellRect(r, c);
    for (const type of ['pointerdown', 'pointerup']) grid.viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', shiftKey, clientX: rect.left + 3, clientY: rect.top + 3 }));
  };
  press(9, 3); // D10
  press(5, 1, true); // Shift+click B6: D10 stays the anchor
  expect(grid.editState.text).toBe('=SUM(B6:D10');
  key('ArrowUp', { shiftKey: true });
  expect(grid.editState.text).toBe('=SUM(B5:D10');
  grid.destroy();
});
