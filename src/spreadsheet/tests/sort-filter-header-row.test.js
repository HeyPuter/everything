// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { sortHeaderDefault } from '../src/ui/sortdialog.js';

// A filtered list whose headers are numbers (years over the figures under them) had its header row sorted in among
// the records by a quick sort from one of its cells: the header was read from what the first row held, and a number
// is no header by that rule. Excel takes the first row of a filtered list for its header whatever it holds, and so
// does the app now, for the quick sort and for the Sort and Remove Duplicates dialogs' "has a header row" default.
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

const YEARS = [[2023, 2024], [5, 1], [3, 2], [9, 0]];

it('keeps a filtered list\'s number header in place when sorting from one of its cells', async () => {
  const { wb, id, column } = await mount(YEARS);
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 3, c2: 1 });
  await select('A2');
  await sortAZ();
  expect(column(0)).toEqual([2023, 3, 5, 9]);
  expect(column(1)).toEqual([2024, 2, 1, 0]);
});

it('starts the sort and duplicate dialogs with the filtered list\'s first row taken for its header', async () => {
  const { wb, id } = await mount(YEARS);
  const range = { r1: 0, c1: 0, r2: 3, c2: 1 };
  expect(sortHeaderDefault(wb, id, range, { expanded: true })).toBe(false);
  wb.setFilterRange(id, range);
  expect(sortHeaderDefault(wb, id, range, { expanded: true })).toBe(true);
  expect(sortHeaderDefault(wb, id, range)).toBe(true);
  // A range starting below the filter's header row is not given one.
  expect(sortHeaderDefault(wb, id, { ...range, r1: 1 })).toBe(false);
});
