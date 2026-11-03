// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import * as notifications from '../src/ui/toast.js';

// On a protected sheet with A1:B4 selected, Insert Chart (and Recommended Charts, a family's More charts),
// Sparklines, Sparkline settings, Text Box, Picture from URL or from the device, and Change Picture opened their
// dialog or file picker; a chart, an address or a file was chosen, and only then did the sheet refuse it. They now
// say the sheet is protected at once, as Shapes, Icons and WordArt already did; on a sheet open to changes they open
// as before.
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
  const doc = new Doc({ name: 'Data', path: 'Spreadsheets/Objects.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  [['Region', 'Sales'], ['East', 3], ['West', 1], ['East', 2]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  wb.createNativeSparklines(id, { source: 'B2:B4', location: 'D2' });
  wb.addChart(id, { type: 'image', src: PIXEL, anchor: { r: 6, c: 0 }, dx: 0, dy: 0, w: 20, h: 20 });
  if (locked) wb.setSheetProtected(id, true);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!A1:B4');
  await vi.advanceTimersByTimeAsync(1);
  const toast = vi.spyOn(notifications, 'toast');
  return { wb, id, toast };
}
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
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

const COMMANDS = [
  ['insertChart'], ['chart', { action: 'recommended' }], ['chart', { action: 'insertDialog', family: 'bar' }],
  ['insertSparklines'], ['editSparkline'], ['insertTextBox'], ['insertImageUrl'], ['insertImageUrl', 'cell'],
];

it('says the sheet is protected before a chart, sparkline, text box or picture is chosen', async () => {
  const { wb, id, toast } = await mount();
  const picker = vi.spyOn(HTMLInputElement.prototype, 'click');
  for (const [cmd, arg] of COMMANDS) {
    await attempt(toast, () => view.run(cmd, arg));
    expect(dialog(), `${cmd} ${JSON.stringify(arg)}`).toBeNull();
    refusedNow(toast);
  }
  for (const [cmd, arg] of [['insertImage'], ['insertImage', 'cell'], ['replaceImage', wb.sheet(id).charts[0].id]]) {
    await attempt(toast, () => view.run(cmd, arg));
    refusedNow(toast);
  }
  expect(picker).not.toHaveBeenCalled();
  // The Insert menu goes the same way.
  await attempt(toast, async () => { view.el.querySelector('[data-menu="insert"]').click(); item('Chart…').click(); });
  expect(dialog()).toBeNull();
  refusedNow(toast);
});

it('opens them on a sheet open to changes', async () => {
  const { wb, id, toast } = await mount({ locked: false });
  for (const [cmd, arg] of COMMANDS) {
    await attempt(toast, () => { view.goTo(cmd === 'editSparkline' ? 'Sheet1!D2' : cmd === 'insertSparklines' ? 'Sheet1!D3' : 'Sheet1!A1:B4'); return view.run(cmd, arg); });
    expect(dialog(), `${cmd} ${JSON.stringify(arg)}`).not.toBeNull();
  }
  closeAllModals();
  const picker = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
  for (const [cmd, arg] of [['insertImage'], ['insertImage', 'cell'], ['replaceImage', wb.sheet(id).charts[0].id]]) await view.run(cmd, arg);
  expect(picker).toHaveBeenCalledTimes(3);
});
