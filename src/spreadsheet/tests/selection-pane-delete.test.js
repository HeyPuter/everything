// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { memoryStorage } from './helpers/memory-storage.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

let view;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  vi.stubGlobal('matchMedia', (q) => ({ matches: !/max-width/.test(q), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  if (!globalThis.CSS?.escape) vi.stubGlobal('CSS', { escape: (s) => String(s).replace(/["\\]/g, '\\$&') });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (t) => ({ width: t.length * 7 }) });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  view?.destroy(); view = null;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// Delete in the Selection Pane did nothing to the objects picked there (nor did Backspace), though the pane is
// the keyboard's way to reach them. It removes them now, as the key does on the sheet, and the cells under them
// are left alone.
it('deletes the objects picked in the Selection Pane with Delete', async () => {
  const doc = new Doc({ name: 'Objects', path: 'Spreadsheets/Objects.xlsx' }), wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'keep');
  const mk = (r, text) => wb.addChart(id, { type: 'text', text, anchor: { r, c: 1 }, w: 120, h: 50 });
  mk(1, 'Back'); mk(5, 'Middle'); mk(9, 'Front');
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.run('selectionPane');
  await vi.advanceTimersByTimeAsync(1);
  const list = document.querySelector('.selpane-list');
  const press = async (key, shiftKey = false) => { list.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })); await vi.advanceTimersByTimeAsync(1); };
  const texts = () => wb.sheet(id).charts.map(o => o.text);
  await press('ArrowDown');
  await press('Delete');
  expect(texts()).toEqual(['Back', 'Middle']);
  await press('ArrowDown'); await press('ArrowDown', true);
  await press('Backspace');
  expect(texts()).toEqual([]);
  expect(wb.getValue(id, 0, 0)).toBe('keep');
  expect(document.activeElement).toBe(list);
});
