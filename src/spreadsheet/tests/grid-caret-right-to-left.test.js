// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  // Every UTF-16 unit measures 7px.
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  // The cell editor is laid out at the viewport's left edge, as wide as the grid made it.
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (!this.classList?.contains('grid-editor')) return realRect.call(this);
    const width = parseFloat(this.style.width) || 0;
    return { left: 0, top: 0, right: width, bottom: 20, width, height: 20, x: 0, y: 0 };
  };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { Element.prototype.getBoundingClientRect = realRect; document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

/** Double-click A2 (200px wide) at `clientX` and report where the caret landed. */
async function caretAt(text, clientX) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setColWidth(id, 0, 200);
  wb.setInput(id, 1, 0, text);
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX, clientY: 26 + 13 }));
  const editor = grid.el.querySelector('.grid-editor');
  const at = editor.selectionStart;
  grid.cancelEdit();
  grid.destroy();
  return at;
}

// Hebrew or Arabic text sits at the cell's right and reads from right to left: its first letter is the
// rightmost one. A double-click at its right end puts the caret before the first letter, not after the last.
it('a double-click on right-to-left text puts the caret where it was clicked', async () => {
  expect(await caretAt('שלום', 196)).toBe(0);
  expect(await caretAt('שלום', 20)).toBe(4);
  // Left-to-right text is unchanged: the caret follows the click from the left.
  expect(await caretAt('abcd', 60)).toBe(4);
  expect(await caretAt('abcd', 3)).toBe(0);
});
