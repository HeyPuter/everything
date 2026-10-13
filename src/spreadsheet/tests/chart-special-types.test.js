import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef, parseRange } from '../src/core/cell.js';
import { chartData, defaultChart, normalizeChart } from '../src/core/charts.js';
import { bandPolygon, boxGroups, boxStats, buildHierarchy, fillDownLevels, hierarchyNodes, isoSegment, quartile, squarify, stockSeries,
  sunburstLayout, surfaceBands, surfaceGrid, surfaceTriangles, treemapLayout } from '../src/core/chart-special.js';
import { niceScale } from '../src/core/charts.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

function book(cells) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
  return { wb, id };
}
const chartOf = (type, range, extra = {}) => normalizeChart({ ...defaultChart(parseRange(range), { r: 0, c: 8 }), type, ...extra });
const svgDoc = markup => new JSDOM(markup, { contentType: 'image/svg+xml' }).window.document;

const TREE = { A1: 'Region', B1: 'Country', C1: 'City', D1: 'Sales',
  A2: 'Europe', B2: 'France', C2: 'Paris', D2: '50',
  B3: 'France', C3: 'Lyon', D3: '20',
  B4: 'Spain', C4: 'Madrid', D4: '30',
  A5: 'Asia', B5: 'Japan', C5: 'Tokyo', D5: '60',
  B6: 'Japan', C6: 'Osaka', D6: '25',
  A7: 'Africa', D7: '15' };

describe('hierarchy data', () => {
  it('reads leading label columns as levels, filling blank parents down', () => {
    const { wb, id } = book(TREE);
    const data = chartData(wb, id, chartOf('treemap', 'A1:D7'));
    expect(data.levels).toEqual([['Europe', 'France', 'Paris'], ['Europe', 'France', 'Lyon'], ['Europe', 'Spain', 'Madrid'],
      ['Asia', 'Japan', 'Tokyo'], ['Asia', 'Japan', 'Osaka'], ['Africa']]);
    expect(data.series).toHaveLength(1);
    expect(data.series[0]).toMatchObject({ name: 'Sales', values: [50, 20, 30, 60, 25, 15] });
    expect(data.categories.at(-1)).toBe('Africa');
    expect(data.sourceLayout.levelLines).toEqual([0, 1, 2]);
  });

  it('builds a tree whose parents sum their children, largest first', () => {
    const root = buildHierarchy(fillDownLevels([['A', 'x'], ['', 'y'], ['B', 'z'], ['C']]), [5, 7, 20, -3]);
    expect(root.value).toBe(32);
    expect(root.children.map(c => [c.name, c.value])).toEqual([['B', 20], ['A', 12]]);
    expect(root.children[1].children.map(c => c.name)).toEqual(['y', 'x']);
    // A branch with a value of its own keeps it beside its children.
    const own = buildHierarchy([['A'], ['A', 'x']], [4, 6]);
    expect(own.children[0].value).toBe(10);
    expect(own.children[0].children.map(c => [c.name, c.value, !!c.own])).toEqual([['x', 6, false], ['A', 4, true]]);
    expect(hierarchyNodes(own).length).toBe(3);
  });

  it('squarifies areas in proportion and keeps rectangles inside the box', () => {
    const values = [6, 6, 4, 3, 2, 2, 1];
    const rects = squarify(values, { x: 0, y: 0, w: 6, h: 4 });
    rects.forEach((r, i) => {
      expect(r.w * r.h).toBeCloseTo(values[i], 6);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9); expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(6 + 1e-9); expect(r.y + r.h).toBeLessThanOrEqual(4 + 1e-9);
    });
    // The paper's example: the first two values share the left column as near-squares.
    expect(rects[0]).toMatchObject({ x: 0, y: 0 });
    expect(rects[0].w).toBeCloseTo(3, 6);
    const root = buildHierarchy([['A', 'a'], ['A', 'b'], ['B', 'c']], [3, 1, 4]);
    const banner = treemapLayout(root, { x: 0, y: 0, w: 200, h: 100 }, { labels: 'banner', bannerHeight: 10, gap: 0 });
    const parentA = banner.find(r => r.node.name === 'A'), leafA = banner.filter(r => r.node.parent?.name === 'A');
    expect(parentA.header).toBe(10);
    for (const leaf of leafA) expect(leaf.y).toBeGreaterThanOrEqual(parentA.y + 10 - 1e-9);
  });

  it('lays sunburst rings in shares of their parent', () => {
    const root = buildHierarchy([['A', 'a'], ['A', 'b'], ['B']], [1, 3, 4]);
    const arcs = sunburstLayout(root);
    const span = name => { const arc = arcs.find(x => x.node.name === name); return arc.a1 - arc.a0; };
    expect(span('A')).toBeCloseTo(Math.PI, 9);
    expect(span('B')).toBeCloseTo(Math.PI, 9);
    expect(span('b')).toBeCloseTo(Math.PI * 3 / 4, 9);
    expect(arcs.find(x => x.node.name === 'b').depth).toBe(2);
  });
});

describe('box and whisker statistics', () => {
  it('computes exclusive and inclusive quartiles as the worksheet functions do', () => {
    const { wb, id } = book({ A1: '1', A2: '2', A3: '3', A4: '4', A5: '5', A6: '6', A7: '7', A8: '8', A9: '9', A10: '10',
      B1: '=QUARTILE.EXC(A1:A10,1)', B2: '=QUARTILE.EXC(A1:A10,3)', B3: '=QUARTILE.INC(A1:A10,1)', B4: '=QUARTILE.INC(A1:A10,3)' });
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quartile(sorted, .25, 'exclusive')).toBeCloseTo(wb.getValue(id, 0, 1), 12);
    expect(quartile(sorted, .75, 'exclusive')).toBeCloseTo(wb.getValue(id, 1, 1), 12);
    expect(quartile(sorted, .25, 'inclusive')).toBeCloseTo(wb.getValue(id, 2, 1), 12);
    expect(quartile(sorted, .75, 'inclusive')).toBeCloseTo(wb.getValue(id, 3, 1), 12);
    expect([quartile(sorted, .25), quartile(sorted, .75)]).toEqual([2.75, 8.25]);
    expect([quartile(sorted, .25, 'inclusive'), quartile(sorted, .75, 'inclusive')]).toEqual([3.25, 7.75]);
    expect(quartile([4, 8], .25)).toBe(4); // a rank before the first point holds to it
  });

  it('puts whiskers at the furthest points within 1.5 IQR and lists the rest as outliers', () => {
    const s = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 40], 'inclusive');
    expect(s).toMatchObject({ n: 10, min: 1, max: 40, median: 5.5, q1: 3.25, q3: 7.75, mean: 8.5, low: 1, high: 9, outliers: [40] });
    expect(s.inner).toHaveLength(9);
    expect(boxStats(['x', null], 'exclusive')).toBeNull();
    expect(boxStats([3, 3, 3])).toMatchObject({ q1: 3, median: 3, q3: 3, low: 3, high: 3, outliers: [] });
  });

  it('pools rows by category, and treats a range without one as a single group', () => {
    const { wb, id } = book({ A1: 'Course', B1: 'Score', A2: 'Math', B2: '70', A3: 'Art', B3: '90', A4: 'Math', B4: '80', A5: 'Art', B5: '60' });
    const grouped = boxGroups(chartData(wb, id, chartOf('boxWhisker', 'A1:B5')));
    expect(grouped.categories).toEqual(['Math', 'Art']);
    expect(grouped.series[0].groups).toEqual([[70, 80], [90, 60]]);
    const plain = boxGroups(chartData(wb, id, chartOf('boxWhisker', 'B1:B5')));
    expect(plain.categories).toEqual(['']);
    expect(plain.series[0].groups).toEqual([[70, 90, 80, 60]]);
  });
});

describe('stock series mapping', () => {
  const PRICES = { A1: 'Date', B1: 'Volume', C1: 'Open', D1: 'High', E1: 'Low', F1: 'Close',
    A2: '2026-01-05', B2: '1000', C2: '10', D2: '12', E2: '9', F2: '11',
    A3: '2026-01-06', B3: '1500', C3: '11', D3: '13', E3: '10', F3: '10.5' };
  it('maps the columns after the dates by subtype', () => {
    const { wb, id } = book(PRICES);
    const all = chartData(wb, id, chartOf('stock', 'A1:F3', { stock: 'vohlc' }));
    const v = stockSeries(all, 'vohlc');
    expect(v).toMatchObject({ volume: [1000, 1500], open: [10, 11], high: [12, 13], low: [9, 10], close: [11, 10.5] });
    expect(v.names).toMatchObject({ volume: 'Volume', close: 'Close' });
    const hlc = stockSeries(chartData(wb, id, chartOf('stock', 'A1:A3')), 'hlc');
    expect(hlc.missing).toEqual(['High', 'Low', 'Close']);
    const prices = chartData(wb, id, { ...chartOf('stock', 'A1:F3'), range: parseRange('A1:F3') });
    expect(stockSeries({ ...prices, series: prices.series.slice(2) }, 'hlc')).toMatchObject({ high: [12, 13], low: [9, 10], close: [11, 10.5] });
    expect(stockSeries({ ...prices, series: prices.series.slice(1) }, 'ohlc')).toMatchObject({ open: [10, 11], close: [11, 10.5] });
  });
});

describe('surface bands', () => {
  it('splits the value range into a band per major step and clips triangles to them', () => {
    const bands = surfaceBands(3, 47, { niceScale });
    expect(bands.bands[0].lo).toBe(0);
    expect(bands.bands.at(-1).hi).toBe(50);
    expect(bands.bands.length).toBe(5);
    const fixed = surfaceBands(0, 10, { min: 0, max: 10, step: 2.5, niceScale });
    expect(fixed.bands.map(b => b.lo)).toEqual([0, 2.5, 5, 7.5]);
    const tri = [[0, 0, 0], [1, 0, 10], [0, 1, 10]];
    const middle = bandPolygon(tri, 2.5, 5);
    expect(middle.length).toBe(4);
    for (const p of middle) expect(p[2]).toBeGreaterThanOrEqual(2.5 - 1e-9);
    expect(bandPolygon(tri, 20, 30)).toBeNull();
    const seg = isoSegment(tri, 5);
    expect(seg).toEqual([[.5, 0], [0, .5]]);
  });

  it('triangulates the grid of rows and series, skipping blank corners', () => {
    const grid = surfaceGrid({ categories: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [3, null] }] });
    expect(grid.z).toEqual([[1, 3], [2, null]]);
    expect(surfaceTriangles(grid)).toEqual([[[0, 0, 1], [0, 1, 3], [1, 0, 2]]]);
  });
});

describe('rendering', () => {
  const draw = (cells, type, range, extra = {}) => {
    const { wb, id } = book(cells);
    const chart = chartOf(type, range, extra);
    return renderChartSvg(chartData(wb, id, chart), chart, 600, 400);
  };
  it('draws a treemap leaf per row and parent labels in each layout', () => {
    for (const treemapLabels of ['overlapping', 'banner', 'none']) {
      const svg = draw(TREE, 'treemap', 'A1:D7', { labels: true, treemapLabels, title: 'Sales' });
      const doc = svgDoc(svg);
      expect(doc.querySelectorAll('.chart-treemap-leaf')).toHaveLength(6);
      expect(doc.querySelectorAll('.chart-treemap-banner').length).toBe(treemapLabels === 'banner' ? 5 : 0);
      expect(doc.querySelector('desc').textContent).toMatch(/6 items in 3 groups/);
      expect(svg).not.toMatch(/NaN|Infinity/);
    }
  });
  it('draws sunburst rings and a box and whisker chart', () => {
    const sun = svgDoc(draw(TREE, 'sunburst', 'A1:D7', { labels: true }));
    expect(sun.querySelectorAll('.chart-sunburst-arc').length).toBe(3 + 3 + 5);
    const box = draw({ A1: 'Score', A2: '1', A3: '2', A4: '3', A5: '4', A6: '5', A7: '6', A8: '50' }, 'boxWhisker', 'A1:A8', { box: { meanLine: true, innerPoints: true } });
    const doc = svgDoc(box);
    expect(doc.querySelectorAll('.chart-box')).toHaveLength(1);
    expect(doc.querySelectorAll('.chart-box-outlier')).toHaveLength(1);
    expect(doc.querySelectorAll('.chart-box-point')).toHaveLength(6);
    expect(doc.querySelectorAll('.chart-box-mean')).toHaveLength(1);
  });
  it('draws a funnel, the four stock subtypes and the surface views', () => {
    const funnel = svgDoc(draw({ A1: 'Stage', B1: 'Count', A2: 'Leads', B2: '500', A3: 'Calls', B3: '300', A4: 'Deals', B4: '80' }, 'funnel', 'A1:B4', { labels: true }));
    const widths = [...funnel.querySelectorAll('.chart-funnel-bar')].map(r => +r.getAttribute('width'));
    expect(widths[0]).toBeGreaterThan(widths[1]); expect(widths[1]).toBeGreaterThan(widths[2]);
    const prices = { A1: 'Date', B1: 'Volume', C1: 'Open', D1: 'High', E1: 'Low', F1: 'Close', A2: 'Mon', B2: '100', C2: '10', D2: '12', E2: '9', F2: '11',
      A3: 'Tue', B3: '120', C3: '11', D3: '13', E3: '8', F3: '9' };
    const ohlc = svgDoc(draw(prices, 'stock', 'C1:F3', { stock: 'ohlc' }));
    expect(ohlc.querySelectorAll('.chart-stock-hilo')).toHaveLength(2);
    expect(ohlc.querySelectorAll('.chart-stock-up')).toHaveLength(1);
    expect(ohlc.querySelectorAll('.chart-stock-down')).toHaveLength(1);
    const vhlc = svgDoc(draw({ ...prices, C1: '', C2: '', C3: '' }, 'stock', 'A1:F3', { stock: 'vhlc' }));
    expect(vhlc.querySelectorAll('.chart-stock-volume')).toHaveLength(2);
    expect(vhlc.querySelectorAll('.chart-axis-y2').length).toBeGreaterThan(0);
    const missing = draw(prices, 'stock', 'A1:B3', { stock: 'vohlc' });
    expect(missing).toContain('needs Volume, Open, High, Low, Close');
    const grid = { A1: '', B1: 'S1', C1: 'S2', D1: 'S3', A2: 'a', B2: '1', C2: '4', D2: '2', A3: 'b', B3: '5', C3: '8', D3: '6', A4: 'c', B4: '3', C4: '9', D4: '7' };
    for (const surfaceView of ['surface3d', 'wireframe3d', 'contour', 'wireframeContour']) {
      const svg = draw(grid, 'surface', 'A1:D4', { surfaceView });
      expect(svg).not.toMatch(/NaN|Infinity/);
      const doc = svgDoc(svg);
      expect(doc.querySelectorAll('[data-el="series"]').length).toBeGreaterThan(0);
    }
  });
});

describe('chart workflow', async () => {
  const { newExcelChart, changeSubtypePatch, subtypeOf } = await import('../src/core/chart-subtypes.js');
  const { recommendedSubtypes, quickLayoutsFor, quickLayoutPatch, hasAxes, chartElementPatch } = await import('../src/core/chart-design.js');
  it('recommends the new types for data of their shape', () => {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const prices = book({ A1: 'Date', B1: 'Open', C1: 'High', D1: 'Low', E1: 'Close',
      ...Object.fromEntries(days.flatMap((d, i) => [[`A${i + 2}`, d], [`B${i + 2}`, String(i + 1)], [`C${i + 2}`, String(i + 3)], [`D${i + 2}`, String(i)], [`E${i + 2}`, String(i + 2)]])) });
    expect(recommendedSubtypes(chartData(prices.wb, prices.id, chartOf('column', 'A1:E6')))[0]).toBe('stockOhlc');
    const tree = book(TREE);
    expect(recommendedSubtypes(chartData(tree.wb, tree.id, chartOf('column', 'C1:D7')), { levels: 3 })).toContain('treemap');
    const stages = book({ A1: 'Stage', B1: 'n', A2: 'a', B2: '9', A3: 'b', B3: '5', A4: 'c', B4: '2' });
    expect(recommendedSubtypes(chartData(stages.wb, stages.id, chartOf('column', 'A1:B4')))).toContain('funnel');
    const scores = book(Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`A${i + 1}`, i ? String(i * 3 % 11) : 'Score'])));
    expect(recommendedSubtypes(chartData(scores.wb, scores.id, chartOf('column', 'A1:A14')))).toEqual(expect.arrayContaining(['histogram', 'boxWhisker']));
  });
  it('inserts, lays out and changes the new types, dropping options that belong to the old one', () => {
    const { wb, id } = book(TREE);
    const chartId = wb.addChart(id, newExcelChart(wb, id, parseRange('A1:D7'), 'treemap'));
    let chart = wb.chartById(id, chartId);
    expect(chart).toMatchObject({ type: 'treemap', title: 'Sales', legend: true, legendPos: 'top', labels: true, treemapLabels: 'overlapping' });
    expect(hasAxes(chart)).toBe(false);
    expect(quickLayoutsFor(chart).map(l => l.id)).toEqual([1, 2, 3, 4]);
    wb.updateChart(id, chartId, quickLayoutPatch(chart, 4, { seriesCount: 1 }));
    expect(wb.chartById(id, chartId)).toMatchObject({ labels: false, legendPos: 'bottom' });
    expect(chartElementPatch(chart, 'trendline', 'linear')).toBeNull();
    wb.updateChart(id, chartId, changeSubtypePatch(wb.chartById(id, chartId), 'barOfPie'));
    chart = wb.chartById(id, chartId);
    expect(chart).toMatchObject({ type: 'pie', ofPie: { kind: 'bar', split: 3 } });
    expect(chart.treemapLabels).toBeUndefined();
    expect(subtypeOf(chart)).toBe('barOfPie');
    wb.updateChart(id, chartId, changeSubtypePatch(chart, 'pie'));
    expect(wb.chartById(id, chartId).ofPie).toBeUndefined();
    wb.undo();
    expect(subtypeOf(wb.chartById(id, chartId))).toBe('barOfPie');
  });
  it('keeps the new options through the document format', () => {
    const raw = { ...chartOf('boxWhisker', 'A1:B5'), box: { quartiles: 'inclusive', meanLine: true, gapWidth: 9999 } };
    const again = normalizeChart(JSON.parse(JSON.stringify(normalizeChart(raw))));
    expect(again.box).toEqual({ quartiles: 'inclusive', meanMarkers: true, meanLine: true, innerPoints: false, outliers: true, gapWidth: 100 });
    expect(normalizeChart({ ...chartOf('stock', 'A1:B5'), stock: 'nope' }).stock).toBe('hlc');
    expect(normalizeChart({ ...chartOf('column', 'A1:B5'), stock: 'ohlc', explosion: 20 })).not.toHaveProperty('stock');
    expect(normalizeChart({ ...chartOf('donut', 'A1:B5'), explosion: 20, ofPie: { kind: 'bar' } })).toMatchObject({ explosion: 20 });
    expect(normalizeChart({ ...chartOf('donut', 'A1:B5'), ofPie: { kind: 'bar' } })).not.toHaveProperty('ofPie');
  });
});
