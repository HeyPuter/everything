// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { setLocale } from '../src/core/format.js';

// F9 on part of a formula replaces it with its value. A number went in as the cell would show it: cut to ten digits
// (=1/3 became =0.3333333333) and, in a regional format with a decimal comma, written with the comma, which a
// formula reads as an argument separator: =A1*2 with A1 holding 0,75 became =0,75*2, and Enter stored #VALUE!.
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
afterEach(() => { setLocale('en-US'); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });


async function editFormula(text, prep) {
  const doc = new Doc({ name: 'F9', path: 'Spreadsheets/F9.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  prep?.(wb, id);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = text;
  editor.setSelectionRange(text.length, text.length);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id, editor };
}
const f9 = (editor) => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', bubbles: true, cancelable: true }));

it('puts a number into the formula with all fifteen of its digits', async () => {
  const { editor } = await editFormula('=1/3');
  f9(editor);
  expect(editor.value).toBe('=0.333333333333333');
});

it('writes the number with a full stop where the regional format uses a decimal comma', async () => {
  setLocale('de-DE');
  const { wb, id, editor } = await editFormula('=A2*2', (wb, id) => wb.setInput(id, 1, 0, '0,75'));
  editor.setSelectionRange(1, 3);
  f9(editor);
  expect(editor.value).toBe('=0.75*2');
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getValue(id, 0, 0)).toBe(1.5);
});

it('writes a very large or small number in E notation a formula reads', async () => {
  const { wb, id, editor } = await editFormula('=A2*1', (wb, id) => wb.setInput(id, 1, 0, '1.5E+21'));
  editor.setSelectionRange(1, 3);
  f9(editor);
  expect(editor.value).toBe('=1.5E+21*1');
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getValue(id, 0, 0)).toBe(1.5e21);
});
