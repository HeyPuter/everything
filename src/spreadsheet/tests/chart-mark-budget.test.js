// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import * as charts from '../src/core/charts.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { openChartDialog } from '../src/ui/chartdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

const bars = (svg) => svg.match(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="(?:var\(--series-\d+, )?#[0-9a-f]{6}\)?" rx="1"/g) || [];
const titles = (svg) => (svg.match(/<title>/g) || []).length;
const many = (n, seriesCount, spikeAt = -1) => ({
  categories: Array.from({ length: n }, (_, i) => `c${i}`),
  series: Array.from({ length: seriesCount }, (_, s) => ({ name: `s${s}`, values: Array.from({ length: n }, (_, i) => (i === spikeAt ? 100 : 1 + ((i + s) % 7))) })),
});

describe('charts over very large ranges', () => {
  it('draws one real category per pixel when there are more categories than pixels, keeping the peak', () => {
    const svg = renderChartSvg(many(3000, 1, 1234), { type: 'column', legend: false }, 440, 230);
    expect(bars(svg).length).toBeLessThanOrEqual(440);
    expect(bars(svg).length).toBeGreaterThan(200);
    expect(svg).toContain('c1234: 100'); // the spike is the category its pixel keeps, tooltip and all
    expect(svg.length).toBeLessThan(200000);
  });

  it('drops per-mark tooltips past the mark budget and keeps the markup small', () => {
    const svg = renderChartSvg(many(3000, 8), { type: 'column', legend: false }, 440, 230);
    expect(bars(svg).length).toBeLessThanOrEqual(440 * 8);
    expect(titles(svg)).toBe(0);
    expect(svg.length).toBeLessThan(600000);
    const line = renderChartSvg(many(3000, 1), { type: 'line', legend: false }, 440, 230);
    expect(/<polyline points="([^"]+)"/.exec(line)[1].split(' ').length).toBeLessThanOrEqual(440);
  });

  it('thins a scatter cloud to the budget while the trendline still fits every point', () => {
    const n = 5000;
    const data = { categories: Array.from({ length: n }, (_, i) => `${i}`), x: Array.from({ length: n }, (_, i) => i), series: [{ name: 'y', values: Array.from({ length: n }, (_, i) => i * 2) }] };
    const svg = renderChartSvg(data, { type: 'scatter', legend: false, trendline: true }, 440, 230);
    expect((svg.match(/<circle /g) || []).length).toBeLessThanOrEqual(2000);
    expect((svg.match(/<circle /g) || []).length).toBeGreaterThan(1000);
    expect(svg).toContain('Linear (y): y = 2x, R² = 1');
  });

  it('leaves ordinary charts as they were: every mark drawn, each with its tooltip', () => {
    const svg = renderChartSvg(many(12, 2), { type: 'column', legend: false }, 440, 230);
    expect(bars(svg)).toHaveLength(24);
    expect(titles(svg)).toBe(24);
  });

  it('thins a radar to the pixels of its circumference and drops its points and tooltips past the budget', () => {
    const svg = renderChartSvg(many(20000, 3), { type: 'radar', legend: false }, 480, 300);
    expect(svg.length).toBeLessThan(400000);
    expect((svg.match(/<circle /g) || []).length).toBe(0);
    expect(titles(svg)).toBe(0);
    const polygons = [...svg.matchAll(/<polygon points="([^"]+)" fill="(?:var\(--series-\d+, )?#/g)].map((m) => m[1].split(' ').length);
    expect(polygons).toHaveLength(3); // one per series, each with at most a vertex per pixel of arc
    for (const points of polygons) expect(points).toBeLessThanOrEqual(1000);
    // Category labels and spokes keep to what can be read around the ring.
    expect((svg.match(/fill="var\(--ink-2\)">c\d+<\/text>/g) || []).length).toBeLessThan(120);
    expect((svg.match(/<line /g) || []).length).toBeLessThan(120);
    // An ordinary radar keeps every point, tooltip and label.
    const small = renderChartSvg(many(12, 2), { type: 'radar', legend: false }, 480, 300);
    expect((small.match(/<circle /g) || []).length).toBe(24);
    expect(titles(small)).toBe(24);
    expect((small.match(/fill="var\(--ink-2\)">c\d+<\/text>/g) || []).length).toBe(12);
  });

  it('merges the changes of the categories sharing a pixel into one waterfall bar, keeping the running total exact', () => {
    const data = many(20000, 1);
    const total = data.series[0].values.reduce((a, b) => a + b, 0);
    const svg = renderChartSvg(data, { type: 'waterfall', legend: false }, 480, 300);
    expect(svg.length).toBeLessThan(400000);
    const rects = (svg.match(/<rect [^>]*rx="1"/g) || []).length;
    expect(rects).toBeLessThanOrEqual(480);
    expect(rects).toBeGreaterThan(100);
    expect(svg).toContain('<title>Total: 80K</title>');
    expect(svg).toContain('<title>c0–c'); // a merged bar is named for the run of categories it covers
    // The merged bars' changes add up to the total exactly.
    const deltas = [...svg.matchAll(/<title>c\d+(?:–c\d+)?: \+([\d,]+)<\/title>/g)].map((m) => Number(m[1].replace(/,/g, '')));
    expect(deltas.length).toBe(rects - 1);
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(total);
    // An ordinary waterfall draws a bar per change, each with its tooltip, then the total.
    const small = renderChartSvg({ categories: ['a', 'b', 'c'], series: [{ name: 'v', values: [100, -30, 50] }] }, { type: 'waterfall', legend: false }, 480, 300);
    expect((small.match(/<rect [^>]*rx="1"/g) || []).length).toBe(4);
    expect(small).toContain('<title>a: +100</title>');
    expect(small).toContain('<title>b: −30</title>');
    expect(small).toContain('<title>Total: 120</title>');
  });

  it('gathers the pie slices too thin to see into one Other slice', () => {
    const data = many(20000, 1);
    const svg = renderChartSvg(data, { type: 'pie', legend: false }, 480, 300);
    expect(svg.length).toBeLessThan(400000);
    const slices = (svg.match(/<path d="M /g) || []).length;
    expect(slices).toBeLessThanOrEqual(1000);
    expect(slices).toBeGreaterThan(100);
    expect(svg).toMatch(/<title>Other \(\d{2},\d{3} slices\): [\d,]+ \((9\d|100)%\)<\/title>/);
    // An ordinary pie draws every slice, with its tooltip, and no Other.
    const small = renderChartSvg(many(12, 1), { type: 'pie', legend: false }, 480, 300);
    expect((small.match(/<path d="M /g) || []).length).toBe(12);
    expect(titles(small)).toBe(12);
    expect(small).not.toContain('Other');
  });
});

describe('the chart dialog preview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    document.body.innerHTML = '<div id="app"></div>';
  });
  afterEach(() => {
    closeAllModals();
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('neither re-reads the range nor redraws on every title keystroke', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    [['Month', 'Sales', 'Costs'], ['Jan', '100', '10'], ['Feb', '200', '15'], ['Mar', '150', '20']]
      .forEach((row, r) => row.forEach((value, c) => wb.setInput(id, r, c, value)));
    const spy = vi.spyOn(charts, 'chartData');
    openChartDialog({ wb, sheetId: () => id, range: () => ({ r1: 0, c1: 0, r2: 3, c2: 2 }), grid: { focus: vi.fn(), selectChart: vi.fn() } });
    const opened = spy.mock.calls.length;
    const preview = () => document.querySelector('.chart-preview').innerHTML;
    const before = preview();
    const title = document.querySelector('[aria-label="Title"]');
    for (const ch of 'Quarterly') { title.value += ch; title.dispatchEvent(new Event('input')); }
    expect(preview()).toBe(before);
    vi.advanceTimersByTime(200);
    expect(preview()).toContain('>Quarterly<');
    expect(spy.mock.calls.length).toBe(opened);
    // Options that only change the drawing reuse the data; what the data depends on reads it again.
    [...document.querySelectorAll('label.check')].find((node) => node.textContent === 'Gridlines').querySelector('input').click();
    expect(spy.mock.calls.length).toBe(opened);
    const seriesIn = document.querySelector('[aria-label="Series in"]');
    seriesIn.value = 'rows';
    seriesIn.dispatchEvent(new Event('change'));
    expect(spy.mock.calls.length).toBe(opened + 1);
    expect(preview()).toContain('>Quarterly<');
  });
});
