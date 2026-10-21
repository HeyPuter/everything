// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// A selected cell's note sat to its right, and a link's address (with its Edit and Remove buttons) under it from its
// left edge, so beside a cell near the right of the window they ran out of sight; on a phone, where the window is
// about five columns wide, the link's buttons could not be reached past the first column. Both now keep inside the
// window, as the input message does: the link's slides left, and the note goes to the cell's left, or under it
// where there is no room on either side.
const widths = { 'note-pop': 260, 'link-pop': 340 };
let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return widths[this.className.split(' ')[0]] || 0; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.className.startsWith('link-pop') ? 36 : 0; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { widths['note-pop'] = 260; view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  const doc = new Doc({ name: 'Popovers' }); const wb = doc.wb; const id = wb.activeSheetId;
  for (const c of [1, 5]) {
    wb.setNote(id, 2, c, 'What this figure means and where it came from.');
    wb.setInput(id, 4, c, 'Site'); wb.setLink(id, 4, c, 'https://example.com/a/long/path/to/a/page');
  }
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  return { pop: (name) => view.el.querySelector(`.${name}`) };
}
const at = (pop) => /translate\(([-\d.]+)px, ([-\d.]+)px/.exec(pop.style.transform).slice(1).map(Number);
const cellBox = () => { const n = view.el.querySelector('.grid-canvas > .sel-active'); const [left, top] = at(n); return { left, top, width: parseFloat(n.style.width), height: parseFloat(n.style.height) }; };

it('keeps a link\'s address and its buttons inside the window', async () => {
  const { pop } = await mount();
  view.goTo('B5'); await vi.advanceTimersByTimeAsync(50);
  const [b] = at(pop('link-pop'));
  view.goTo('F5'); await vi.advanceTimersByTimeAsync(50);
  expect(pop('link-pop').hidden).toBe(false);
  expect(at(pop('link-pop'))[0]).toBeGreaterThan(b);
  expect(at(pop('link-pop'))[0] + 340).toBeLessThanOrEqual(800);
});

it('puts a note beside the cell where it fits, and at its left near the right edge', async () => {
  const { pop } = await mount();
  view.goTo('B3'); await vi.advanceTimersByTimeAsync(50);
  let cell = cellBox();
  expect(at(pop('note-pop'))).toEqual([cell.left + cell.width + 6, cell.top]);
  view.goTo('F3'); await vi.advanceTimersByTimeAsync(50);
  cell = cellBox();
  const [x, y] = at(pop('note-pop'));
  expect(x + 260).toBeLessThanOrEqual(cell.left);
  expect(y).toBe(cell.top);
});

it('puts a note under the cell where it fits on neither side, below the link shown there', async () => {
  widths['note-pop'] = 700;
  const { pop } = await mount();
  view.goTo('F3'); await vi.advanceTimersByTimeAsync(50);
  let cell = cellBox();
  let [x, y] = at(pop('note-pop'));
  expect(x + 700).toBeLessThanOrEqual(800);
  expect(y).toBe(cell.top + cell.height + 4);
  view.doc.wb.setNote(view.doc.wb.activeSheetId, 4, 5, 'And one on the link.');
  view.goTo('F5'); await vi.advanceTimersByTimeAsync(50);
  cell = cellBox();
  [x, y] = at(pop('note-pop'));
  expect(y).toBe(cell.top + cell.height + 4 + 36 + 4);
});
