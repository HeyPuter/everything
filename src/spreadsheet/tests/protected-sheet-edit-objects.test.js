// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import * as notifications from '../src/ui/toast.js';

// Enter on a chart, a text box, an equation, a slicer, a timeline or a scroll bar of a protected sheet (and its
// double-click, the object menu's Edit…, the palette and the toolbar) opened its settings dialog, though the chart
// ribbon greys its editing out there; the settings were changed and only OK said the sheet is protected. The sheet
// is said to be protected at once now; on a sheet open to changes the dialogs open as before.
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
  const doc = new Doc({ name: 'Data', path: 'Spreadsheets/Edit.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  [['Region', 'Sales'], ['East', 3], ['West', 1], ['East', 2]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  for (const object of OBJECTS) wb.addChart(id, { anchor: { r: 6, c: 0 }, dx: 0, dy: 0, w: 200, h: 120, ...object });
  if (locked) wb.setSheetProtected(id, true);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!A1:B4');
  await vi.advanceTimersByTimeAsync(1);
  const toast = vi.spyOn(notifications, 'toast');
  return { wb, id, toast };
}
const OBJECTS = [
  { type: 'column', range: { r1: 0, c1: 0, r2: 3, c2: 1 }, title: 'Sales' },
  { type: 'text', text: 'Note' },
  { type: 'text', equation: 'x^2', text: 'x²' },
  { type: 'scroll', min: 0, max: 10, step: 1, value: 0 },
];
const dialog = () => document.querySelector('.modal-root:not(.closing) .modal-panel');
const item = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);
const refusedNow = (toast) => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Sheet1 is protected/), expect.objectContaining({ icon: 'lock' }));

/** Each attempt gets its own notice: the protected notice is shown at most once every few seconds. */
async function attempt(toast, run) {
  closeMenu(); closeAllModals();
  await vi.advanceTimersByTimeAsync(3000);
  toast.mockClear();
  run(); // a prompt's promise settles only when it closes
  await vi.advanceTimersByTimeAsync(1);
}

it('says the sheet is protected before a chart, text box, equation or scroll bar is edited', async () => {
  const { wb, id, toast } = await mount();
  const charts = wb.sheet(id).charts;
  expect(charts).toHaveLength(OBJECTS.length);
  for (const chart of charts) {
    await attempt(toast, () => view.run('editChart', chart.id));
    expect(dialog(), chart.type).toBeNull();
    refusedNow(toast);
  }
});

it('opens their dialogs on a sheet open to changes', async () => {
  const { wb, id, toast } = await mount({ locked: false });
  for (const chart of wb.sheet(id).charts) {
    await attempt(toast, () => view.run('editChart', chart.id));
    expect(dialog(), chart.type).not.toBeNull();
  }
});
