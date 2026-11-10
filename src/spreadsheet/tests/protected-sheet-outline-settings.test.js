// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import * as notifications from '../src/ui/toast.js';

// Data ▸ Outline ▸ Outline settings… opened on a protected sheet, and its OK wrote the settings past the protection
// (Create and Apply Styles were then refused): a sheet whose outline is kept had its summary rows moved above
// their detail. The sheet's protection is said before the dialog opens, and a dialog left open while the sheet was
// protected writes nothing.
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

async function mount({ locked = true } = {}) {
  const doc = new Doc({ name: 'Data', path: 'Spreadsheets/Outline.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  [['Region', 'Sales'], ['East', 3], ['West', 1], ['East', 2]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
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

const SETTINGS = { summaryBelow: false, summaryRight: false, autoStyles: true };

it('says the sheet is protected before Outline settings opens', async () => {
  const { toast } = await mount();
  await attempt(toast, () => view.run('outlineSettings'));
  expect(dialog()).toBeNull();
  refusedNow(toast);
  await attempt(toast, async () => {
    view.el.querySelector('[data-menu="data"]').click();
    item('Outline').click(); await vi.advanceTimersByTimeAsync(1);
    item('Outline settings…').click();
  });
  expect(dialog()).toBeNull();
  refusedNow(toast);
});

it('keeps a protected sheet\'s settings when a dialog opened before the protection is confirmed', async () => {
  const { wb, id, toast } = await mount({ locked: false });
  await attempt(toast, () => view.run('outlineSettings'));
  expect(dialog()?.getAttribute('aria-label')).toBe('Outline Settings');
  wb.setSheetProtected(id, true);
  const before = JSON.stringify(wb.sheet(id).outlineSettings ?? null);
  dialog().querySelector('input[type="checkbox"]').click(); // summary rows above their detail
  dialog().querySelector('form').requestSubmit();
  await vi.advanceTimersByTimeAsync(1);
  expect(JSON.stringify(wb.sheet(id).outlineSettings ?? null)).toBe(before);
  refusedNow(toast);
});

it('keeps the settings of a sheet open to changes', async () => {
  const { wb, id } = await mount({ locked: false });
  await view.run('outlineSettings', { settings: SETTINGS });
  expect(wb.sheet(id).outlineSettings).toMatchObject(SETTINGS);
});
