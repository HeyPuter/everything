// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Ctrl/Cmd+B while typing styles the cell at once, as its own undo step. Escape then threw the text
// away but kept the bold; Excel discards the formatting with the entry, and so does the app now.
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

async function mount() {
  const doc = new Doc({ name: 'Style', path: 'Spreadsheets/Style.xlsx' });
  doc.wb.setInput(doc.wb.activeSheetId, 1, 0, 'kept');
  const wb = doc.wb;
  const id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = 'hello';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id, editor };
}
const chord = (target, key) => {
  const e = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
};
const press = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

it('takes back the formatting applied during an entry given up with Escape', async () => {
  const { wb, id, editor } = await mount();
  const before = wb.undoLabels(50).length;
  chord(editor, 'b');
  chord(editor, 'i');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getCell(id, 0, 0).s).toMatchObject({ bold: true, italic: true });
  press(editor, 'Escape');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getValue(id, 0, 0)).toBe(null);
  expect(wb.getCell(id, 0, 0)?.s?.bold).toBeFalsy();
  expect(wb.getCell(id, 0, 0)?.s?.italic).toBeFalsy();
  // Nothing is left to undo or redo of the entry; earlier work is untouched.
  expect(wb.undoLabels(50).length).toBe(before);
  expect(wb.canRedo()).toBe(false);
  expect(wb.getValue(id, 1, 0)).toBe('kept');
});

it('keeps the formatting when the entry is committed, and leaves earlier steps alone on a later Escape', async () => {
  const { wb, id, editor } = await mount();
  chord(editor, 'b');
  press(editor, 'Enter');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getValue(id, 0, 0)).toBe('hello');
  expect(wb.getCell(id, 0, 0).s.bold).toBe(true);
  // A new entry on the next cell, given up without formatting anything, takes back nothing.
  const viewport = document.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  press(editor, 'Escape');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getCell(id, 0, 0).s.bold).toBe(true);
  expect(wb.getValue(id, 0, 0)).toBe('hello');
});
