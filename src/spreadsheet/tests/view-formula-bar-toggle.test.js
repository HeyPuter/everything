// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as modal from '../src/ui/modal.js';
import { appOption } from '../src/lib/app-options.js';

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
  try { localStorage.removeItem('spreadsheet:view'); } catch { /* no storage */ }
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const mount = () => {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
};
const viewTab = () => [...document.querySelectorAll('.ribbon-tab')].find((t) => t.textContent === 'View');
const button = (label) => [...view.el.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent.trim() === label);

it('hides and shows the formula bar from View ▸ Show, remembers it, and Go To still asks for an address', async () => {
  mount();
  viewTab()?.click();
  await vi.advanceTimersByTimeAsync(10);
  const toggle = button('Formula Bar');
  expect(toggle).toBeTruthy();
  expect(toggle.disabled).toBe(false);
  toggle.click();
  await vi.advanceTimersByTimeAsync(10);
  expect(view.el.classList.contains('no-formula-bar')).toBe(true);
  // Kept with the person's options (File ▸ Options ▸ View), which follow the account.
  expect(appOption('showFormulaBar')).toBe(false);
  const prompt = vi.spyOn(modal, 'promptDialog').mockResolvedValue('C5');
  view.el.querySelector('.grid-viewport').dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(10);
  expect(prompt).toHaveBeenCalled();
  button('Formula Bar').click();
  await vi.advanceTimersByTimeAsync(10);
  expect(view.el.classList.contains('no-formula-bar')).toBe(false);
});

it('splits the window from View ▸ Window ▸ Split and removes the split again', async () => {
  mount();
  viewTab()?.click();
  await vi.advanceTimersByTimeAsync(10);
  const split = button('Split');
  expect(split).toBeTruthy();
  expect(split.disabled).toBe(false);
  split.click();
  await vi.advanceTimersByTimeAsync(10);
  const wb = view.doc.wb;
  expect(wb.sheets[0].split).toBeTruthy();
  expect(view.el.querySelector('.grid').classList.contains('split-panes')).toBe(true);
  button('Split').click();
  await vi.advanceTimersByTimeAsync(10);
  expect(wb.sheets[0].split).toBeUndefined();
});
