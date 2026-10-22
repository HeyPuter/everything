// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { isMenuOpen, closeMenu } from '../src/ui/menu.js';

// Title and Heading enlarge the text, but applying them left the rows at their height, so the title was cut
// off at the top of its row; the font size commands grow the rows the text no longer fits, and so do cell
// styles now, in the same undo step.
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
afterEach(() => { closeMenu(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('grows the rows a larger cell style no longer fits, as one step with the style', async () => {
  const doc = new Doc({ name: 'Styles', path: 'Spreadsheets/Styles.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Report');
  wb.setInput(id, 1, 0, 'Detail');
  wb.clearHistory();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const before = wb.rowHeight(id, 0);
  view.goTo('Sheet1!A1');
  view.run('cellStyle', 'title');
  await vi.advanceTimersByTimeAsync(1);
  const size = wb.styleAt(id, 0, 0).size;
  expect(size).toBeGreaterThan(13);
  expect(wb.rowHeight(id, 0)).toBeGreaterThanOrEqual(Math.ceil(size * 1.35) + 8);
  expect(wb.rowHeight(id, 1)).toBe(before);
  expect(wb.undoLabels()).toHaveLength(1);
  wb.undo();
  expect(wb.rowHeight(id, 0)).toBe(before);
  // A style over whole columns grows only the rows that hold something.
  view.goTo('Sheet1!A:A');
  view.run('cellStyle', 'heading');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.rowHeight(id, 1)).toBeGreaterThan(before);
  expect(wb.rowHeight(id, 5)).toBe(before);
});
