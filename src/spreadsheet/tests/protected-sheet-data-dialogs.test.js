// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import * as notifications from '../src/ui/toast.js';

// On a protected sheet with A1:B4 selected, Sort…, Subtotals… and Create Table… (and the table dialog of a table
// already there) opened, were filled in, and refused only at OK. They now say the sheet is protected at once, from
// every entry point, as the quick sort says it; on a sheet open to changes they open as before.
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
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount({ locked = true, table = false } = {}) {
  const doc = new Doc({ name: 'Data', path: 'Spreadsheets/Data.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  [['Region', 'Sales'], ['East', 3], ['West', 1], ['East', 2]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  if (table) wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 1 }, { name: 'Sales' });
  if (locked) wb.setSheetProtected(id, true);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!A1:B4');
  await vi.advanceTimersByTimeAsync(1);
  const toast = vi.spyOn(notifications, 'toast');
  return { wb, id, toast };
}
const dialog = () => document.querySelector('.modal-root:not(.closing) .modal-panel');
const item = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);
const refusedNow = (toast) => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Sheet1 is protected/), expect.objectContaining({ icon: 'lock' }));

/** Each attempt gets its own notice: the protected notice is shown at most once every few seconds. */
async function attempt(toast, run) {
  closeMenu(); closeAllModals();
  await vi.advanceTimersByTimeAsync(3000);
  toast.mockClear();
  await run();
  await vi.advanceTimersByTimeAsync(1);
}

it('says the sheet is protected before Sort, Subtotals or Create Table is filled in', async () => {
  const { wb, id, toast } = await mount();
  for (const cmd of ['sortDialog', 'subtotal', 'insertTable']) {
    await attempt(toast, () => view.run(cmd));
    expect(dialog(), cmd).toBeNull();
    refusedNow(toast);
  }
  // The Data menu goes the same way.
  await attempt(toast, async () => {
    view.el.querySelector('[data-menu="data"]').click();
    item('Sort').click(); await vi.advanceTimersByTimeAsync(1);
    item('Sort range…').click();
  });
  expect(dialog()).toBeNull();
  refusedNow(toast);
  expect(wb.tablesOn(id)).toHaveLength(0);
});

it('says so before the table dialog of a table already there opens', async () => {
  const { toast } = await mount({ table: true });
  for (const cmd of ['insertTable', 'editTable']) {
    await attempt(toast, () => view.run(cmd));
    expect(dialog(), cmd).toBeNull();
    refusedNow(toast);
  }
});

it('opens them on a sheet open to changes', async () => {
  const { toast } = await mount({ locked: false });
  for (const [cmd, label] of [['sortDialog', 'Sort range'], ['subtotal', 'Subtotals'], ['insertTable', 'Create table']]) {
    await attempt(toast, () => view.run(cmd));
    expect(dialog()?.getAttribute('aria-label'), cmd).toBe(label);
  }
});
