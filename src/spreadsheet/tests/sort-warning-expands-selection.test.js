// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { sortExpansion } from '../src/ui/sortdialog.js';
import { Workbook } from '../src/core/workbook.js';

// Selecting the scores of a list (B2:B4) and sorting sorted that column alone: every score moved away from
// its name and city with no word of warning. Excel asks first (Sort Warning) and expands the selection to
// the whole list by default; so does the app now, for Sort A to Z and for the Sort range dialog.
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

const LIST = [['Name', 'Score', 'City'], ['Ann', '30', 'Oslo'], ['Bob', '10', 'Rome'], ['Cid', '20', 'Lima']];

async function open() {
  const doc = new Doc({ name: 'Sort', path: 'Spreadsheets/Sort.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  LIST.forEach((row, r) => row.forEach((t, c) => wb.setInput(id, r, c, t)));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!B2:B4');
  await vi.advanceTimersByTimeAsync(1);
  const rows = () => LIST.map((_, r) => [0, 1, 2].map((c) => wb.getDisplay(id, r, c)).join('|'));
  return { wb, id, rows };
}

const warning = () => [...document.querySelectorAll('.modal-root:not(.closing) .modal-panel')].find((p) => p.getAttribute('aria-label') === 'Sort warning');

it('asks before sorting one column of a list, and expands the selection by default', async () => {
  const { rows } = await open();
  view.run('sort');
  await vi.advanceTimersByTimeAsync(1);
  expect(warning()).toBeTruthy();
  expect(rows()).toEqual(['Name|Score|City', 'Ann|30|Oslo', 'Bob|10|Rome', 'Cid|20|Lima']);
  warning().querySelector('button[type=submit]').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(rows()).toEqual(['Name|Score|City', 'Bob|10|Rome', 'Cid|20|Lima', 'Ann|30|Oslo']);
});

it('sorts only the selection when asked to continue with it, and nothing when cancelled', async () => {
  const { rows } = await open();
  view.run('sort');
  await vi.advanceTimersByTimeAsync(1);
  warning().querySelector('button.btn-ghost').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(rows()).toEqual(['Name|Score|City', 'Ann|30|Oslo', 'Bob|10|Rome', 'Cid|20|Lima']);
  view.run('sort');
  await vi.advanceTimersByTimeAsync(1);
  warning().querySelector('input[value=selection]').checked = true;
  warning().querySelector('button[type=submit]').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(rows()).toEqual(['Name|Score|City', 'Ann|10|Oslo', 'Bob|20|Rome', 'Cid|30|Lima']);
});

it('opens the Sort range dialog over the whole list once the selection is expanded', async () => {
  await open();
  view.run('sortDialog');
  await vi.advanceTimersByTimeAsync(1);
  warning().querySelector('button[type=submit]').click();
  await vi.advanceTimersByTimeAsync(1);
  const dialog = document.querySelector('.modal-root:not(.closing) .sort-dialog');
  expect(dialog.textContent).toContain('Sorting A1:C4');
  expect(dialog.querySelector('input[type=checkbox]').checked).toBe(true);
});

it('offers nothing for a selection with no data beside it, or inside a table', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  LIST.forEach((row, r) => row.forEach((t, c) => wb.setInput(id, r, c, t)));
  expect(sortExpansion(wb, id, { r1: 1, c1: 1, r2: 3, c2: 1 })).toEqual({ r1: 0, c1: 0, r2: 3, c2: 2 });
  expect(sortExpansion(wb, id, { r1: 1, c1: 0, r2: 3, c2: 2 })).toBe(null);
  wb.setInput(id, 0, 6, 'Solo');
  wb.setInput(id, 1, 6, 'b');
  wb.setInput(id, 2, 6, 'a');
  expect(sortExpansion(wb, id, { r1: 1, c1: 6, r2: 2, c2: 6 })).toBe(null);
  wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 2 });
  expect(sortExpansion(wb, id, { r1: 1, c1: 1, r2: 3, c2: 1 })).toBe(null);
});
