// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// With whole columns selected the name box read C1:C1048576, which is wider than the box, so it showed a cut-off
// C1:C104…; whole rows read A3:XFD5. They now read C:C and 3:5, as Excel writes them; the whole sheet is unchanged.
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
const flush = () => vi.advanceTimersByTimeAsync(1);
async function mount() {
  const doc = new Doc({ name: 'Lines' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
}
const grid = () => view.el.querySelector('.grid-viewport');
const nameBox = () => view.el.querySelector('.name-box').value;

it.each([['C:C', 'C:C'], ['B:D', 'B:D'], ['3:5', '3:5'], ['7:7', '7:7'], ['B2:C9', 'B2:C9'], ['A1:XFD1048576', 'A1:XFD1048576']])('reads %s as %s', async (text, shown) => {
  await mount();
  view.goTo(text); await flush();
  expect(nameBox()).toBe(shown);
});

it('reads a column picked from the keyboard as C:C, and the rows as 4:4', async () => {
  await mount();
  view.goTo('C4'); await flush(); grid().focus();
  grid().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true, cancelable: true })); await flush();
  expect(nameBox()).toBe('C:C');
  view.goTo('C4'); await flush(); grid().focus();
  grid().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', shiftKey: true, bubbles: true, cancelable: true })); await flush();
  expect(nameBox()).toBe('4:4');
});
