// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import * as notifications from '../src/ui/toast.js';

// On a protected sheet with A1:B4 selected, Format Cells…, Data validation…, Dropdown… and Conditional formatting…
// opened, were filled in, and refused only at OK (a protected sheet keeps every cell's formatting and rules, the
// unlocked cells' too). They now say the sheet is protected at once, from every entry point; on a sheet open to
// changes they open as before.
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

async function mount({ locked = true, unlocked = false } = {}) {
  const doc = new Doc({ name: 'Data', path: 'Spreadsheets/Format.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  [['Region', 'Sales'], ['East', 3], ['West', 1], ['East', 2]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  if (unlocked) wb.applyStyle(id, { r1: 0, c1: 0, r2: 3, c2: 1 }, { locked: false });
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

const ctrl1 = () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
const COMMANDS = [['formatCells', 'Format Cells'], ['validation', 'Data validation'], ['insertDropdown', 'Data validation'], ['condFormat', 'Conditional formatting']];

it('says the sheet is protected before Format Cells, validation or conditional formatting is filled in', async () => {
  const { wb, id, toast } = await mount();
  for (const [cmd] of COMMANDS) {
    await attempt(toast, () => view.run(cmd));
    expect(dialog(), cmd).toBeNull();
    refusedNow(toast);
  }
  // Ctrl+1 and the Format menu go the same way.
  await attempt(toast, ctrl1);
  expect(dialog()).toBeNull();
  refusedNow(toast);
  await attempt(toast, async () => { view.el.querySelector('[data-menu="format"]').click(); item('Format Cells…').click(); });
  expect(dialog()).toBeNull();
  refusedNow(toast);
  expect(wb.sheet(id).validations).toHaveLength(0);
});

it('says so over unlocked cells too, whose formatting the sheet keeps', async () => {
  const { toast } = await mount({ unlocked: true });
  for (const [cmd] of COMMANDS) {
    await attempt(toast, () => view.run(cmd));
    expect(dialog(), cmd).toBeNull();
    refusedNow(toast);
  }
});

it('opens them on a sheet open to changes', async () => {
  const { toast } = await mount({ locked: false });
  for (const [cmd, label] of COMMANDS) {
    await attempt(toast, () => view.run(cmd));
    expect(dialog()?.getAttribute('aria-label'), cmd).toBe(label);
  }
  await attempt(toast, () => { view.goTo('Sheet1!A1:B4'); ctrl1(); });
  expect(dialog()?.getAttribute('aria-label')).toBe('Format Cells');
});
