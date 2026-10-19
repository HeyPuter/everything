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
async function mount() {
  const doc = new Doc({ name: 'Functions' }); const wb = doc.wb; const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '2'); wb.setInput(id, 1, 0, '3');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}
const editor = () => view.el.querySelector('.grid-editor');
const press = (target, key, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));

it('starts a formula when a function is inserted into an entry with nothing typed yet', async () => {
  const { wb, id } = await mount();
  view.goTo('A3'); await flush();
  press(view.el.querySelector('.grid-viewport'), 'F2'); await flush();
  view.run('insertFunction', 'SUM'); await flush();
  expect(editor().value).toBe('=SUM(');
  editor().value = '=SUM(A1:A2)'; editor().dispatchEvent(new Event('input', { bubbles: true }));
  press(editor(), 'Enter'); await flush();
  expect(wb.getCell(id, 2, 0).f).toBe('SUM(A1:A2)');
  expect(wb.getValue(id, 2, 0)).toBe(5);
});

it('starts a formula with Alt+= on a cell opened for editing, and inserts at the caret of a formula', async () => {
  await mount();
  view.goTo('B3'); await flush();
  press(view.el.querySelector('.grid-viewport'), 'F2'); await flush();
  press(editor(), '=', { altKey: true, code: 'Equal' }); await flush();
  expect(editor().value).toBe('=SUM(');
  editor().value = '=1+'; editor().dispatchEvent(new Event('input', { bubbles: true }));
  editor().setSelectionRange(3, 3);
  view.run('insertFunction', 'MAX'); await flush();
  expect(editor().value).toBe('=1+MAX(');
});
