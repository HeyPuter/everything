// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';

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
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = () => vi.advanceTimersByTimeAsync(1);
const grid = () => view.el.querySelector('.grid-viewport');
const press = (key, extra = {}) => grid().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
const go = async ref => { view.goTo(ref); await flush(); grid().focus(); };

async function mount() {
  const doc = new Doc({ name: 'Dates' }); const wb = doc.wb; const id = wb.activeSheetId;
  wb.setDefaultLineSize(id, 'col', 64); // Excel's default width, which the ISO date (70px here) does not fit
  wb.setColWidth(id, 2, 50);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}

// A date typed into a column at its default width widens the column to show it, as in Excel, but today's date put
// in with Ctrl+; went in without it and showed ### (the ISO date is 70px of text in a 64px column).
it('widens a column at its default width for the date Ctrl+; puts in, undone with the entry', async () => {
  const { wb, id } = await mount();
  await go('B2');
  const before = wb.colWidth(id, 1);
  press(';', { ctrlKey: true, metaKey: true }); await flush();
  expect(typeof wb.getCell(id, 1, 1)?.v).toBe('number');
  expect(wb.colWidth(id, 1)).toBeGreaterThan(before);
  wb.undo();
  expect(wb.getCell(id, 1, 1)?.v ?? null).toBe(null);
  expect(wb.colWidth(id, 1)).toBe(before);
});

it('leaves a column sized by hand as it is', async () => {
  const { wb, id } = await mount();
  await go('C2');
  press(';', { ctrlKey: true, metaKey: true }); await flush();
  expect(typeof wb.getCell(id, 1, 2)?.v).toBe('number');
  expect(wb.colWidth(id, 2)).toBe(50);
});
