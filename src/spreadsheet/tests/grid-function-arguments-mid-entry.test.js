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

// A call already written after the name was left where it was, the dialog's call put in front of it:
// =SUM(B1,B2)*2 with Ctrl+A after SUM opened with empty fields, and OK gave =SUM()(B1,B2)*2.
it('fills the fields from a call already written and replaces that call whole', async () => {
  const { wb, id, editor } = await editFormula('=SUM(B1,IF(B2>0,"a,b",B2),{1,2})*2', 4);
  const inputs = () => [...dialog().querySelectorAll('input')].map((i) => i.value);
  expect(inputs().slice(0, 3)).toEqual(['B1', 'IF(B2>0,"a,b",B2)', '{1,2}']);
  dialog().requestSubmit();
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.value).toBe('=SUM(B1, IF(B2>0,"a,b",B2), {1,2})*2');
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getCell(id, 0, 0)?.f).toBe('SUM(B1, IF(B2>0,"a,b",B2), {1,2})*2');
});

it('reads the call from just inside its parenthesis too, and one not yet closed', async () => {
  const { editor } = await editFormula("=ROUND('My, sheet'!B1,2", 7);
  expect([...dialog().querySelectorAll('input')].map((i) => i.value)).toEqual(["'My, sheet'!B1", '2']);
  dialog().requestSubmit();
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.value).toBe("=ROUND('My, sheet'!B1, 2)");
});

// A call written with more arguments than its signature lists (AGGREGATE's reference form takes ref1, ref2, ...)
// kept only the listed ones: OK on =AGGREGATE(9,6,B1,B2,B3) gave =AGGREGATE(9, 6, B1, B2), B3 gone. Every argument
// written now has a field of its own.
it('keeps every argument already written, past those its signature lists', async () => {
  const { editor } = await editFormula('=AGGREGATE(9,6,B1,B2,B3)', 10);
  const inputs = [...dialog().querySelectorAll('input')].map((i) => i.value);
  expect(inputs).toEqual(['9', '6', 'B1', 'B2', 'B3']);
  dialog().requestSubmit();
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.value).toBe('=AGGREGATE(9, 6, B1, B2, B3)');
});

// Fields past the signature were capped at the 30 the dialog offers for new arguments, so OK on a SUM of 40 numbers
// dropped the last 10 without a word, where it had kept them all before.
it('keeps every argument of a long call, past the fields it offers for new ones', async () => {
  const args = Array.from({ length: 40 }, (_, i) => String(i + 1));
  const { editor } = await editFormula(`=SUM(${args.join(',')})`, 5);
  expect([...dialog().querySelectorAll('input')].map((i) => i.value)).toEqual(args);
  dialog().requestSubmit();
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.value).toBe(`=SUM(${args.join(', ')})`);
});
