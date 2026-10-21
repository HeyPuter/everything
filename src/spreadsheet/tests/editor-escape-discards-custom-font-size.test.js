// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';

// Escape gives up an entry with the formatting applied while it was typed. A size chosen in Format ▸ Custom font
// size mid-entry was written once its question was answered, after the entry's formatting had been counted, so
// Escape threw the text away and kept the size, with an undo step for a cell nobody had changed.
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
const press = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

it('takes back a custom font size chosen while the entry was typed', async () => {
  const { wb, id, editor } = await mount();
  const before = wb.undoLabels(50).length;
  view.run('fontSize');
  await vi.advanceTimersByTimeAsync(1);
  const input = document.querySelector('.modal-panel input');
  input.value = '20';
  input.closest('form').requestSubmit();
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getCell(id, 0, 0)?.s?.size).toBeGreaterThan(20);
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(true);
  press(editor, 'Escape');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getValue(id, 0, 0)).toBe(null);
  expect(wb.getCell(id, 0, 0)?.s?.size).toBeFalsy();
  expect(wb.undoLabels(50).length).toBe(before);
});
