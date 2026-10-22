// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// AutoSum over a selected range always wrote the result one row under the
// range: a whole column put it past the end of the sheet, a single row of
// numbers had its result under the first one, and whatever sat there was
// silently overwritten.
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

async function mount(prep) {
  const doc = new Doc({ name: 'Sums', path: 'Spreadsheets/Sums.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  prep(wb, id);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id };
}
async function select(text) {
  const name = view.el.querySelector('[aria-label="Cell reference"]');
  name.value = text;
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
}
const menuItem = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);
async function autoSum() {
  view.el.querySelector('[data-menu="insert"]').click();
  menuItem('Function').click();
  menuItem('AutoSum').click();
  await vi.advanceTimersByTimeAsync(1);
}
const active = () => view.el.querySelector('.grid-viewport').getAttribute('aria-activedescendant');

it('sums a whole column under its last number instead of past the end of the sheet', async () => {
  const { wb, id } = await mount((wb, id) => { for (let r = 0; r < 5; r++) wb.setInput(id, r, 0, String(r + 1)); });
  const rows = wb.sheet(id).rows;
  await select('A:A');
  await autoSum();
  expect(wb.getCell(id, 5, 0).f).toBe('SUM(A1:A5)');
  expect(wb.getValue(id, 5, 0)).toBe(15);
  expect(wb.sheet(id).rows).toBe(rows);
  expect(wb.getCell(id, rows, 0)).toBeFalsy();
  expect(active()).toBe('gc-5-0');
});

it('puts the sum of a single row to its right', async () => {
  const { wb, id } = await mount((wb, id) => { for (let c = 1; c <= 3; c++) { wb.setInput(id, 1, c, String(c * 10)); wb.setInput(id, 2, c, 'keep'); } });
  await select('B2:D2');
  await autoSum();
  expect(wb.getCell(id, 1, 4).f).toBe('SUM(B2:D2)');
  expect(wb.getValue(id, 1, 4)).toBe(60);
  expect(wb.getValue(id, 2, 1)).toBe('keep');
  expect(active()).toBe('gc-1-4');
});

it('opens the formula for editing instead of overwriting a cell that holds something', async () => {
  const { wb, id } = await mount((wb, id) => { wb.setInput(id, 0, 0, '1'); wb.setInput(id, 1, 0, '2'); wb.setInput(id, 2, 0, 'Total'); });
  await select('A1:A2');
  await autoSum();
  expect(wb.getValue(id, 2, 0)).toBe('Total');
  expect(active()).toBe('gc-2-0');
  const editor = view.el.querySelector('.grid-editor');
  expect(editor.value).toBe('=SUM(A1:A2)');
  expect(document.activeElement).toBe(editor);
});

it('inserts SUM( at the caret while a cell is being edited, leaving the cell behind and the selection alone', async () => {
  const { wb, id } = await mount((wb, id) => { for (let r = 0; r < 3; r++) wb.setInput(id, r, 0, String(r + 1)); });
  await select('A4');
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  expect(editor.value).toBe('x');
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: '=', altKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.value).toBe('xSUM(');
  expect(wb.getCell(id, 3, 0)?.f ?? null).toBeNull();
  expect(active()).toBe('gc-3-0');
});

it('keeps a filled selection summed just below it', async () => {
  const { wb, id } = await mount((wb, id) => { for (let r = 1; r <= 3; r++) for (let c = 1; c <= 2; c++) wb.setInput(id, r, c, '1'); });
  await select('B2:C4');
  await autoSum();
  // Each column is totalled under itself, as in Excel (see autosum-block-per-column).
  expect(wb.getCell(id, 4, 1).f).toBe('SUM(B2:B4)');
  expect(wb.getValue(id, 4, 1)).toBe(3);
  expect(wb.getCell(id, 4, 2).f).toBe('SUM(C2:C4)');
});
