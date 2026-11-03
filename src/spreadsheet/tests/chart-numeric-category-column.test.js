// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData, defaultChart, normalizeChart } from '../src/core/charts.js';
import { runTool } from '../src/core/aitools.js';
import { openChartDialog } from '../src/ui/chartdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

// A line chart of x and y columns drew the x column as a line of its own (y = x) beside y: numbers in the first
// column were always a series, so steps 1, 2, 3 or years along the chart could not label it without a blank corner.
function sheetOf(rows) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  return { wb, id, range: { r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 } };
}
const chartOf = (range, patch = {}) => normalizeChart({ ...defaultChart(range, { r: 0, c: 4 }), id: 'c1', ...patch });

describe('a first column of numbers counting up evenly', () => {
  it('labels the categories of a line chart instead of plotting as a series', () => {
    const { wb, id, range } = sheetOf([['x', 'y'], [1, 3], [2, 5], [3, 4], [4, 8]]);
    const data = chartData(wb, id, chartOf(range, { type: 'line' }));
    expect(data.categories).toEqual(['1', '2', '3', '4']);
    expect(data.series.map(s => s.name)).toEqual(['y']);
    expect(data.series[0].values).toEqual([3, 5, 4, 8]);
  });

  it('reads years and fractional steps', () => {
    const years = sheetOf([['Year', 'Sales', 'Costs'], [2019, 10, 4], [2020, 12, 5], [2021, 9, 7]]);
    const yearData = chartData(years.wb, years.id, chartOf(years.range, { type: 'column' }));
    expect(yearData.categories).toEqual(['2019', '2020', '2021']);
    expect(yearData.series.map(s => s.name)).toEqual(['Sales', 'Costs']);
    const steps = sheetOf([['t', 'd'], [0, 1], [0.1, 4], [0.2, 9], [0.3, 16]]);
    expect(chartData(steps.wb, steps.id, chartOf(steps.range, { type: 'line' })).series).toHaveLength(1);
  });

  // Whether the column counts up is the column's own: hiding a year (by hand or with a filter) left the years shown
  // uneven, and the chart turned them into a line of its own (2019 to 2023) dwarfing the sales.
  it('keeps labelling the categories while some of its rows or columns are hidden', () => {
    const { wb, id, range } = sheetOf([['Year', 'Sales'], [2019, 5], [2020, 9], [2021, 4], [2022, 7], [2023, 8]]);
    wb.sheet(id).hiddenRows.add(3);
    const data = chartData(wb, id, chartOf(range, { type: 'line' }));
    expect(data.categories).toEqual(['2019', '2020', '2022', '2023']);
    expect(data.series.map(s => s.name)).toEqual(['Sales']);
    expect(data.series[0].values).toEqual([5, 9, 7, 8]);
    const across = sheetOf([['Step', 1, 2, 3, 4], ['Load', 3, 5, 4, 8]]);
    across.wb.sheet(across.id).hiddenCols.add(2);
    const rows = chartData(across.wb, across.id, chartOf(across.range, { type: 'column', seriesIn: 'rows' }));
    expect(rows.categories).toEqual(['1', '3', '4']);
    expect(rows.series.map(s => s.name)).toEqual(['Load']);
    // A hidden row that breaks the count keeps it a series, as it is with the row on show.
    const broken = sheetOf([['x', 'y'], [1, 3], [2, 5], [9, 4], [3, 8]]);
    broken.wb.sheet(broken.id).hiddenRows.add(3);
    expect(chartData(broken.wb, broken.id, chartOf(broken.range, { type: 'line' })).series).toHaveLength(2);
  });

  it('stays a series without a header over it, as plain numbers without names are read', () => {
    const { wb, id, range } = sheetOf([[1, 3], [2, 5], [3, 4]]);
    expect(chartData(wb, id, chartOf(range, { type: 'line' })).series).toHaveLength(2);
  });

  it('stays a series when the numbers are uneven, too few, or on a scatter chart', () => {
    const uneven = sheetOf([['Total', 'Month'], [10, 3], [25, 5], [31, 4]]);
    expect(chartData(uneven.wb, uneven.id, chartOf(uneven.range, { type: 'line' })).series.map(s => s.name)).toEqual(['Total', 'Month']);
    const two = sheetOf([['x', 'y'], [1, 3], [2, 5]]);
    expect(chartData(two.wb, two.id, chartOf(two.range, { type: 'line' })).series).toHaveLength(2);
    const xy = sheetOf([['x', 'y'], [1, 3], [2, 5], [3, 4]]);
    const scatter = chartData(xy.wb, xy.id, chartOf(xy.range, { type: 'scatter' }));
    expect(scatter.x).toEqual([1, 2, 3]);
    expect(scatter.series.map(s => s.name)).toEqual(['y']);
  });
});

describe('the categoryLabels setting', () => {
  it('decides either way over the guess, and is kept by normalizeChart', () => {
    const { wb, id, range } = sheetOf([['x', 'y'], [1, 3], [2, 5], [3, 4]]);
    expect(chartData(wb, id, chartOf(range, { type: 'line', categoryLabels: false })).series.map(s => s.name)).toEqual(['x', 'y']);
    const uneven = sheetOf([['t', 'v'], [0, 3], [1.5, 5], [4, 4]]);
    const forced = chartData(uneven.wb, uneven.id, chartOf(uneven.range, { type: 'line', categoryLabels: true }));
    expect(forced.categories).toEqual(['0', '1.5', '4']);
    expect(forced.series.map(s => s.name)).toEqual(['v']);
    expect(normalizeChart({ ...chartOf(range), categoryLabels: true }).categoryLabels).toBe(true);
    expect(normalizeChart({ ...chartOf(range), categoryLabels: 'yes' }).categoryLabels).toBe('auto');
  });

  it('is set by the AI tools as first_column', () => {
    const { wb, id } = sheetOf([['t', 'v'], [0, 3], [1.5, 5], [4, 4]]);
    const env = { sheetId: () => id };
    const made = JSON.parse(runTool(wb, 'create_chart', { data_range: 'A1:B4', type: 'line', first_column: 'categories' }, env).content);
    expect(wb.chartById(id, made.id).categoryLabels).toBe(true);
    expect(runTool(wb, 'update_chart', { chart: made.id, first_column: 'series' }, env).ok).toBe(true);
    expect(wb.chartById(id, made.id).categoryLabels).toBe(false);
    expect(runTool(wb, 'update_chart', { chart: made.id, first_column: 'rows' }, env).content).toMatch(/first_column/);
  });
});

describe('the chart dialog', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
  afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

  it('offers Categories, hidden on scatter charts, and saves the choice', () => {
    const { wb, id } = sheetOf([['x', 'y'], [1, 3], [2, 5], [3, 4]]);
    const selectChart = vi.fn();
    openChartDialog({ wb, sheetId: () => id, range: () => ({ r1: 0, c1: 0, r2: 3, c2: 1 }), grid: { focus: vi.fn(), selectChart } }, { type: 'line' });
    vi.runAllTimers();
    const select = document.querySelector('select[aria-label="Categories"]');
    expect(select.value).toBe('auto');
    expect(select.closest('label').hidden).toBe(false);
    document.querySelector('.chart-type[data-type="scatter"]').click();
    expect(select.closest('label').hidden).toBe(true);
    document.querySelector('.chart-type[data-type="line"]').click();
    select.value = 'false';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('form.chart-form').requestSubmit();
    const chart = wb.chartById(id, selectChart.mock.calls[0][0]);
    expect(chart.categoryLabels).toBe(false);
    expect(chartData(wb, id, chart).series).toHaveLength(2);
  });
});
