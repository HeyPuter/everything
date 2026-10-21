// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// A formula begun by typing in the cell is in Enter mode, where the arrows pick a cell into it after an operator.
// Clicking into its text in the formula bar, to fix something there, left it in that mode: the next Left or Right
// put a reference in (=1+A1) instead of moving the caret. A click in the bar now puts the entry in Edit mode, as a
// click in the cell's own editor does, and as Excel's formula bar does.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('moves the caret with the arrows once the formula bar is clicked into', async () => {
  const doc = new Doc({ name: 'Bar', path: 'Spreadsheets/Bar.xlsx' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = '=1+';
  editor.setSelectionRange(3, 3);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(1);
  const bar = view.el.querySelector('.formula-input');
  bar.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  bar.focus();
  bar.setSelectionRange(3, 3);
  bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
  bar.dispatchEvent(left);
  await vi.advanceTimersByTimeAsync(1);
  // The browser moves the caret; nothing was put into the formula.
  expect(left.defaultPrevented).toBe(false);
  expect(bar.value).toBe('=1+');
  expect(view.el.querySelector('.status-mode').textContent).toBe('Edit');
});
