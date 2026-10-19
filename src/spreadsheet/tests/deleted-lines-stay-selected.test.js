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
  const doc = new Doc({ name: 'Delete' }); const wb = doc.wb; const id = wb.activeSheetId;
  ['r1', 'r2', 'r3', 'r4', 'r5'].forEach((v, r) => wb.setInput(id, r, 0, v));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}
const grid = () => view.el.querySelector('.grid-viewport');
const press = (key, extra = {}) => grid().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey: true, metaKey: true, ...extra }));
const column = (wb, id) => [0, 1, 2, 3, 4].map((r) => wb.getValue(id, r, 0));
const nameBox = () => view.el.querySelector('.name-box').value;

it('keeps whole rows selected after deleting them, so Ctrl+- again takes the next ones', async () => {
  const { wb, id } = await mount();
  view.goTo('2:3'); await flush(); grid().focus();
  press('-'); await flush();
  expect(column(wb, id)).toEqual(['r1', 'r4', 'r5', null, null]);
  expect(nameBox()).toBe('A2:XFD3');
  press('-'); await flush();
  expect(document.querySelector('.insert-delete-cells')).toBeNull();
  expect(column(wb, id)).toEqual(['r1', null, null, null, null]);
});

it('keeps a whole column selected after deleting it, and leaves the active cell after deleting rows from cells', async () => {
  const { wb, id } = await mount();
  view.goTo('A:A'); await flush(); grid().focus();
  view.run('deleteCols'); await flush();
  expect(nameBox()).toBe('A1:A1048576');
  for (let r = 0; r < 5; r++) wb.setInput(id, r, 0, `r${r + 1}`);
  view.goTo('A2:B3'); await flush();
  view.run('deleteRows'); await flush();
  expect(column(wb, id)).toEqual(['r1', 'r4', 'r5', null, null]);
  expect(nameBox()).toBe('A2');
});
