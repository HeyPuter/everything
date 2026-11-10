// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import * as notifications from '../src/ui/toast.js';

// On a protected sheet with A1:B4 selected, Fill series…, Goal seek… and What-If ▸ Data table… opened, were filled
// in, and refused only at OK: the sheet refuses each of them anywhere on it, unlocked cells included. They now say
// the sheet is protected at once; on a sheet open to changes they open as before.
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
  const doc = new Doc({ name: 'Data', path: 'Spreadsheets/WhatIf.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  [['Region', 'Sales'], ['East', 3], ['West', 1], ['East', 2]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  wb.setInput(id, 4, 1, '=SUM(B2:B4)');
  if (unlocked) wb.applyStyle(id, { r1: 0, c1: 0, r2: 4, c2: 1 }, { locked: false });
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

const COMMANDS = [['fillSeries', 'Fill series'], ['goalSeek', 'Goal seek'], ['dataTable', 'Data Table']];

it('says the sheet is protected before Fill series, Goal seek or Data table is filled in', async () => {
  const { toast } = await mount();
  for (const [cmd] of COMMANDS) {
    await attempt(toast, () => view.run(cmd));
    expect(dialog(), cmd).toBeNull();
    refusedNow(toast);
  }
  // The Data menu goes the same way.
  await attempt(toast, async () => { view.el.querySelector('[data-menu="data"]').click(); item('Goal seek…').click(); });
  expect(dialog()).toBeNull();
  refusedNow(toast);
});

it('says so over unlocked cells too, which these refuse as well', async () => {
  const { wb, id, toast } = await mount({ unlocked: true });
  for (const [cmd] of COMMANDS) {
    await attempt(toast, () => view.run(cmd));
    expect(dialog(), cmd).toBeNull();
    refusedNow(toast);
  }
  // As the dialogs themselves would have: Goal Seek refuses the protected sheet whatever cell it would change.
  expect(wb.goalSeek(id, { r: 4, c: 1 }, 10, { r: 1, c: 1 })).toMatchObject({ ok: false, reason: 'The sheet is protected' });
});

it('opens them on a sheet open to changes', async () => {
  const { toast } = await mount({ locked: false });
  for (const [cmd, label] of COMMANDS) {
    await attempt(toast, () => { view.goTo(cmd === 'goalSeek' ? 'Sheet1!B5' : 'Sheet1!A1:B4'); return view.run(cmd); });
    expect(dialog()?.getAttribute('aria-label'), cmd).toBe(label);
  }
});
