import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { maxOf, minOf } from '../src/core/numeric.js';
import { descriptiveStatistics, histogram, layoutSize } from '../src/core/analysis-tools.js';
import { chartData, normalizeChart } from '../src/core/charts.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { consolidate } from '../src/core/consolidate.js';
import { suggestBreaks } from '../src/core/text-split.js';

// Math.max(...values) passes every value as an argument, and above some 125,000 of them the call stack
// overflows: Descriptive Statistics, Histogram and the treemap, sunburst, funnel and surface charts threw
// RangeError on a long column. The extremes are found with a loop now.
const N = 150000;
const values = Array.from({ length: N }, (_, i) => (i % 97) - 40);

describe('maxOf and minOf', () => {
  it('give what Math.max and Math.min give, without spreading', () => {
    expect(maxOf([3, 9, -2])).toBe(9);
    expect(minOf([3, 9, -2])).toBe(-2);
    expect(maxOf([])).toBe(-Infinity);
    expect(minOf([])).toBe(Infinity);
    expect(maxOf([], 0)).toBe(0);
    expect(maxOf([-5, -3], 1)).toBe(1);
    expect(minOf([4, 2], 3)).toBe(2);
    expect(maxOf([1, NaN, 3])).toBeNaN();
    expect(maxOf(new Map([[4, 'a'], [7, 'b']]).keys())).toBe(7);
    expect(maxOf(values)).toBe(56);
    expect(minOf(values)).toBe(-40);
  });
});

describe('long columns', () => {
  it('Descriptive Statistics and Histogram work through 150,000 values', () => {
    const stats = descriptiveStatistics([{ label: 'A', values }]);
    expect(stats.error).toBeUndefined();
    const row = (label) => stats.cells.find((r) => r[0]?.v === label || r[0] === label);
    const num = (cell) => (cell && typeof cell === 'object' ? cell.v : cell);
    expect(num(row('Minimum')[1])).toBe(-40);
    expect(num(row('Maximum')[1])).toBe(56);
    expect(num(row('Range')[1])).toBe(96);
    const hist = histogram({ label: 'A', values });
    expect(hist.error).toBeUndefined();
    expect(layoutSize(hist).rows).toBeGreaterThan(2);
  });

  it('renders hierarchy, funnel and surface charts of 150,000 rows', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const cells = [{ r: 0, c: 0, cell: { v: 'x', f: null } }, { r: 0, c: 1, cell: { v: 'y', f: null } }];
    for (let r = 1; r <= N; r++) cells.push({ r, c: 0, cell: { v: r, f: null } }, { r, c: 1, cell: { v: Math.sin(r / 100) * 100, f: null } });
    wb.setCells(id, cells);
    for (const type of ['treemap', 'sunburst', 'funnel', 'surface']) {
      const chart = normalizeChart({ type, range: { r1: 0, c1: 0, r2: N, c2: 1 }, anchor: { r: 0, c: 3 } });
      const svg = renderChartSvg(chartData(wb, id, chart), chart, 600, 400);
      expect(svg.startsWith('<svg'), type).toBe(true);
      expect(svg, type).not.toMatch(/NaN|Infinity/);
    }
  });

  it('consolidates and splits long lists', () => {
    // One label on every row gathers all the values into one cell.
    const rows = values.map((v) => ['k', v]);
    expect(consolidate([rows], { fn: 'max', leftColumn: true })).toEqual([['k', 56]]);
    expect(consolidate([rows], { fn: 'min', leftColumn: true })).toEqual([['k', -40]]);
    expect(suggestBreaks(Array.from({ length: N }, () => 'ab cd'))).toEqual([3]);
  });
});
