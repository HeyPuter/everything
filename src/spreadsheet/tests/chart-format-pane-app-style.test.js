// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

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

// Charts the assistant, scripts and templates make keep the app's own style (no `appearance`).
async function mount(type) {
  const doc = new Doc({ name: 'Charts' }), wb = doc.wb, id = wb.activeSheetId;
  [['x', 'y'], ['1', '5'], ['2', '7'], ['3', '4']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, { type, range: { r1: 0, c1: 0, r2: 3, c2: 1 }, title: 'Mine', anchor: { r: 0, c: 3 }, dx: 4, dy: 4, w: 400, h: 260 });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  const box = view.el.querySelector(`.chart-box[data-chart="${chartId}"]`);
  box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  await flush();
  const pane = view.el.querySelector('.chart-format-pane');
  const open = async element => { view.run('chart', { action: 'selectElement', element }); view.run('chart', { action: 'formatPane' }); await flush(); };
  return { wb, chart: () => wb.chartById(id, chartId), pane, open };
}

it('offers no x bounds on a scatter chart in the app\'s style, which would restyle the whole chart', async () => {
  const { chart, pane, open } = await mount('scatter');
  await open('xAxis');
  expect(pane.hidden).toBe(false);
  expect(pane.querySelector('input[aria-label="Minimum"]')).toBeNull();
  expect(pane.textContent).toContain('Change Chart Type gives it the full formatting options');
  expect(chart().appearance).toBeUndefined();
  // The value axis keeps its bounds, which this style draws.
  await open('yAxis');
  const min = pane.querySelector('input[aria-label="Minimum"]');
  min.value = '2'; min.dispatchEvent(new Event('change')); await flush();
  expect(chart()).toMatchObject({ yMin: 2 });
  expect(chart().appearance).toBeUndefined();
});

it('shows only the controls that change a chart in the app\'s style', async () => {
  const { chart, pane, open } = await mount('column');
  await open('chartArea');
  expect(pane.querySelector('select[aria-label="Border"], select[aria-label="Fill"]')).toBeNull();
  await open('series:0');
  expect(pane.querySelector('select[aria-label="Border"]')).toBeNull();
  const fill = pane.querySelector('select[aria-label="Fill"]');
  fill.value = 'solid'; fill.dispatchEvent(new Event('change')); await flush();
  expect(chart().colors[0]).toBe('#4472c4');
  expect(chart().appearance).toBeUndefined();
});
