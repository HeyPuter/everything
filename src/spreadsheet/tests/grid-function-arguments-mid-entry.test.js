// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';

// Ctrl+A after a function's name in a formula being typed opens Function Arguments for it. The entry was given
// up as the dialog opened, and its OK entered the call alone: typing =A1+SUM, Ctrl+A and OK left =SUM(...),
// the A1+ before it and anything after it gone. The call now takes the name's place in the entry, as in Excel.
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
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });


async function editFormula(text, caret = text.length) {
  const doc = new Doc({ name: 'Args', path: 'Spreadsheets/Args.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 1, '2');
  wb.setInput(id, 1, 1, '3');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = text;
  editor.setSelectionRange(caret, caret);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(1);
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id, editor };
}
const dialog = () => document.querySelector('.fn-args');

it('puts the call in place of the name, keeping the rest of the entry', async () => {
  const { wb, id, editor } = await editFormula('=10+SUM*2', 7);
  expect(dialog()).toBeTruthy();
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(true);
  dialog().querySelector('input').value = 'B1:B2';
  dialog().querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
  dialog().requestSubmit();
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.value).toBe('=10+SUM(B1:B2)*2');
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getCell(id, 0, 0)?.f).toBe('10+SUM(B1:B2)*2');
  expect(wb.getValue(id, 0, 0)).toBe(20);
});

it('takes in the parenthesis typed after the name', async () => {
  const { editor } = await editFormula('=1+SUM(', 7);
  dialog().querySelector('input').value = 'B1';
  dialog().querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
  dialog().requestSubmit();
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.value).toBe('=1+SUM(B1)');
});

it('leaves the entry as it was when the dialog is cancelled', async () => {
  const { editor } = await editFormula('=1+SUM');
  [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(true);
  expect(editor.value).toBe('=1+SUM');
});
