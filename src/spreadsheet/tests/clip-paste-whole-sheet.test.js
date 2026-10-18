// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: t => ({ width: t.length * 7 }), font: '' });
  document.body.replaceChildren();
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// One copied cell pasted over the whole sheet (Ctrl+A) was tiled over every cell of the grid, 1,048,576 rows by
// 16,384 columns, which ran the tab out of memory; a cell carrying a conditional format, or Skip blanks, the
// same. Whole columns, rows and the whole sheet now take the block as far as the sheet reaches.
it('pastes one cell over a selected sheet or column as far as the sheet reaches', async () => {
  const doc = new Doc({ name: 'Whole' }), wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '5');
  wb.addRule(id, { type: 'formula', value: '=$A1>1', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, style: { bg: '#ff0000' } });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  view.goTo('A1'); viewport.focus();
  const copied = {};
  const copy = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(copy, 'clipboardData', { value: { setData: (type, value) => { copied[type] = value; } } });
  document.dispatchEvent(copy);
  const paste = () => {
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: type => copied[type] ?? '', files: [] } });
    viewport.dispatchEvent(e);
  };
  const sheet = wb.sheet(id);
  view.goTo('C:C'); viewport.focus(); paste();
  await vi.advanceTimersByTimeAsync(10);
  expect(wb.getValue(id, sheet.rows - 1, 2)).toBe(5);
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  paste();
  await vi.advanceTimersByTimeAsync(10);
  expect(wb.getValue(id, sheet.rows - 1, sheet.cols - 1)).toBe(5);
  expect(sheet.cells.size).toBe(sheet.rows * sheet.cols);
  expect(sheet.rules.length).toBeLessThan(10);
}, 20000);
