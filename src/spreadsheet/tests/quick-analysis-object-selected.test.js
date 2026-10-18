// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// After Insert ▸ Chart the data stays selected under the new chart, beside it, and the Quick Analysis
// button sat at the data's corner over the chart's axis. With a chart, picture or shape selected the
// keys act on the object, so the button is hidden until cells are selected again.
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

it('hides the Quick Analysis button while a chart is selected', async () => {
  const doc = new Doc({ name: 'QA', path: 'Spreadsheets/QA.xlsx' });
  const { wb } = doc; const id = wb.activeSheetId;
  [['Item', 'Q1', 'Q2'], ['Pens', '3', '5'], ['Ink', '4', '6']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(5);
  const button = view.el.querySelector('.quick-analysis-btn');
  view.goTo('A1:C3'); await vi.advanceTimersByTimeAsync(20);
  expect(button.hidden).toBe(false);
  view.run('chart', { action: 'insert', subtype: 'columnClustered' }); await vi.advanceTimersByTimeAsync(20);
  expect(wb.sheet(id).charts).toHaveLength(1);
  expect(button.hidden).toBe(true);
  view.goTo('A1:C3'); await vi.advanceTimersByTimeAsync(20);
  expect(button.hidden).toBe(false);
});
