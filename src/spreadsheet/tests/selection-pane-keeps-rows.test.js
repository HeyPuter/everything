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

// The Selection Pane drew every row afresh, icons and all, whenever the selection changed: with a thousand
// objects on the sheet each press of an arrow key in the pane (or click on a row) took 25-160 ms, as the list
// was rebuilt only to move the mark. The rows now stay while only the selection changes, and are marked again.
it('keeps its rows and moves the mark when only the selection changes', async () => {
  const doc = new Doc({ name: 'Objects', path: 'Spreadsheets/Objects.xlsx' }), wb = doc.wb, id = wb.activeSheetId;
  for (let i = 0; i < 6; i++) wb.addChart(id, { type: 'text', text: `T${i}`, anchor: { r: i * 3, c: 1 }, w: 120, h: 50 });
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.run('selectionPane');
  await vi.advanceTimersByTimeAsync(1);
  const list = document.querySelector('.selpane-list');
  const rows = [...list.children];
  const press = async (key) => { list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await vi.advanceTimersByTimeAsync(1); };
  const picked = () => [...list.children].map((r) => r.getAttribute('aria-selected'));
  await press('ArrowDown');
  expect(picked()).toEqual(['true', 'false', 'false', 'false', 'false', 'false']);
  await press('ArrowDown');
  expect(picked()).toEqual(['false', 'true', 'false', 'false', 'false', 'false']);
  expect(list.getAttribute('aria-activedescendant')).toBe(rows[1].id);
  rows[3].click();
  await vi.advanceTimersByTimeAsync(1);
  expect(picked()).toEqual(['false', 'false', 'false', 'true', 'false', 'false']);
  expect([...list.children].every((r, i) => r === rows[i])).toBe(true);
  expect(document.querySelector('.selpane-tool[aria-label="Bring Forward"]').disabled).toBe(false);
  // A change to the objects draws the rows again.
  view.run('objectsVisible', { ids: [wb.sheet(id).charts[0].id], hidden: true });
  await vi.advanceTimersByTimeAsync(1);
  expect(list.children[5]).not.toBe(rows[5]);
  expect(list.children[5].classList.contains('is-hidden')).toBe(true);
  expect(picked()).toEqual(['false', 'false', 'false', 'true', 'false', 'false']);
});
