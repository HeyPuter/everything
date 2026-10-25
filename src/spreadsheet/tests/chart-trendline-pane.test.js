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
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = async () => { for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1); };
const key = (node, k) => node.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

async function mount(rows = [['Month', 'Sales'], ['Jan', '1'], ['Feb', '4'], ['Mar', '9'], ['Apr', '16']], patch = {}) {
  const doc = new Doc({ name: 'Trend' }), wb = doc.wb, id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, { ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: rows.length - 1, c2: 1 }, 'lineMarkers'), ...patch });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  await press(view.el.querySelector('.chart-box'));
  return { wb, chart: () => wb.chartById(id, chartId) };
}
async function press(node) {
  node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  await flush();
}
const svgNode = sel => view.el.querySelector(`.chart-box .chart-body svg ${sel}`);
const pane = () => view.el.querySelector('.chart-format-pane');
const control = label => pane().querySelector(`[aria-label="${label}"]`);
const tick = label => [...pane().querySelectorAll('label.check')].find(n => n.textContent === label).querySelector('input');
const set = async (input, value) => { input.value = value; input.dispatchEvent(new Event('change')); await flush(); };

it('adds a trendline from Format Trendline, then its order and its equation on the chart', async () => {
  const { chart } = await mount();
  view.run('chart', { action: 'formatPane', element: 'trendline:0' }); await flush();
  expect(pane().querySelector('.chart-pane-title').textContent).toBe('Format Trendline');
  expect(control('Trendline type').value).toBe('none');
  await set(control('Trendline type'), 'poly');
  expect(chart().trendlines[0]).toMatchObject({ type: 'poly', order: 2 });
  await set(control('Order'), '3');
  expect(chart().trendlines[0].order).toBe(3);
  expect(control('Trendline Name').placeholder).toBe('Poly. (Sales)');
  tick('Display Equation on chart').click(); await flush();
  tick('Display R-squared value on chart').click(); await flush();
  expect(chart().trendlines[0]).toMatchObject({ dispEq: true, dispRSqr: true });
  expect(svgNode('.chart-trendline-label').textContent).toContain('R² = 1');
  await set(control('Forward (periods)'), '2');
  expect(chart().trendlines[0].forward).toBe(2);
  await set(control('Dash type'), 'solid');
  expect(svgNode('.chart-trendline').hasAttribute('stroke-dasharray')).toBe(false);
});

it('says why an exponential trendline draws nothing over a value below zero', async () => {
  await mount([['Month', 'Sales'], ['Jan', '-1'], ['Feb', '4'], ['Mar', '9']], { trendline: true, trendlines: [{ type: 'exp' }] });
  view.run('chart', { action: 'formatPane', element: 'trendline:0' }); await flush();
  expect(pane().querySelector('.chart-pane-note').textContent).toBe('An exponential trendline needs every value above zero.');
  expect(svgNode('.chart-trendline')).toBeNull();
  // Set Intercept offers an exponential curve only a crossing above zero.
  await set(control('Set Intercept'), '-2');
  expect(control('Set Intercept').value).toBe('');
});

it('selects a trendline or its label with a click, and Delete takes away just what is selected', async () => {
  const { wb, chart } = await mount(undefined, { trendline: true, trendlines: [{ type: 'linear', dispEq: true }] });
  const elements = () => view.el.querySelector('select[aria-label="Chart Elements"]');
  await press(svgNode('[data-el="trendlineLabel"] text'));
  expect(elements().value).toBe('trendlineLabel:0');
  key(view.el.querySelector('.grid-viewport'), 'Delete'); await flush();
  expect(chart().trendlines[0]).toMatchObject({ type: 'linear', dispEq: false });
  expect(svgNode('.chart-trendline-label')).toBeNull();
  await press(svgNode('.chart-trendline-hit'));
  expect(elements().value).toBe('trendline:0');
  key(view.el.querySelector('.grid-viewport'), 'Delete'); await flush();
  expect(chart().trendline).toBe(false);
  expect(wb.sheet(wb.activeSheetId).charts).toHaveLength(1);
  wb.undo(); await flush();
  expect(chart().trendline).toBe(true);
});
