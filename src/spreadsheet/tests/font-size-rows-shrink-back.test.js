// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { heightForLines } from '../src/core/textfit.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

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

// A larger font grows the rows it no longer fits, but marked them as sized by hand, so setting the font to 28 point
// and back to 11 left the rows 59 pixels tall for good. A row nobody sized now stays automatic, as Excel's does, and
// fits its text again; a row someone sized keeps its height as theirs.
it('lets an automatic row fit its text again when the font is made smaller', async () => {
  const doc = new Doc({ name: 'Sizes', path: 'Spreadsheets/Sizes.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Automatic');
  wb.setInput(id, 1, 0, 'Sized by hand');
  wb.setRowHeight(id, 1, 30);
  wb.clearHistory();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!A1:A2');
  view.run('fontSize', 28 * 4 / 3);
  await vi.advanceTimersByTimeAsync(1);
  const big = wb.rowHeight(id, 0);
  expect(big).toBeGreaterThan(50);
  expect(wb.sheet(id).rowHeightModes.get(0)).toBe('auto');
  expect(wb.rowHeight(id, 1)).toBeGreaterThanOrEqual(heightForLines(1, 28 * 4 / 3));
  view.run('fontSize', 11 * 4 / 3);
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.rowHeight(id, 0)).toBeLessThan(35);
  // The row sized by hand keeps the height it was grown to, as Excel keeps a custom height.
  expect(wb.rowHeight(id, 1)).toBeGreaterThanOrEqual(heightForLines(1, 28 * 4 / 3));
  expect(wb.sheet(id).rowHeightModes.get(1)).toBe('fixed');
});
