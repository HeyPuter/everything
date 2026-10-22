// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// A paste onto whole columns is cut to the part of the sheet laid out so far (100 rows on a new sheet), and the
// copied block then tiled over that part whenever it divided it: column A's 50 rows copied onto column C went in
// twice, C51:C100 repeating C1:C50. The block now tiles only as it would over the whole columns (Excel's rule).
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Tiles' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  for (let r = 0; r < 50; r++) wb.setInput(id, r, 0, r + 1);
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  const board = {};
  const event = (type) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: (t) => board[t] ?? '', setData: (t, v) => { board[t] = v; }, files: [] } });
    return e;
  };
  const copy = (where) => { view.goTo(`Sheet1!${where}`); viewport.dispatchEvent(event('copy')); };
  const paste = (where, data = null) => { if (data) { for (const k of Object.keys(board)) delete board[k]; Object.assign(board, data); } view.goTo(`Sheet1!${where}`); viewport.dispatchEvent(event('paste')); };
  expect(wb.sheet(id).rows).toBe(100);
  return { wb, id, view, copy, paste };
}

it('pastes a copied column onto a whole column once', async () => {
  const { wb, id, view, copy, paste } = await mount();
  copy('A:A');
  paste('C:C');
  expect(wb.getValue(id, 49, 2)).toBe(50);
  expect(wb.getValue(id, 50, 2)).toBe(null);
  expect(wb.getValue(id, 99, 2)).toBe(null);
  view.destroy();
});

it('pastes another app\'s rows onto whole columns once, unless they divide the whole columns', async () => {
  const { wb, id, view, paste } = await mount();
  const fifty = Array.from({ length: 50 }, (_, i) => `x${i}`).join('\n');
  paste('E:E', { 'text/plain': fifty });
  expect(wb.getValue(id, 49, 4)).toBe('x49');
  expect(wb.getValue(id, 50, 4)).toBe(null);
  // One cell, or two rows (1,048,576 is a multiple of 2), still repeat down the sheet's rows.
  paste('F:F', { 'text/plain': 'one' });
  expect(wb.getValue(id, 99, 5)).toBe('one');
  paste('G:G', { 'text/plain': 'a\nb' });
  expect(wb.getValue(id, 98, 6)).toBe('a');
  expect(wb.getValue(id, 99, 6)).toBe('b');
  view.destroy();
});
