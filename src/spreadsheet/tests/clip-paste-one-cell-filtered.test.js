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

async function filteredList() {
  const doc = new Doc({ name: 'Filtered' }), wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Key'); wb.setInput(id, 0, 1, 'Val');
  for (let r = 1; r <= 8; r++) { wb.setInput(id, r, 0, r % 2 ? 'a' : 'b'); wb.setInput(id, r, 1, String(r)); }
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 8, c2: 1 });
  wb.setFilterCriteria(id, 0, { values: ['a'] });
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  return { wb, id, viewport: view.el.querySelector('.grid-viewport') };
}

const paste = (viewport, data) => {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { getData: type => data[type] ?? '', files: [] } });
  viewport.dispatchEvent(e);
};
const column = (wb, id) => [1, 2, 3, 4, 5, 6, 7, 8].map(r => wb.getValue(id, r, 1));

// One value pasted over a filtered list's selection was written into the rows the filter hid as well, overwriting
// data nobody could see; it now goes into the rows on show, as Fill Down and Excel do, in one undo step.
it('pastes one copied value into the shown rows of a filtered selection only', async () => {
  const { wb, id, viewport } = await filteredList();
  view.goTo('Sheet1!B2:B9'); viewport.focus();
  paste(viewport, { 'text/plain': 'X' });
  await vi.advanceTimersByTimeAsync(10);
  expect(column(wb, id)).toEqual(['X', 2, 'X', 4, 'X', 6, 'X', 8]);
  wb.undo();
  expect(column(wb, id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

it('does the same for a cell copied here, and still pastes a block of several rows as it is', async () => {
  const { wb, id, viewport } = await filteredList();
  view.goTo('Sheet1!A2'); viewport.focus();
  const copied = {};
  const e = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { setData: (type, value) => { copied[type] = value; } } });
  document.dispatchEvent(e);
  view.goTo('Sheet1!B2:B9'); viewport.focus();
  paste(viewport, copied);
  await vi.advanceTimersByTimeAsync(10);
  expect(column(wb, id)).toEqual(['a', 2, 'a', 4, 'a', 6, 'a', 8]);
  wb.undo();
  view.goTo('Sheet1!B2'); viewport.focus();
  paste(viewport, { 'text/plain': 'P\nQ\nR' });
  await vi.advanceTimersByTimeAsync(10);
  expect(column(wb, id)).toEqual(['P', 'Q', 'R', 4, 5, 6, 7, 8]);
});
