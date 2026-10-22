// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { isMenuOpen, closeMenu } from '../src/ui/menu.js';

// The toolbar's Cell styles menu stayed open after a style was picked, unlike every other menu.
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

it('closes the Cell styles menu once a style is picked, with the style applied and focus back on the grid', async () => {
  const doc = new Doc({ name: 'Styles', path: 'Spreadsheets/Styles.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Report');
  wb.clearHistory();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.el.querySelector('.tb-btn[aria-label="Cell styles"]').click();
  expect(isMenuOpen()).toBe(true);
  const title = [...document.querySelectorAll('.menu .cell-style-item')].find((b) => b.textContent === 'Title');
  title.click();
  expect(isMenuOpen()).toBe(false);
  expect(wb.getCell(id, 0, 0)?.s).toMatchObject({ bold: true, size: 24 });
  expect(wb.undoLabels()).toHaveLength(1);
  expect(document.activeElement).toBe(view.el.querySelector('.grid-viewport'));
});
