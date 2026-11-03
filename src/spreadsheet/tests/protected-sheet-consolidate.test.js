// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as notifications from '../src/ui/toast.js';

// Data ▸ Consolidate… on a protected sheet with a locked cell active opened; references were added one by one and
// only OK brought the notice that the cell is protected. The table goes in from the active cell, so a locked one
// says so at once; an unlocked cell of a protected sheet (a form's entry area) still takes it.
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

async function mount({ locked = true, unlocked = false } = {}) {
  const doc = new Doc({ name: 'Data', path: 'Spreadsheets/Consolidate.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  [['Region', 'Sales'], ['East', 3], ['West', 1], ['East', 2]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  if (unlocked) wb.applyStyle(id, { r1: 0, c1: 4, r2: 9, c2: 6 }, { locked: false });
  if (locked) wb.setSheetProtected(id, true);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!E1');
  await vi.advanceTimersByTimeAsync(1);
  const toast = vi.spyOn(notifications, 'toast');
  return { wb, id, toast };
}
const dialog = () => document.querySelector('.modal-root:not(.closing) .modal-panel');
const refusedNow = (toast) => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Sheet1 is protected/), expect.objectContaining({ icon: 'lock' }));

/** Each attempt gets its own notice: the protected notice is shown at most once every few seconds. */
async function attempt(toast, run) {
  closeAllModals();
  await vi.advanceTimersByTimeAsync(3000);
  toast.mockClear();
  await run();
  await vi.advanceTimersByTimeAsync(1);
}

it('says the sheet is protected before Consolidate is filled in over a locked cell', async () => {
  const { toast } = await mount();
  await attempt(toast, () => view.run('consolidate'));
  expect(dialog()).toBeNull();
  refusedNow(toast);
});

it('opens it over an unlocked cell of a protected sheet, which takes the table', async () => {
  const { wb, id, toast } = await mount({ unlocked: true });
  await attempt(toast, () => view.run('consolidate'));
  expect(dialog()?.getAttribute('aria-label')).toBe('Consolidate');
  expect(toast).not.toHaveBeenCalled();
  closeAllModals();
  await view.run('consolidate', { fn: 'sum', refs: ['Sheet1!A1:B4'], topRow: true, leftColumn: true });
  expect(wb.getValue(id, 1, 5)).toBe(5);
  expect(wb.getValue(id, 2, 5)).toBe(1);
});

it('opens it on a sheet open to changes', async () => {
  const { toast } = await mount({ locked: false });
  await attempt(toast, () => view.run('consolidate'));
  expect(dialog()?.getAttribute('aria-label')).toBe('Consolidate');
});
