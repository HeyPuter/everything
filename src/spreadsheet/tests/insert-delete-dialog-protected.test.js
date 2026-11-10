// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';

const toastRoot = document.querySelector('.toast-root');

// Ctrl+Shift+= and Ctrl+- over part of a protected sheet opened the Insert (Delete) dialog, whose every choice the
// sheet then refused once one was picked and OK pressed. The sheet's protection is said at once, as Delete rows
// says it, and no dialog asks for a choice that cannot be made.
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

async function mount(locked) {
  const doc = new Doc({ name: 'Cells', path: 'Spreadsheets/Cells.xlsx' });
  const wb = doc.wb;
  if (locked) wb.setSheetProtected(wb.activeSheetId, true);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!B2:C3');
  await vi.advanceTimersByTimeAsync(1);
  return wb;
}
const dialog = () => document.querySelector('.modal-root:not(.closing) .modal-panel');
const toasts = () => [...toastRoot.querySelectorAll('.toast')].map((t) => t.textContent).join(' ');

it('says the sheet is protected instead of opening Insert or Delete cells', async () => {
  await mount(true);
  for (const cmd of ['insertDialog', 'deleteDialog']) {
    await view.run(cmd);
    await vi.advanceTimersByTimeAsync(1);
    expect(dialog()).toBeNull();
  }
  expect(toasts()).toMatch(/Sheet1 is protected/);
});

it('opens them on a sheet open to changes', async () => {
  await mount(false);
  await view.run('insertDialog');
  await vi.advanceTimersByTimeAsync(1);
  expect(dialog()?.getAttribute('aria-label')).toBe('Insert');
});
