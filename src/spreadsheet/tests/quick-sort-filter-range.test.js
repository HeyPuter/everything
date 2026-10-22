// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// The quick sort from a single cell kept a header row in place only when the
// sorted column held text over numbers, so sorting a text column moved "Name"
// in among the names. The block around the cell is now read for a header the way
// the sort dialog reads it; an explicit selection keeps its first row only when
// a text row sits over typed values, so a plain list of names still sorts whole.
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
afterEach(() => { closeMenu(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount(rows) {
  const doc = new Doc({ name: 'Sort', path: 'Spreadsheets/Sort.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id, column: (c) => rows.map((_, r) => wb.getValue(id, r, c)) };
}
async function select(text) {
  const name = view.el.querySelector('[aria-label="Cell reference"]');
  name.value = text;
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
}
const menuItem = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);
async function sortAZ() {
  view.el.querySelector('[data-menu="data"]').click();
  menuItem('Sort').click();
  menuItem('Sort range A to Z').click();
  await vi.advanceTimersByTimeAsync(1);
}

it('sorts the whole filtered list from one of its cells, past a blank row inside it', async () => {
  const { wb, id, column } = await mount([['Name', 'Qty'], ['d', 4], ['b', 2], ['', ''], ['c', 3], ['a', 1]]);
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 5, c2: 1 });
  await select('A2');
  await sortAZ();
  expect(column(0)).toEqual(['Name', 'a', 'b', 'c', 'd', null]);
  expect(column(1)).toEqual(['Qty', 1, 2, 3, 4, null]);
});

it('sorts the whole table from one of its cells, past a blank row inside it', async () => {
  const { wb, id, column } = await mount([['Name', 'Qty'], ['d', 4], ['b', 2], ['', ''], ['c', 3], ['a', 1]]);
  wb.addTable(id, { r1: 0, c1: 0, r2: 5, c2: 1 });
  await select('B6');
  await sortAZ();
  expect(column(0)).toEqual(['Name', 'a', 'b', 'c', 'd', null]);
  expect(column(1)).toEqual(['Qty', 1, 2, 3, 4, null]);
});

it('opens the Sort dialog on the whole filtered list', async () => {
  const { wb, id } = await mount([['Name', 'Qty'], ['d', 4], ['b', 2], ['', ''], ['c', 3], ['a', 1]]);
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 5, c2: 1 });
  await select('A2');
  await view.run('sortDialog');
  expect(document.querySelector('.sort-form .modal-text').textContent).toMatch(/^Sorting A1:B6\./);
});
