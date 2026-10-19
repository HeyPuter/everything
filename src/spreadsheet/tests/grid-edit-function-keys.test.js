// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const key = (target, k, init = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

function setup() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, 'top');
  const commands = [];
  const grid = createGrid({ wb, sheetId: id, announce() {}, onCommand: (cmd, arg) => commands.push([cmd, arg]) });
  document.body.replaceChildren(grid.el);
  return { wb, id, grid, commands, viewport: grid.viewport, editor: grid.el.querySelector('.grid-editor') };
}

// F5 reloads the page in a browser (Ctrl+F5 and Shift+F5 harder still) and F7 asks about caret browsing; on the
// sheet they are Go To, Find and Spelling. Pressed while an entry was typed they reached the browser.
describe('F5 and F7 while an entry is typed', () => {
  for (const [k, init] of [['F5', {}], ['F5', { shiftKey: true }], ['F5', { ctrlKey: true }], ['F7', {}], ['F7', { shiftKey: true }]]) {
    it(`keep ${init.shiftKey ? 'Shift+' : init.ctrlKey ? 'Ctrl+' : ''}${k} from the browser and leave the entry as it was`, () => {
      const { grid, commands, editor } = setup();
      grid.beginEdit({ text: 'abc', mode: 'type' });
      expect(key(editor, k, init).defaultPrevented).toBe(true);
      expect(grid.editing).toBe(true);
      expect(editor.value).toBe('abc');
      expect(commands).toEqual([]);
      grid.destroy();
    });
  }
});
