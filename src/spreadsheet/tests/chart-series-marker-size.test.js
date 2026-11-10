// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData, chartSeriesLine, chartSeriesLinePatch, normalizeChart } from '../src/core/charts.js';
import { runTool } from '../src/core/aitools.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { openChartDialog } from '../src/ui/chartdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

// A scatter chart's dots could be resized only from Format Data Series on a chart in Excel's style: not from Edit
// chart, not on a chart in the app's own style, and not by the AI assistant.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['x', 'Low', 'High'], [1, 2, 5], [2, 4, 6], [4, 3, 9]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  return { wb, id, range: { r1: 0, c1: 0, r2: 3, c2: 2 } };
}
const radii = svg => [...svg.matchAll(/<circle [^>]*r="([\d.]+)"/g)].map(m => Number(m[1]));

describe('series lines on a chart in the app\'s own style', () => {
  it('are kept by normalizeChart, defaults dropped, and drawn at their size and shape', () => {
    const { wb, id, range } = book();
    const chart = normalizeChart({ type: 'scatter', range, anchor: { r: 0, c: 5 }, seriesLines: [{ markerSize: 12, markerSymbol: 'auto' }, { markerSymbol: 'square' }, null, {}] });
    expect(chart.seriesLines).toEqual([{ markerSize: 12 }, { markerSymbol: 'square' }]);
    const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 300);
    expect(radii(svg)).toEqual([8, 8, 8]);
    expect((svg.match(/<rect class="chart-marker"/g) || []).length).toBe(3);
    expect(normalizeChart({ ...chart, seriesLines: [{ markerSize: 500 }] }).seriesLines).toEqual([{ markerSize: 72 }]);
  });

  it('set a line chart\'s point size, markers and line width', () => {
    const { wb, id, range } = book();
    const base = normalizeChart({ type: 'line', range, anchor: { r: 0, c: 5 } });
    const chart = normalizeChart({ ...base, ...chartSeriesLinePatch(base, [0], { markerSize: 9, width: 4 }), ...chartSeriesLinePatch({ ...base, seriesLines: [{ markerSize: 9, width: 4 }] }, [1], { marker: false }) });
    // The uneven x column is a series of its own here: the first series is drawn larger, the second without markers.
    const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 300);
    expect(radii(svg)).toEqual([6, 6, 6, 3, 3, 3]);
    expect(svg).toContain('stroke-width="4"');
  });

  it('are read and patched in the appearance on an Excel-style chart', () => {
    const chart = normalizeChart({ type: 'scatter', range: { r1: 0, c1: 0, r2: 3, c2: 2 }, anchor: { r: 0, c: 5 }, appearance: { lineDefault: { width: 2, marker: true, markerSize: 5 } } });
    const patch = chartSeriesLinePatch(chart, [0, 1], { markerSize: 10 });
    expect(patch.seriesLines).toBeUndefined();
    const next = normalizeChart({ ...chart, ...patch });
    expect(chartSeriesLine(next, 1).markerSize).toBe(10);
    expect(chartSeriesLine(next, 2).markerSize).toBe(5);
  });
});

describe('the AI assistant', () => {
  it('styles series by name, number or all of them with series_styles', () => {
    const { wb, id } = book();
    const env = { sheetId: () => id };
    const made = JSON.parse(runTool(wb, 'create_chart', { data_range: 'A1:C4', type: 'scatter' }, env).content);
    const done = runTool(wb, 'update_chart', { chart: made.id, series_styles: [{ marker_size: 10 }, { series: 'High', marker: 'diamond', color: '#AA0000' }] }, env);
    expect(done.ok).toBe(true);
    const chart = wb.chartById(id, made.id);
    expect(chart.seriesLines).toEqual([{ markerSize: 10 }, { markerSize: 10, markerSymbol: 'diamond' }]);
    expect(chart.colors).toEqual([null, '#aa0000']);
    runTool(wb, 'update_chart', { chart: made.id, series_styles: [{ series: 1, line_width: 3 }] }, env);
    expect(wb.chartById(id, made.id).seriesLines[0].width).toBe(4);
  });

  it('says what is wrong with a series, a size or a type without markers', () => {
    const { wb, id } = book();
    const env = { sheetId: () => id };
    const made = JSON.parse(runTool(wb, 'create_chart', { data_range: 'A1:C4', type: 'scatter' }, env).content);
    expect(runTool(wb, 'update_chart', { chart: made.id, series_styles: [{ series: 'Mid', marker_size: 8 }] }, env).content).toMatch(/no series "Mid".*"Low", "High"/);
    expect(runTool(wb, 'update_chart', { chart: made.id, series_styles: [{ marker_size: 100 }] }, env).content).toMatch(/2 to 72/);
    const column = JSON.parse(runTool(wb, 'create_chart', { data_range: 'A1:C4', type: 'column' }, env).content);
    expect(runTool(wb, 'update_chart', { chart: column.id, series_styles: [{ marker_size: 8 }] }, env).content).toMatch(/column chart draws no markers/);
  });
});

describe('the chart dialog', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
  afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

  const open = (wb, id, chart) => openChartDialog({ wb, sheetId: () => id, range: () => chart.range, grid: { focus: vi.fn(), selectChart: vi.fn() } }, { chart });
  const sizeInput = () => document.querySelector('input[aria-label="Marker size (pt)"]');

  it('sets every series\' marker size of a scatter chart, previewed before it is saved', () => {
    const { wb, id, range } = book();
    const chartId = wb.addChart(id, { type: 'scatter', range, anchor: { r: 0, c: 5 } });
    open(wb, id, wb.chartById(id, chartId));
    expect(sizeInput().value).toBe('');
    expect(sizeInput().closest('.row').hidden).toBe(false);
    sizeInput().value = '15';
    sizeInput().dispatchEvent(new Event('input', { bubbles: true }));
    vi.runAllTimers();
    expect(radii(document.querySelector('.chart-preview').innerHTML)).toContain(10);
    document.querySelector('form.chart-form').requestSubmit();
    expect(wb.chartById(id, chartId).seriesLines).toEqual([{ markerSize: 15 }, { markerSize: 15 }]);
  });

  it('shows the size an Excel-style chart\'s series share and leaves them alone unless it changes', () => {
    const { wb, id, range } = book();
    const chartId = wb.addChart(id, { type: 'scatter', range, anchor: { r: 0, c: 5 }, appearance: { lines: [{ width: 2, marker: true, markerSize: 7 }, { width: 2, marker: false, markerSize: 7 }] } });
    open(wb, id, wb.chartById(id, chartId));
    expect(sizeInput().value).toBe('7');
    document.querySelector('form.chart-form').requestSubmit();
    expect(wb.chartById(id, chartId).appearance.lines[1].marker).toBe(false);
    open(wb, id, wb.chartById(id, chartId));
    sizeInput().value = '9';
    document.querySelector('form.chart-form').requestSubmit();
    expect(wb.chartById(id, chartId).appearance.lines.map(l => [l.markerSize, l.marker])).toEqual([[9, true], [9, true]]);
  });

  it('is hidden for charts without markers and refuses sizes out of range', () => {
    const { wb, id, range } = book();
    const chartId = wb.addChart(id, { type: 'line', range, anchor: { r: 0, c: 5 } });
    open(wb, id, wb.chartById(id, chartId));
    sizeInput().value = '100';
    document.querySelector('form.chart-form').requestSubmit();
    expect(document.querySelector('.field-error').textContent).toMatch(/2 to 72/);
    document.querySelector('.chart-type[data-type="column"]').click();
    expect(sizeInput().closest('.row').hidden).toBe(true);
  });
});

// A line chart in the app's own style leaves its points unmarked past 60 categories, and kept to that when a series
// was given a marker size or shape (Edit chart's Marker size, the assistant): the setting changed nothing.
it('marks a long line series that was given a marker size or shape, a very long one too', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Day'); wb.setInput(id, 0, 1, 'Load'); wb.setInput(id, 0, 2, 'Base');
  for (let r = 1; r <= 100; r++) { wb.setInput(id, r, 0, `D${r}`); wb.setInput(id, r, 1, String(r % 7)); wb.setInput(id, r, 2, '3'); }
  const chart = normalizeChart({ type: 'line', range: { r1: 0, c1: 0, r2: 100, c2: 2 }, anchor: { r: 0, c: 5 }, seriesLines: [{ markerSize: 9 }] });
  const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 300);
  // The first series' 100 points at 9pt; the second, with no marker of its own, stays a bare line.
  expect(radii(svg)).toEqual(Array(100).fill(6));
  for (let r = 101; r <= 3000; r++) { wb.setInput(id, r, 0, `D${r}`); wb.setInput(id, r, 1, '1'); }
  const long = { ...chart, range: { r1: 0, c1: 0, r2: 3000, c2: 1 }, seriesLines: [{ markerSymbol: 'square' }] };
  const marks = (renderChartSvg(chartData(wb, id, long), long, 480, 300).match(/<rect class="chart-marker"/g) || []).length;
  expect(marks).toBeGreaterThan(400);
  expect(marks).toBeLessThanOrEqual(2000);
});
