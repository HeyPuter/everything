// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// The toolbar's formats were cut short at the last row holding data (with a "Formatting applied through row 1000"
// notice) whenever the sheet already reached further down, so a column chosen by its header kept General below its
// data and the next entry there showed none of it, while Format Cells formatted the same column all the way down.
it('formats a whole column chosen by its header all the way down from the toolbar', async () => {
  const doc = new Doc({ name: 'Columns' }); const wb = doc.wb; const id = wb.activeSheetId;
  for (let r = 0; r < 1000; r++) wb.setInput(id, r, 0, String(r + 0.5));
  wb.sheet(id).rows = 3000; // the sheet already reaches further down, as it does once scrolled there
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  view.goTo('A:A'); await vi.advanceTimersByTimeAsync(1);
  view.run('fmt', 'currency');
  view.run('bold');
  await vi.advanceTimersByTimeAsync(1);
  wb.setInput(id, 2500, 0, '2.5');
  expect(wb.getDisplay(id, 2500, 0)).toBe('$2.50');
  expect(wb.styleAt(id, 2500, 0)?.bold).toBe(true);
  expect(wb.getDisplay(id, 999, 0)).toBe('$999.50');
  expect(document.body.textContent).not.toContain('Formatting applied through');
  wb.undo(); wb.undo(); wb.undo();
  expect(wb.getDisplay(id, 999, 0)).toBe('999.5');
});

it('formats every row of a selected sheet from the toolbar, not only the first 20,000 cells', async () => {
  const doc = new Doc({ name: 'All' }); const wb = doc.wb; const id = wb.activeSheetId;
  const entries = [];
  for (let r = 0; r < 2000; r++) for (let c = 0; c < 20; c++) entries.push({ r, c, cell: { v: r + c, f: null } });
  wb.setCells(id, entries);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  view.goTo('A1'); await vi.advanceTimersByTimeAsync(1);
  const grid = view.el.querySelector('.grid-viewport'); grid.focus();
  grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  view.run('fmt', 'percent');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getDisplay(id, 1999, 19)).toBe('201,800%');
  expect(wb.getDisplay(id, 0, 1)).toBe('100%');
});
