// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch, chartElementState, quickLayoutPatch } from '../src/core/chart-design.js';

function setup(subtype) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Month', 'North'], ['Jan', 1200], ['Feb', 1500], ['Mar', 900]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, subtype));
  const chart = () => wb.chartById(id, chartId);
  const apply = patch => { expect(patch).toBeTruthy(); wb.updateChart(id, chartId, patch); };
  const svg = () => renderChartSvg(chartData(wb, id, chart()), chart(), chart().w, chart().h);
  return { chart, apply, svg };
}

it.each([['barClustered', '>Jan<', '>1,000<'], ['columnClustered', '>1,000<', '>Jan<']])(
  'Add Chart Element ▸ Axes on a %s chart hides the axis drawn the way it names', (subtype, vertical, horizontal) => {
    const { chart, apply, svg } = setup(subtype);
    expect(svg()).toContain(vertical);
    expect(svg()).toContain(horizontal);
    apply(chartElementPatch(chart(), 'axes', { axis: 'horizontal', on: false }));
    expect(chartElementState(chart()).axes).toEqual({ horizontal: false, vertical: true });
    expect(svg()).not.toContain(horizontal);
    expect(svg()).toContain(vertical);
    apply(chartElementPatch(chart(), 'axes', { axis: 'horizontal', on: true }));
    apply(chartElementPatch(chart(), 'axes', { axis: 'vertical', on: false }));
    expect(chartElementState(chart()).axes).toEqual({ horizontal: true, vertical: false });
    expect(svg()).not.toContain(vertical);
    expect(svg()).toContain(horizontal);
  });

let view;
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('Delete on a bar chart\'s selected axis removes that axis', async () => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  const flush = async () => { for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1); };
  const doc = new Doc({ name: 'Bars' }), wb = doc.wb, id = wb.activeSheetId;
  [['Month', 'North'], ['Jan', '1200'], ['Feb', '1500'], ['Mar', '900']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'barClustered'));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  const viewport = view.el.querySelector('.grid-viewport');
  const press = async (sel) => {
    const node = view.el.querySelector(`.chart-box .chart-body svg ${sel}`);
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
    node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
    await flush();
  };
  await press('[data-el="xAxis"]');
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })); await flush();
  expect(wb.chartById(id, chartId).appearance).toMatchObject({ hideXAxis: true });
  expect(wb.chartById(id, chartId).appearance.hideYAxis).toBeFalsy();
  await press('[data-el="yAxis"]');
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })); await flush();
  expect(wb.chartById(id, chartId).appearance).toMatchObject({ hideXAxis: true, hideYAxis: true });
});

it('Quick Layout 2 on a bar chart hides its value axis and keeps the categories', () => {
  const { chart, apply, svg } = setup('barClustered');
  apply(quickLayoutPatch(chart(), 2, { seriesCount: 1 }));
  expect(svg()).toContain('>Jan<');
  expect(svg()).not.toContain('>1,000<');
});
