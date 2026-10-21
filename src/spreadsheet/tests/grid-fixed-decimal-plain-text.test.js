// @vitest-environment jsdom
// Options ▸ Editing ▸ Put in a decimal point automatically turns a whole number typed as 1234 into 12.34. It reached
// cells set to Plain text too, whose entries are kept as typed: an order number 1234 went in as the text "12.34",
// and 007 as "0.07". A Plain text cell now keeps what was typed, as in Excel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';
import { setAppOptions, resetAppOptions, reloadAppOptions } from '../src/lib/app-options.js';
import { closeAllModals } from '../src/ui/modal.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i], get length() { return m.size; } };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  reloadAppOptions();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { resetAppOptions(); closeAllModals(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const ROW1_MID = Math.round(DEFAULT_ROW_HEIGHT) / 2;

async function mount(opts = {}) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id, ...opts });
  document.body.replaceChildren(grid.el);
  await flush();
  const key = (target, k, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const editor = grid.el.querySelector('.grid-editor');
  /** Type `text` into a cell and press Enter (with Shift when asked). */
  const enter = async (text, extra = {}) => {
    key(grid.viewport, text[0]);
    editor.value = text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text.slice(-1), inputType: 'insertText' }));
    key(editor, 'Enter', extra);
    await flush();
  };
  return { wb, id, grid, key, editor, enter };
}

it('leaves an entry in a Plain text cell as it was typed', async () => {
  const { wb, id, grid, enter } = await mount();
  setAppOptions({ fixedDecimal: true, fixedDecimalPlaces: 2 });
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { fmt: 'text' });
  grid.setSelection(S.single(0, 0));
  await enter('1234');
  await enter('007');
  expect(wb.getValue(id, 0, 0)).toBe('1234');
  expect(wb.getValue(id, 1, 0)).toBe('007');
  // A cell in any other format still takes the decimal point.
  await enter('1234');
  expect(wb.getValue(id, 2, 0)).toBe(12.34);
  grid.destroy();
});
