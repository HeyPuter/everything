// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// F2 while a formula is typed switches between Enter and Edit mode. Pressed just after a reference was picked with
// the arrows (Point mode, as the status bar says), it changed nothing that counted: the arrows went on moving the
// reference rather than the caret, and the status bar still said Point. As in Excel, F2 there goes to Edit mode.
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

it('goes from Point mode to Edit mode on F2', async () => {
  const doc = new Doc({ name: 'Point', path: 'Spreadsheets/Point.xlsx' });
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
  const press = (key) => { const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); editor.dispatchEvent(e); return e; };
  press('ArrowDown');
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.value).toBe('=1+A2');
  const mode = () => view.el.querySelector('.status-mode').textContent;
  expect(mode()).toBe('Point');
  press('F2');
  await vi.advanceTimersByTimeAsync(1);
  expect(mode()).toBe('Edit');
  // The browser moves the caret; the reference stays as picked.
  expect(press('ArrowDown').defaultPrevented).toBe(false);
  expect(press('ArrowLeft').defaultPrevented).toBe(false);
  expect(editor.value).toBe('=1+A2');
});
