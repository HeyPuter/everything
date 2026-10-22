// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

// Alt (or F10) brings the key tips up from anywhere, the find box or a sheet tab among them. Dismissed with Escape,
// a second Alt, F10 or Tab, they sent the keyboard to the sheet: the find box lost the search being typed in it,
// and its next Escape no longer closed it. They now give the focus back to where it was.
let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}]);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const flush = () => vi.advanceTimersByTimeAsync(1);
const press = (k, extra = {}) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
const altTap = () => {
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true, cancelable: true }));
  document.activeElement.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true, cancelable: true }));
};
const tips = () => document.querySelectorAll('.keytip').length;
async function mount() {
  const doc = new Doc({ name: 'Tips' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
}
async function inFindBox() {
  view.run('find'); await flush();
  const input = view.el.querySelector('.find-input');
  expect(document.activeElement).toBe(input);
  input.value = 'tot';
  return input;
}

it.each([
  ['Escape', () => press('Escape')],
  ['a second Alt', () => altTap()],
  ['F10', () => press('F10')],
])('gives the find box its focus back when the tips are dismissed with %s', async (_, dismiss) => {
  await mount();
  const input = await inFindBox();
  altTap(); await flush();
  expect(tips()).toBeGreaterThan(0);
  dismiss(); await flush();
  expect(tips()).toBe(0);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('tot');
  // The find box's own Escape closes it again.
  press('Escape'); await flush();
  expect(view.el.querySelector('.find-panel').hidden).toBe(true);
});

it('steps back from a tab\'s commands to the tabs, then to the find box', async () => {
  await mount();
  const input = await inFindBox();
  altTap(); await flush();
  press('h'); await flush(); await flush();
  press('Escape'); await flush();
  expect(tips()).toBeGreaterThan(0);
  press('Escape'); await flush();
  expect(tips()).toBe(0);
  expect(document.activeElement).toBe(input);
});

it('still hands the keyboard to the sheet when the tips came up from it', async () => {
  await mount();
  const grid = view.el.querySelector('.grid-viewport');
  grid.focus();
  altTap(); await flush();
  press('Escape'); await flush();
  expect(document.activeElement).toBe(grid);
});
