// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// The toolbar's Percent and Currency buttons press on and off, and F4 repeated the press: on a cell already in that
// format it took the format off. Excel's repeat does what the press did, so F4 now applies the format the press
// applied (or takes it off, after a press that took it off).
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
  const doc = new Doc({ name: 'Repeat' }); const wb = doc.wb; const id = wb.activeSheetId;
  for (let r = 0; r < 4; r++) wb.setInput(id, r, 0, '0.5');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}
const fmt = (wb, id, r) => wb.styleAt(id, r, 0)?.fmt || 'general';

it.each(['percent', 'currency'])('repeats %s onto a cell already in it, and onto one in none', async (format) => {
  const { wb, id } = await mount();
  view.goTo('A2'); await flush(); view.run('fmt', { fmt: format }); await flush();
  view.goTo('A1'); await flush(); view.run('fmt', { fmt: format, toggle: true }); await flush();
  expect(fmt(wb, id, 0)).toBe(format);
  view.goTo('A2'); await flush(); view.run('repeat'); await flush();
  expect(fmt(wb, id, 1)).toBe(format);
  view.goTo('A3'); await flush(); view.run('repeat'); await flush();
  expect(fmt(wb, id, 2)).toBe(format);
});

it('repeats a press that took the format off as taking it off', async () => {
  const { wb, id } = await mount();
  view.goTo('A1:A3'); await flush(); view.run('fmt', { fmt: 'percent' }); await flush();
  view.goTo('A1'); await flush(); view.run('fmt', { fmt: 'percent', toggle: true }); await flush();
  expect(fmt(wb, id, 0)).toBe('general');
  view.goTo('A2'); await flush(); view.run('repeat'); await flush();
  expect(fmt(wb, id, 1)).toBe('general');
  view.goTo('A4'); await flush(); view.run('repeat'); await flush();
  expect(fmt(wb, id, 3)).toBe('general');
});
