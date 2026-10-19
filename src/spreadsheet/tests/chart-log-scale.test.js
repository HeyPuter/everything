// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

const GROWTH = [['Year', 'Users'], ['Y1', '3'], ['Y2', '40'], ['Y3', '700'], ['Y4', '9000'], ['Y5', '120000']];
function setup(subtype = 'lineMarkers', rows = GROWTH, appearance = { yLogBase: 10 }) {
  const wb = new Workbook(), id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const made = newExcelChart(wb, id, { r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 }, subtype);
  const chartId = wb.addChart(id, { ...made, appearance: { ...made.appearance, ...appearance } });
  const chart = () => wb.chartById(id, chartId);
  return { wb, id, chart, svg: () => renderChartSvg(chartData(wb, id, chart()), chart(), 480, 288) };
}
const labels = (svg, el = 'yAxis') => [...svg.matchAll(new RegExp(`data-el="${el}"[^>]*>([^<]*)<`, 'g'))].map(m => m[1]);
const markers = svg => [...svg.matchAll(/<circle [^>]*cx="([\d.]+)" cy="([\d.]+)"/g)].map(m => [+m[1], +m[2]]);

describe('a logarithmic value axis', () => {
  it('runs in powers of ten around the data and spaces values by their ratios', () => {
    const { svg } = setup();
    const out = svg();
    expect(labels(out)).toEqual(['1', '10', '100', '1,000', '10K', '100K', '1M']);
    // Each value about a power of ten above the last sits about one decade higher.
    const ys = markers(out).map(p => p[1]);
    const decade = (ys[0] - ys[4]) / Math.log10(120000 / 3);
    expect(Math.abs((ys[1] - ys[2]) / decade - Math.log10(700 / 40))).toBeLessThan(.02);
    expect(out).not.toMatch(/NaN|Infinity/);
  });

  it('labels ticks below one with their own decimals and hangs columns below one down from it', () => {
    const { svg } = setup('columnClustered', [['k', 'v'], ['a', '0.02'], ['b', '0.5'], ['c', '3'], ['d', '40']]);
    const out = svg();
    expect(labels(out)).toEqual(['0.01', '0.1', '1', '10', '100']);
    const bars = [...out.matchAll(/class="chart-series chart-column" x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)].map(m => [+m[1], +m[2]]);
    expect(bars).toHaveLength(4);
    // a and b reach down from the 1 line; c and d up to it.
    expect(Math.abs(bars[0][0] - bars[1][0])).toBeLessThan(.5);
    expect(Math.abs(bars[2][0] + bars[2][1] - (bars[3][0] + bars[3][1]))).toBeLessThan(.5);
    expect(Math.abs(bars[0][0] - (bars[2][0] + bars[2][1]))).toBeLessThan(.5);
  });

  it('leaves out values at or below zero', () => {
    const { svg } = setup('lineMarkers', [['k', 'v'], ['a', '0'], ['b', '-5'], ['c', '30'], ['d', '400']]);
    const out = svg();
    expect(markers(out)).toHaveLength(2);
    expect(labels(out)).toEqual(['10', '100', '1,000']);
  });

  it('puts a scatter chart on logarithmic axes both ways', () => {
    const rows = [['x', 'y'], ...[1, 10, 100, 1000].map(x => [String(x), String(x * x)])];
    const { svg } = setup('scatter', rows, { yLogBase: 10, xLogBase: 10 });
    const out = svg();
    expect(labels(out, 'xAxis').filter(Boolean)).toEqual(['1', '10', '100', '1,000']);
    const pts = markers(out);
    // y = x² on log–log axes is a straight line.
    const slope = (p, q) => (q[1] - p[1]) / (q[0] - p[0]);
    expect(Math.abs(slope(pts[0], pts[1]) - slope(pts[2], pts[3]))).toBeLessThan(.01);
  });

  it('is saved to and read from a workbook file', async () => {
    const { wb } = setup('scatter', [['x', 'y'], ['1', '1'], ['10', '100']], { yLogBase: 10, xLogBase: 2 });
    vi.stubGlobal('Blob', NodeBlob);
    const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
    const chartXml = new TextDecoder().decode(zip.FileIndex[zip.FullPaths.findIndex(p => /\/charts\/[^/]+\.xml$/.test(p))].content);
    expect(chartXml).toContain('<c:logBase val="10"/>');
    expect(chartXml).toContain('<c:logBase val="2"/>');
    // Read back as another program's file: the app's own copy of its model left out.
    const part = X.CFB.find(zip, '/xl/workbook.xml');
    X.CFB.utils.cfb_add(zip, '/xl/workbook.xml', new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')));
    const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
    expect(back.sheets[0].charts[0].appearance).toMatchObject({ yLogBase: 10, xLogBase: 2 });
  });
});

describe('Format Axis', () => {
  let view;
  afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
  it('turns a logarithmic scale on and off and sets its base', async () => {
    vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
    const flush = async () => { for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1); };
    const doc = new Doc({ name: 'Log' }), wb = doc.wb, id = wb.activeSheetId;
    GROWTH.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
    const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 5, c2: 1 }, 'lineMarkers'));
    view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
    document.body.append(view.el); await flush();
    view.el.querySelector('.chart-box').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
    view.el.querySelector('.chart-box').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
    await flush();
    view.run('chart', { action: 'formatPane', element: 'yAxis' }); await flush();
    const pane = view.el.querySelector('.chart-format-pane');
    const box = () => [...pane.querySelectorAll('label.check')].find(l => l.textContent === 'Logarithmic scale').querySelector('input');
    box().checked = true; box().dispatchEvent(new Event('change')); await flush();
    expect(wb.chartById(id, chartId).appearance.yLogBase).toBe(10);
    const base = pane.querySelector('input[aria-label="Base"]');
    base.value = '2'; base.dispatchEvent(new Event('change')); await flush();
    expect(wb.chartById(id, chartId).appearance.yLogBase).toBe(2);
    box().checked = false; box().dispatchEvent(new Event('change')); await flush();
    expect(wb.chartById(id, chartId).appearance.yLogBase).toBeUndefined();
  });
});
