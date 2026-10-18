// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { isImage } from '../src/core/charts.js';

// A shape from Insert ▸ Shapes kept its proportions when its handle was dragged, so a rectangle could
// not be drawn out into a wide bar, nor a line made longer without growing thicker, unless Shift was
// held. Shapes now resize freely, as Excel's do (Lock aspect ratio off); icons and pictures keep theirs.
let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('inserts shapes free to change proportions, and icons locked to theirs', async () => {
  const doc = new Doc({ name: 'Shapes', path: 'Spreadsheets/Shapes.xlsx' });
  const { wb } = doc; const id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(5);
  view.run('insertShape', 'rect'); await vi.advanceTimersByTimeAsync(5);
  view.run('insertShape', 'line'); await vi.advanceTimersByTimeAsync(5);
  view.run('insertIcons', 'bold'); await vi.advanceTimersByTimeAsync(5);
  const [rect, line, ...icons] = wb.sheet(id).charts;
  expect(isImage(rect) && isImage(line)).toBe(true);
  expect(rect.lockAspect).toBe(false);
  expect(line.lockAspect).toBe(false);
  expect(icons).toHaveLength(1);
  expect(icons[0].lockAspect).not.toBe(false);
});
