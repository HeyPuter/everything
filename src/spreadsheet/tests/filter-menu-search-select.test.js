// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { isMenuOpen } from '../src/ui/menu.js';
import * as notifications from '../src/ui/toast.js';

// Select all and Clear in the column filter menu act on the values the search box finds, as the list shows
// them (and as Excel's Select All Search Results and the query editor's list do): with "pen" typed, Clear
// unticked every value of the column, so ticking a pen and pressing Apply hid everything else too.
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

/** Column A under a header, filtered over rows 1..n; `prepare` shapes the workbook before the menu opens on A1. */
async function mount(values, prepare = () => {}) {
  const doc = new Doc({ name: 'List', path: 'Spreadsheets/List.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Key');
  values.forEach((v, i) => wb.setInput(id, i + 1, 0, v));
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: values.length, c2: 0 });
  prepare(wb, id);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(isMenuOpen()).toBe(true);
  const button = (label) => [...document.querySelectorAll('.menu .filter-actions button')].find((b) => b.textContent === label);
  return { wb, id, button, summary: () => document.querySelector('.menu .filter-summary').textContent };
}


const search = async (text) => {
  const box = document.querySelector('.menu input[type="search"]');
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(1);
};

it('clears only the values the search finds', async () => {
  const { wb, id, button, summary } = await mount(['Pens', 'Pencils', 'Ink', 'Clips']);
  await search('pen');
  button('Clear').click();
  expect(summary()).toBe('2 of 4 selected');
  button('Apply').click();
  const hidden = [...wb.sheet(id).filterHidden].sort();
  expect(hidden).toEqual([1, 2]);
});

it('selects only the values the search finds', async () => {
  const { wb, id, button, summary } = await mount(['Pens', 'Pencils', 'Ink', 'Clips']);
  button('Clear').click();
  await search('pen');
  button('Select all').click();
  expect(summary()).toBe('2 of 4 selected');
  button('Apply').click();
  expect([...wb.sheet(id).filterHidden].sort()).toEqual([3, 4]);
});

it('acts on every value with the search box empty', async () => {
  const { button, summary } = await mount(['Pens', 'Ink']);
  button('Clear').click();
  expect(summary()).toBe('0 of 2 selected');
  button('Select all').click();
  expect(summary()).toBe('2 of 2 selected');
});

// Excel's quickest filter: type into the search box and press Enter, and only the values found stay in view.
// With no box touched the search did nothing: every value was still ticked, so Apply cleared the filter.
it('keeps only the values found when the search is applied without touching a box', async () => {
  const { wb, id, summary } = await mount(['Pens', 'Pencils', 'Ink', 'Clips']);
  await search('pen');
  expect(summary()).toBe('2 of 4 selected');
  document.querySelector('.menu input[type="search"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect([...wb.sheet(id).filterHidden].sort()).toEqual([3, 4]);
});

it('keeps only the found values that are still ticked', async () => {
  const { wb, id, button } = await mount(['Pens', 'Pencils', 'Ink', 'Clips'], (wb, id) => {
    wb.setFilterCriteria(id, 0, { values: ['Pens', 'Ink'] });
  });
  await search('pen');
  button('Apply').click();
  expect([...wb.sheet(id).filterHidden].sort()).toEqual([2, 3, 4]);
});

it('hides nothing for a search that finds no value', async () => {
  const { wb, id, button } = await mount(['Pens', 'Ink']);
  await search('zzz');
  button('Apply').click();
  expect([...wb.sheet(id).filterHidden]).toEqual([]);
});
