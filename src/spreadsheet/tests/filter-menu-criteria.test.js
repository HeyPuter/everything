// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { isMenuOpen } from '../src/ui/menu.js';
import * as notifications from '../src/ui/toast.js';

// The column filter menu against its stored criteria: values that are no longer in the column
// inflated the summary and survived "Select all"; a colour filter was dropped by Apply; a sort the
// workbook refused said nothing; and a list cut at 300 values did not say so.
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

it('counts only the listed values as selected and clears the filter when they are all chosen', async () => {
  const { wb, id, button, summary } = await mount(['x', 'y', 'x'], (wb, id) => {
    wb.setFilterCriteria(id, 0, { values: ['x', 'y'] });
    wb.setInput(id, 2, 0, 'x'); // "y" leaves the column; the stored criteria still name it
  });
  expect(summary()).toBe('1 of 1 selected');
  button('Select all').click();
  expect(summary()).toBe('1 of 1 selected');
  button('Apply').click();
  expect(wb.sheet(id).filter.criteria[0]).toBeUndefined();
});

it('keeps a colour filter when Apply is pressed without choosing values or a condition', async () => {
  const { wb, id, button } = await mount(['x', 'y'], (wb, id) => {
    wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { bg: '#ff0000' });
    wb.setFilterCriteria(id, 0, { color: '#ff0000' });
  });
  // The chosen fill is marked with aria-checked, as every other swatch grid in the app marks its choice.
  const swatches = [...document.querySelectorAll('.menu .filter-colors .swatch')];
  expect(swatches.length).toBeGreaterThan(1);
  expect(swatches.every((s) => s.getAttribute('role') === 'menuitemradio')).toBe(true);
  expect(swatches.filter((s) => s.getAttribute('aria-checked') === 'true').map((s) => s.getAttribute('aria-label'))).toEqual(['Fill #ff0000 (1)']);
  expect(document.querySelector('.menu .swatch.selected')).toBeNull();
  button('Apply').click();
  expect(wb.sheet(id).filter.criteria[0]).toEqual({ color: '#ff0000' });
});

it('keeps a condition kept from a file (a Top 10) when Apply is pressed without choosing values', async () => {
  // Every value listed reads as chosen under such a condition, so Apply cleared it and showed every row it hid.
  const { wb, id, button, summary } = await mount(['1', '2', '3', '4'], (wb, id) => {
    wb.setFilterCriteria(id, 0, { native: '<top10 val="2"/>' });
  });
  expect(wb.isRowHidden(id, 1)).toBe(true);
  expect(summary()).toBe('4 of 4 selected');
  button('Apply').click();
  expect(wb.sheet(id).filter.criteria[0]).toEqual({ native: '<top10 val="2"/>' });
  expect([1, 2, 3, 4].map((r) => wb.isRowHidden(id, r))).toEqual([true, true, false, false]);
});

it('marks no fill swatch when the column is not filtered by colour, and follows the choice', async () => {
  const { wb, id } = await mount(['x', 'y'], (wb, id) => {
    wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { bg: '#ff0000' });
  });
  const swatches = () => [...document.querySelectorAll('.menu .filter-colors .swatch')];
  expect(swatches().map((s) => s.getAttribute('aria-checked'))).toEqual(swatches().map(() => 'false'));
  swatches().find((s) => s.getAttribute('aria-label')?.startsWith('Fill #ff0000')).click();
  expect(wb.sheet(id).filter.criteria[0]).toEqual({ color: '#ff0000' });
});

it('says why the workbook refused to sort from the filter menu', async () => {
  const { wb } = await mount(['b', 'a', 'c'], (wb, id) => { wb.mergeCells(id, { r1: 1, c1: 0, r2: 2, c2: 0 }); });
  const toast = vi.spyOn(notifications, 'toast');
  [...document.querySelectorAll('.menu [role="menuitem"]')].find((b) => b.textContent.includes('Sort A to Z')).click();
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/merged cells/), expect.objectContaining({ icon: 'info' }));
  expect(wb.getValue(wb.activeSheetId, 1, 0)).toBe('b');
});

it('says when the value list shows only the first 300 of the column’s values', async () => {
  const values = Array.from({ length: 305 }, (_, i) => `v${String(i).padStart(3, '0')}`);
  const { summary } = await mount(values);
  expect(document.querySelectorAll('.menu .filter-value')).toHaveLength(300);
  expect(document.querySelector('.menu .filter-values .menu-header')?.textContent).toBe('Showing 300 of 305 values. Type to find the rest');
  expect(summary()).toBe('305 of 305 selected');
  const search = document.querySelector('.menu [aria-label="Search values"]');
  search.value = 'v30';
  search.dispatchEvent(new Event('input'));
  expect(document.querySelectorAll('.menu .filter-value')).toHaveLength(5);
  expect(document.querySelector('.menu .filter-values .menu-header')).toBeNull();
});
