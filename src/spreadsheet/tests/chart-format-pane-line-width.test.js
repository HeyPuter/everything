// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';

// The Format pane's Width (pt) box was always empty, whatever width the gridlines, axis, border or series line
// was drawn at, and it stayed empty after a width was typed into it; on a title or legend it took a width and
// did nothing with it, as their borders keep none. The box now shows the width drawn, in points, and is left
// out where it has nothing to set.
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

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(1); };
const widthBox = () => document.querySelector('.chart-format-pane:not([hidden]) input[aria-label="Width (pt)"]');

it('shows the width a chart line is drawn at, and takes a new one', async () => {
  const doc = new Doc({ name: 'Charts' }); const wb = doc.wb; const id = wb.activeSheetId;
  [['Month', 'North'], ['Jan', '12'], ['Feb', '15']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  view.goTo('Sheet1!A1:B3'); await flush();
  await view.run('chart', { action: 'insert', subtype: 'lineMarkers' }); await flush();
  const chart = () => wb.sheet(id).charts[0];
  await view.run('chart', { action: 'formatPane', element: 'gridlines-y' }); await flush();
  expect(widthBox().value).toBe('0.75');
  widthBox().value = '2';
  widthBox().dispatchEvent(new Event('change'));
  await flush();
  expect(chart().appearance.gridlineStyles.y.width).toBeCloseTo(2.67, 2);
  expect(widthBox().value).toBe('2');
  await view.run('chart', { action: 'formatPane', element: 'series:0' }); await flush();
  expect(widthBox().value).toBe('2.25');
  await view.run('chart', { action: 'formatPane', element: 'title' }); await flush();
  expect(document.querySelector('.chart-format-pane:not([hidden]) .chart-pane-title').textContent).toBe('Format Chart Title');
  expect(widthBox()).toBeNull();
});
