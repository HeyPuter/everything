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
  const doc = new Doc({ name: 'Spill' }); const wb = doc.wb; const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '=SEQUENCE(4,2)');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}
const bar = () => view.el.querySelector('.formula-input');

it('shows the formula a spilled cell takes its value from, greyed, as Excel does', async () => {
  const { wb, id } = await mount();
  view.goTo('B3'); await flush();
  expect(wb.getValue(id, 2, 1)).toBe(6);
  expect(bar().value).toBe('=SEQUENCE(4,2)');
  expect(bar().classList.contains('spilled')).toBe(true);
  // The array's own first cell shows it as its own; an empty cell beyond the spill shows nothing.
  view.goTo('A1'); await flush();
  expect(bar().value).toBe('=SEQUENCE(4,2)');
  expect(bar().classList.contains('spilled')).toBe(false);
  view.goTo('A6'); await flush();
  expect(bar().value).toBe('');
});

it('begins an entry in a spilled cell empty, so what is typed is the cell’s own', async () => {
  const { wb, id } = await mount();
  view.goTo('B3'); await flush();
  bar().focus(); await flush();
  expect(bar().value).toBe('');
  expect(bar().classList.contains('spilled')).toBe(false);
  bar().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flush();
  expect(bar().value).toBe('=SEQUENCE(4,2)');
  expect(wb.getCell(id, 2, 1)).toBeUndefined();
});
