// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { selectionName } from '../src/core/refs.js';

// The Name Box reads whole columns as C:C and whole rows as 3:5, but the status bar and the "Link to … copied" toast
// still spelled them out as C1:C1048576 and A3:XFD5, as did the print area, copy and conditional format messages.
// They now read them the same way.
const toastRoot = document.querySelector('.toast-root');
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
  const doc = new Doc({ name: 'Lines', path: 'Spreadsheets/Lines.xlsx' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
}
const address = () => view.el.querySelector('.status-address')?.textContent;

it('names whole lines as Excel writes them, and every other range by its cells', () => {
  expect(selectionName({ r1: 0, c1: 2, r2: 1048575, c2: 2 })).toBe('C:C');
  expect(selectionName({ r1: 2, c1: 0, r2: 4, c2: 16383 })).toBe('3:5');
  expect(selectionName({ r1: 1, c1: 1, r2: 8, c2: 2 })).toBe('B2:C9');
  expect(selectionName({ r1: 4, c1: 3, r2: 4, c2: 3 })).toBe('D5');
  expect(selectionName({ r1: 0, c1: 0, r2: 1048575, c2: 16383 })).toBe('A1:XFD1048576');
});

it.each([['C:C', 'C:C'], ['B:D', 'B:D'], ['3:5', '3:5'], ['B2:C9', 'B2:C9']])('the status bar reads %s as %s', async (text, shown) => {
  await mount();
  view.goTo(text); await flush();
  await vi.advanceTimersByTimeAsync(300);
  expect(address()).toBe(shown);
});

it('the copied link names a whole column as C:C', async () => {
  await mount();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  view.goTo('C:C'); await flush();
  await view.run('copyLink');
  await flush();
  expect(writeText).toHaveBeenCalled();
  expect(toastRoot.textContent).toContain('Link to C:C copied');
});

it('setting a whole column as the print area names it C:C', async () => {
  await mount();
  view.goTo('C:C'); await flush();
  await view.run('printArea', 'set');
  await flush();
  expect(toastRoot.textContent).toContain('Print area set to C:C');
});
