// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import * as P from '../src/lib/puter.js';

// File > Share… on a new spreadsheet nobody had typed in said "Save the spreadsheet first": the flush it
// ran has nothing to write for a book that never changed, so the file the dialog shares was never made.
vi.mock('../src/lib/session.js', () => ({ session: { settings: {}, username: 'me', signedOut: false, addEventListener() {}, removeEventListener() {} } }));
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('puter', { fs: { share() {}, getShares: async () => [] } });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  vi.spyOn(P, 'shareAccess').mockResolvedValue([]);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

/** File ▸ Share ▸ Share with people…. */
function openShareFromFileMenu() {
  const item = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);
  item('Share').click();
  item('Share with people…').click();
}

it('saves a blank, never-changed spreadsheet and opens the share dialog for it', async () => {
  const doc = Doc.blank();
  const save = vi.spyOn(doc, 'save').mockImplementation(async () => { doc.path = 'Spreadsheets/Untitled spreadsheet.xlsx'; doc.uid = 'u-1'; return true; });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(5);
  view.el.querySelector('[data-menu="file"]').click();
  openShareFromFileMenu();
  await vi.advanceTimersByTimeAsync(5);
  expect(save).toHaveBeenCalled();
  expect(document.querySelector('.modal-title')?.textContent).toBe(`Share "${doc.name}"`);
});

it('shares a .csv as the .xlsx its edits are saved to, not as the .csv', async () => {
  const doc = new Doc({ name: 'data', path: 'Desktop/data.csv', uid: 'c-1' });
  const save = vi.spyOn(doc, 'save').mockImplementation(async () => { doc.path = 'Spreadsheets/data.xlsx'; doc.uid = 'x-1'; return true; });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(5);
  view.el.querySelector('[data-menu="file"]').click();
  openShareFromFileMenu();
  await vi.advanceTimersByTimeAsync(5);
  expect(save).toHaveBeenCalled();
  expect(P.shareAccess).toHaveBeenCalledWith('Spreadsheets/data.xlsx');
});
