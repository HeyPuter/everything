// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';

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
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = async () => { for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1); };
const key = (node, k, extra = {}) => node.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

// A chart whose title is linked to a cell (as charts from Excel files often are), the cell changed since.
async function mount() {
  const doc = new Doc({ name: 'Linked' }), wb = doc.wb, id = wb.activeSheetId;
  [['Q3 sales', ''], ['Jan', '12'], ['Feb', '15']].forEach((row, r) => row.forEach((v, c) => v && wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, { ...newExcelChart(wb, id, { r1: 1, c1: 0, r2: 2, c2: 1 }, 'columnClustered'), title: 'Q3 sales', titleRef: 'A1' });
  wb.setInput(id, 0, 0, 'Q4 sales');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  const node = view.el.querySelector('.chart-box .chart-body svg [data-el="title"]');
  node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  await flush();
  return { wb, chart: () => wb.chartById(id, chartId), viewport: view.el.querySelector('.grid-viewport') };
}

it('F2 on a linked chart title edits the text the chart shows, and leaving it unchanged keeps the link', async () => {
  const { chart, viewport } = await mount();
  expect(view.el.querySelector('.chart-box svg [data-el="title"]').textContent).toBe('Q4 sales');
  key(viewport, 'F2'); await flush();
  const input = view.el.querySelector('.chart-title-editor');
  expect(input.value).toBe('Q4 sales');
  key(input, 'Enter'); await flush();
  expect(chart().titleRef).toBe('A1');
  expect(view.el.querySelector('.chart-box svg [data-el="title"]').textContent).toBe('Q4 sales');
});

it('a title typed over a linked one replaces it', async () => {
  const { chart, viewport } = await mount();
  key(viewport, 'F2'); await flush();
  const input = view.el.querySelector('.chart-title-editor');
  input.value = 'Totals'; key(input, 'Enter'); await flush();
  expect(chart()).toMatchObject({ title: 'Totals' });
  expect(chart().titleRef).toBeUndefined();
});

it('the Format pane shows a linked title as the chart does', async () => {
  await mount();
  view.run('chart', { action: 'formatPane', element: 'title' }); await flush();
  expect(view.el.querySelector('.chart-format-pane input[aria-label="Text"]').value).toBe('Q4 sales');
});
