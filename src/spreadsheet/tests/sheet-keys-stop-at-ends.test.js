// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Ctrl+PgDn on the last sheet went round to the first, and Ctrl+PgUp on the first to the last, so holding the keys
// to reach the end of a long row of tabs went round and round. As in Excel, they stop at the last and first sheet
// on show, also while a formula has another sheet showing to pick references on.
let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  const doc = new Doc({ name: 'Tabs' });
  const wb = doc.wb;
  const ids = [wb.activeSheetId, wb.addSheet('Two').id, wb.addSheet('Hidden').id, wb.addSheet('Three').id];
  wb.setSheetHidden(ids[2], true);
  wb.setActiveSheet(ids[0]);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  return { wb, ids };
}
const press = async (target, key) => { target.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })); await vi.advanceTimersByTimeAsync(1); };

it('stops at the last and the first sheet on show', async () => {
  const { wb, ids } = await mount();
  const grid = view.el.querySelector('.grid-viewport');
  grid.focus();
  await press(grid, 'PageUp');
  expect(wb.activeSheetId).toBe(ids[0]);
  await press(grid, 'PageDown'); await press(grid, 'PageDown');
  expect(wb.activeSheetId).toBe(ids[3]);
  await press(grid, 'PageDown');
  expect(wb.activeSheetId).toBe(ids[3]);
});

it('stops at the last sheet while a formula picks references', async () => {
  const { wb, ids } = await mount();
  const grid = view.el.querySelector('.grid-viewport');
  grid.focus();
  grid.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = '=1+'; editor.setSelectionRange(3, 3);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await press(editor, 'PageDown'); await press(editor, 'PageDown'); await press(editor, 'PageDown');
  expect(wb.activeSheetId).toBe(ids[3]);
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(true);
});
