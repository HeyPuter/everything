// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// Paste Name (F3) and Formulas ▸ Use in Formula offer the workbook's names and those of the entry's sheet. With a
// formula showing another sheet to pick a reference on, they offered that sheet's own names instead: one of them
// put into the formula read #NAME? on the sheet the formula is on, and that sheet's own names were missing.
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
afterEach(() => { closeMenu(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('offers the names of the sheet the formula is on while another sheet is shown', async () => {
  const doc = new Doc({ name: 'Names', path: 'Spreadsheets/Names.xlsx' });
  const wb = doc.wb;
  const home = wb.activeSheetId;
  const other = wb.addSheet('Sheet2').id;
  wb.setActiveSheet(home);
  wb.setInput(home, 0, 1, '5');
  wb.defineName('HomeRate', 'Sheet1!$B$1', 'Sheet1');
  wb.defineName('AwayRate', 'Sheet2!$B$1', 'Sheet2');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = '=2*';
  editor.setSelectionRange(3, 3);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', ctrlKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.activeSheetId).toBe(other);
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  const labels = [...document.querySelectorAll('.menu-item .menu-label')].map((n) => n.textContent);
  expect(labels).toContain('HomeRate');
  expect(labels).not.toContain('AwayRate');
  closeMenu();
  // Formulas ▸ Use in Formula, on the ribbon, offers the same.
  [...view.el.querySelectorAll('.ribbon [role="tab"]')].find((n) => n.textContent === 'Formulas').click();
  await vi.advanceTimersByTimeAsync(1);
  [...view.el.querySelectorAll('button[aria-label="Use in Formula"]')].find((b) => !b.closest('[hidden]')).click();
  await vi.advanceTimersByTimeAsync(1);
  const offered = [...document.querySelectorAll('.menu-item .menu-label')].map((n) => n.textContent);
  expect(offered).toContain('HomeRate');
  expect(offered).not.toContain('AwayRate');
});
