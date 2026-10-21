// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Text typed into the name box and left there without Enter (a click on the sheet, the ribbon or anywhere else)
// stayed in the box, so it showed a name or address that was not the selection's. As in Excel, the box names the
// selection again once it is left.
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
  const doc = new Doc({ name: 'Box' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  view.goTo('B2'); await vi.advanceTimersByTimeAsync(1);
  return view.el.querySelector('.name-box');
}

it('names the selection again when left for the sheet', async () => {
  const box = await mount();
  box.focus(); box.value = 'Hello';
  view.el.querySelector('.grid-viewport').focus(); await vi.advanceTimersByTimeAsync(1);
  expect(box.value).toBe('B2');
});

it('names the selection again when left for anything else', async () => {
  const box = await mount();
  box.focus(); box.value = 'C9';
  box.blur(); await vi.advanceTimersByTimeAsync(1);
  expect(box.value).toBe('B2');
});
