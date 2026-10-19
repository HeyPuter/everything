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
  const doc = new Doc({ name: 'Redo' }); const wb = doc.wb; const id = wb.activeSheetId;
  ['r1', 'r2', 'r3', 'r4', 'r5'].forEach((v, r) => wb.setInput(id, r, 0, v));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}
const grid = () => view.el.querySelector('.grid-viewport');
const press = (key, extra = {}) => grid().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey: true, metaKey: true, ...extra }));
const column = (wb, id) => [0, 1, 2, 3, 4].map((r) => wb.getValue(id, r, 0));

it('redoes with Ctrl+Shift+Z and does nothing more once every step is redone', async () => {
  const { wb, id } = await mount();
  view.goTo('3:3'); await flush(); grid().focus();
  view.run('deleteRows'); await flush();
  expect(column(wb, id)).toEqual(['r1', 'r2', 'r4', 'r5', null]);
  press('z'); await flush();
  expect(column(wb, id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
  press('z', { shiftKey: true, key: 'Z' }); await flush();
  expect(column(wb, id)).toEqual(['r1', 'r2', 'r4', 'r5', null]);
  // One press too many: there is nothing left to redo, and another row must not go.
  press('z', { shiftKey: true, key: 'Z' }); await flush();
  expect(column(wb, id)).toEqual(['r1', 'r2', 'r4', 'r5', null]);
});

it('still repeats the last action with Ctrl+Y when there is nothing to redo', async () => {
  const { wb, id } = await mount();
  view.goTo('3:3'); await flush(); grid().focus();
  view.run('deleteRows'); await flush();
  press('y'); await flush();
  expect(column(wb, id)).toEqual(['r1', 'r2', 'r5', null, null]);
});
