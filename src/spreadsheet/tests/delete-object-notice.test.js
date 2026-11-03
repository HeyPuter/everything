// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { toast } from '../src/ui/toast.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

let view;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  vi.stubGlobal('matchMedia', (q) => ({ matches: !/max-width/.test(q), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  if (!globalThis.CSS?.escape) vi.stubGlobal('CSS', { escape: (s) => String(s).replace(/["\\]/g, '\\$&') });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (t) => ({ width: t.length * 7 }) });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  view?.destroy(); view = null;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// Deleting a single object told the user (and a screen reader) what went: an equation was a "Text box deleted", and
// a scroll bar or anything else not named in a short list a "Chart deleted". The notice now names the object as the
// undo step does, and WordArt as WordArt rather than a "Text box".
it('names the object it deleted', async () => {
  const doc = new Doc({ name: 'Objects', path: 'Spreadsheets/Objects.xlsx' }), wb = doc.wb, id = wb.activeSheetId;
  const equation = wb.addChart(id, { type: 'text', text: 'x²', equation: 'x^2', anchor: { r: 1, c: 1 }, w: 80, h: 40 });
  const box = wb.addChart(id, { type: 'text', text: 'Note', anchor: { r: 4, c: 1 }, w: 80, h: 40 });
  const scroll = wb.addChart(id, { type: 'scroll', anchor: { r: 8, c: 1 }, w: 120, h: 20, link: 'A1', min: 0, max: 10 });
  // WordArt (Insert ▸ Text ▸ WordArt) is a text box with text effects, named WordArt as the Selection Pane names it.
  const wordArt = wb.addChart(id, { type: 'text', text: 'Title', anchor: { r: 12, c: 1 }, w: 160, h: 60, style: { size: 40, effects: { glow: '#ffcc00' } } });
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const said = () => toast.mock.calls.at(-1)?.[0];
  for (const [object, words] of [[equation, 'Equation deleted'], [box, 'Text box deleted'], [scroll, 'Scroll bar deleted'], [wordArt, 'WordArt deleted']]) {
    expect(wb.chartById(id, object)).toBeTruthy();
    await view.run('deleteChart', { id: object, only: true });
    expect(wb.chartById(id, object)).toBeFalsy();
    expect(said()).toBe(words);
  }
  // Its undo step names it the same way.
  expect(wb.undoLabel()).toBe('Delete WordArt');
});
