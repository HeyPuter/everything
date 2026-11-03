import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef, parseRange } from '../src/core/cell.js';
import { chartData, niceScale, axisLabel, defaultChart, normalizeChart, histogramBins, waterfallSteps } from '../src/core/charts.js';
import { renderChartSvg, renderSparklineSvg, linearFit } from '../src/ui/chartsvg.js';

function book(cells) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
  return { wb, id };
}

const TABLE = { A1: 'Month', B1: 'Sales', C1: 'Costs', A2: 'Jan', B2: '100', C2: '60', A3: 'Feb', B3: '120', C3: '70', A4: 'Mar', B4: '90', C4: '65' };

describe('chart data', () => {
  it('detects headers and a category column', () => {
    const { wb, id } = book(TABLE);
    const d = chartData(wb, id, defaultChart(parseRange('A1:C4'), { r: 0, c: 4 }));
    expect(d.hasHeaders).toBe(true);
    expect(d.categories).toEqual(['Jan', 'Feb', 'Mar']);
    expect(d.series.map((s) => s.name)).toEqual(['Sales', 'Costs']);
    expect(d.series[0].values).toEqual([100, 120, 90]);
  });

  it('handles rows as series, no headers, and blank cells', () => {
    const { wb, id } = book({ A1: 'Sales', B1: '1', C1: '2', D1: '', A2: 'Costs', B2: '3', C2: 'x', D2: '4' });
    const d = chartData(wb, id, { ...defaultChart(parseRange('A1:D2'), { r: 0, c: 0 }), seriesIn: 'rows' });
    expect(d.orientation).toBe('rows');
    expect(d.hasHeaders).toBe(true); // "Sales"/"Costs" label the series
    expect(d.series.map((s) => s.name)).toEqual(['Sales', 'Costs']);
    expect(d.series[1].values).toEqual([3, null, 4]);
    const plain = chartData(wb, id, { ...defaultChart(parseRange('B1:D2'), { r: 0, c: 0 }), seriesIn: 'cols', headers: false });
    expect(plain.hasHeaders).toBe(false);
    expect(plain.series.map((s) => s.name)).toEqual(['Series 1', 'Series 2', 'Series 3']);
    expect(plain.categories).toEqual(['1', '2']);
  });

  it('uses the first numeric column as x for scatter charts and formats dates as categories', () => {
    const { wb, id } = book({ A1: '1', B1: '10', A2: '2', B2: '20', A3: '4', B3: '35' });
    const d = chartData(wb, id, { ...defaultChart(parseRange('A1:B3'), { r: 0, c: 0 }), type: 'scatter' });
    expect(d.x).toEqual([1, 2, 4]);
    expect(d.series).toHaveLength(1);
    expect(d.series[0].values).toEqual([10, 20, 35]);
    const dated = book({ A1: '2024-01-01', B1: '5', A2: '2024-02-01', B2: '7' });
    const dd = chartData(dated.wb, dated.id, defaultChart(parseRange('A1:B2'), { r: 0, c: 0 }));
    expect(dd.categories).toEqual(['2024-01-01', '2024-02-01']);
    expect(dd.series).toHaveLength(1);
  });

  it('nice scales and axis labels', () => {
    expect(niceScale(0, 97)).toEqual({ min: 0, max: 100, step: 20 });
    expect(niceScale(-12, 30)).toEqual({ min: -20, max: 30, step: 10 });
    expect(niceScale(5, 5)).toEqual({ min: 0, max: 5, step: 1 });
    // Bounds given the wrong way round, at the limits of a double, or a subnormal apart stay finite.
    expect(niceScale(1000, 3)).toEqual({ min: 0, max: 1000, step: 200 });
    expect(niceScale(-1e308, 1e308)).toEqual({ min: -1e308, max: 1e308, step: 5e307 });
    for (const v of Object.values(niceScale(0, 5e-324))) expect(Number.isFinite(v)).toBe(true);
    expect(niceScale(0, 5e-324).step).toBeGreaterThan(0);
    for (const values of [[-1e308, 1e308, 0], [5e-324, 1e-323, 0]]) {
      const svg = renderChartSvg({ categories: ['a', 'b', 'c'], series: [{ name: 'v', values }] }, { type: 'column', legend: false }, 480, 300);
      expect(svg, String(values)).not.toMatch(/NaN|Infinity/);
    }
    expect(axisLabel(1500)).toBe('1,500');
    expect(axisLabel(25000)).toBe('25K');
    expect(axisLabel(2500000)).toBe('2.5M');
    expect(axisLabel(0.25)).toBe('0.25');
  });

  it('normalizes stored charts', () => {
    expect(normalizeChart(null)).toBeNull();
    const ch = normalizeChart({ type: 'nope', range: { r1: 2, c1: 0, r2: 0, c2: 1 }, anchor: { r: -1, c: 3 }, w: 10, h: 'x' });
    expect(ch.type).toBe('column');
    expect(ch.range).toEqual({ r1: 0, c1: 0, r2: 2, c2: 1 });
    expect(ch.anchor).toEqual({ r: 0, c: 3 });
    expect(ch.w).toBe(160);
    expect(ch.h).toBe(300);
  });
});

describe('chart svg', () => {
  it.each(['line', 'bar', 'scatter', 'bubble'])('renders a large sparse %s chart without overflowing the argument stack', (type) => {
    const count = 150000;
    const values = Array(count).fill(null);
    values[0] = 1;
    values[count - 1] = 2;
    const data = {
      categories: Array.from({ length: count }, (_, i) => String(i + 1)),
      series: [{ name: 'Values', values }],
      sizes: Array(count).fill(1),
    };
    const chart = { ...defaultChart({ r1: 0, c1: 0, r2: count - 1, c2: 0 }, { r: 0, c: 2 }), type, legend: false };
    const svg = renderChartSvg(data, chart, 480, 300);
    expect(svg).toContain('</svg>');
    expect(svg).not.toMatch(/NaN|Infinity/);
    if (type === 'scatter' || type === 'bubble') expect((svg.match(/<circle /g) || []).length).toBe(2);
    if (type === 'bar') expect(svg).toContain('Values · 150000: 2');
  });

  it('draws bars, lines, pies, and an empty state', () => {
    const { wb, id } = book(TABLE);
    const base = defaultChart(parseRange('A1:C4'), { r: 0, c: 4 });
    const data = chartData(wb, id, base);
    const column = renderChartSvg(data, { ...base, title: 'Q1' }, 480, 300);
    expect(column.startsWith('<svg')).toBe(true);
    expect(column).toContain('Q1');
    expect((column.match(/<rect /g) || []).length).toBeGreaterThanOrEqual(1 + 6 + 2); // background, 6 bars, 2 legend swatches
    expect(column).toContain('Jan');
    const stacked = renderChartSvg(data, { ...base, type: 'bar', stacked: true }, 480, 300);
    expect((stacked.match(/<rect /g) || []).length).toBeGreaterThanOrEqual(9);
    const line = renderChartSvg(data, { ...base, type: 'line' }, 480, 300);
    expect((line.match(/<polyline /g) || []).length).toBe(2);
    const area = renderChartSvg(data, { ...base, type: 'area' }, 480, 300);
    expect((area.match(/<polygon /g) || []).length).toBe(2);
    const pie = renderChartSvg(data, { ...base, type: 'pie' }, 480, 300);
    expect((pie.match(/<path /g) || []).length).toBe(3);
    expect(pie).toContain('%');
    const donut = renderChartSvg(data, { ...base, type: 'donut' }, 480, 300);
    expect(donut).toContain('evenodd');
    const scatter = renderChartSvg(chartData(wb, id, { ...base, type: 'scatter', range: parseRange('B2:C4') }), { ...base, type: 'scatter' }, 480, 300);
    expect((scatter.match(/<circle /g) || []).length).toBe(3);
    const empty = renderChartSvg(chartData(wb, id, { ...base, range: parseRange('E1:F3') }), base, 300, 200);
    expect(empty).toContain('No numbers to chart');
  });
});

describe('sparklines', () => {
  it('draws lines, columns, bars, and win/loss marks', () => {
    const line = renderSparklineSvg({ type: 'line', values: [1, 3, null, 2, 5] }, 100, 20);
    expect((line.match(/<polyline /g) || []).length).toBe(2); // the gap splits the line
    const cols = renderSparklineSvg({ type: 'column', values: [1, -2, 3], color: 'green' }, 100, 20);
    expect((cols.match(/<rect /g) || []).length).toBe(3);
    expect(cols).toContain('#1baf7a');
    expect(cols).toContain('var(--critical)');
    const wl = renderSparklineSvg({ type: 'winloss', values: [5, -1, 0] }, 60, 20);
    expect((wl.match(/<rect /g) || []).length).toBe(3);
    const bar = renderSparklineSvg({ type: 'bar', values: [2, 2] }, 100, 20);
    expect((bar.match(/<rect /g) || []).length).toBe(2);
    expect(renderSparklineSvg({ type: 'line', values: [null] }, 40, 10)).toContain('</svg>');
  });
});

describe('charts on a sheet', () => {
  it('adds, updates, deletes, undoes, and follows row and column changes', () => {
    const { wb, id } = book(TABLE);
    const chartId = wb.addChart(id, defaultChart(parseRange('A1:C4'), { r: 0, c: 4 }));
    expect(wb.sheet(id).charts).toHaveLength(1);
    expect(wb.undoLabel()).toBe('Insert chart');
    wb.updateChart(id, chartId, { title: 'Quarter', type: 'line', w: 50 });
    let ch = wb.chartById(id, chartId);
    expect(ch.title).toBe('Quarter');
    expect(ch.type).toBe('line');
    expect(ch.w).toBe(160); // never below the minimum
    wb.insertRows(id, 0, 2);
    ch = wb.chartById(id, chartId);
    expect(ch.range).toEqual({ r1: 2, c1: 0, r2: 5, c2: 2 });
    expect(ch.anchor).toEqual({ r: 2, c: 4 });
    wb.insertCols(id, 1, 1);
    ch = wb.chartById(id, chartId);
    expect(ch.range).toEqual({ r1: 2, c1: 0, r2: 5, c2: 3 });
    expect(ch.anchor).toEqual({ r: 2, c: 5 });
    wb.deleteCols(id, 4, 3); // the anchor column goes; the chart lands on the column that replaces it
    ch = wb.chartById(id, chartId);
    expect(ch.anchor).toEqual({ r: 2, c: 4 });
    const json = JSON.parse(JSON.stringify(wb.toJSON()));
    expect(json.sheets[0].charts[0].title).toBe('Quarter');
    const copy = new Workbook(json);
    expect(copy.sheets[0].charts[0].type).toBe('line');
    wb.deleteChart(id, chartId);
    expect(wb.sheet(id).charts).toHaveLength(0);
    wb.undo();
    expect(wb.sheet(id).charts).toHaveLength(1);
  });
});

describe('images as floating objects', () => {
  it('normalizes an image, keeps it in the sheet, and rejects bad sources', async () => {
    const { normalizeChart, isImage } = await import('../src/core/charts.js');
    const { Workbook } = await import('../src/core/workbook.js');
    const src = 'data:image/png;base64,iVBORw0KGgo=';
    const img = normalizeChart({ type: 'image', src, anchor: { r: 2, c: 3 }, w: 100, h: 50, title: 'logo.png' });
    expect(isImage(img)).toBe(true);
    expect(img.range).toEqual({ r1: 2, c1: 3, r2: 2, c2: 3 });
    expect(img.w).toBe(100);
    expect(normalizeChart({ type: 'image', src: 'https://example.com/x.png', anchor: { r: 0, c: 0 } })).toBeNull();
    expect(normalizeChart({ type: 'image', src, anchor: { r: 0, c: 0 }, w: 2, h: 2 }).w).toBe(24);
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    const objId = wb.addChart(id, { type: 'image', src, anchor: { r: 0, c: 0 }, w: 120, h: 80, title: 'logo.png' });
    expect(wb.chartById(id, objId).type).toBe('image');
    expect(wb.undoLabel()).toBe('Insert image');
    // Inserting rows above moves the image down with its anchor; the JSON round trip keeps the source.
    wb.insertRows(id, 0, 2);
    expect(wb.chartById(id, objId).anchor.r).toBe(2);
    const copy = new Workbook(wb.toJSON());
    expect(copy.sheets[0].charts[0]).toMatchObject({ type: 'image', src, title: 'logo.png' });
    wb.updateChart(id, objId, { src: 'data:image/jpeg;base64,AAAA', title: 'photo.jpg' }, 'Replace image');
    expect(wb.chartById(id, objId).src).toBe('data:image/jpeg;base64,AAAA');
  });
});

describe('image sizing', () => {
  it('lets an image shrink below the chart minimum but not below its own', async () => {
    const { Workbook } = await import('../src/core/workbook.js');
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    const objId = wb.addChart(id, { type: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', anchor: { r: 0, c: 0 }, w: 120, h: 80 });
    wb.updateChart(id, objId, { w: 40, h: 30 });
    expect(wb.chartById(id, objId)).toMatchObject({ w: 40, h: 30 });
    wb.updateChart(id, objId, { w: 5, h: 5 });
    expect(wb.chartById(id, objId)).toMatchObject({ w: 24, h: 24 });
  });
});

describe('data labels and axis titles', () => {
  it('writes values beside bars and points and draws axis titles', async () => {
    const { renderChartSvg } = await import('../src/ui/chartsvg.js');
    const { normalizeChart } = await import('../src/core/charts.js');
    const data = { categories: ['A', 'B'], series: [{ name: 'Sales', values: [10, 25] }], x: null, hasHeaders: true, orientation: 'cols' };
    const base = normalizeChart({ type: 'column', range: { r1: 0, c1: 0, r2: 2, c2: 1 }, anchor: { r: 0, c: 3 }, labels: true, xTitle: 'Region', yTitle: 'Units' });
    expect(base.labels).toBe(true);
    const svg = renderChartSvg(data, base, 480, 300);
    expect(svg).toContain('>25</text>');
    expect(svg).toContain('>10</text>');
    expect(svg).toContain('Region');
    expect(svg).toContain('rotate(-90)');
    expect(svg).toContain('Units');
    const plain = renderChartSvg(data, normalizeChart({ ...base, labels: false, xTitle: '', yTitle: '' }), 480, 300);
    expect(plain).not.toContain('font-size="10"'); // value labels are the only 10px text
    expect(svg.match(/font-size="10"/g).length).toBe(2);
    expect(renderChartSvg({ ...data, series: [{ name: 'S', values: [27.98, 5] }] }, base, 480, 300)).toContain('>28</text>');
    expect(plain).not.toContain('rotate(-90)');
    const line = renderChartSvg(data, normalizeChart({ ...base, type: 'line' }), 480, 300);
    expect(line).toContain('>25</text>');
    const bar = renderChartSvg(data, normalizeChart({ ...base, type: 'bar' }), 480, 300);
    expect(bar).toContain('>25</text>');
    expect(normalizeChart({ ...base, xTitle: 'x'.repeat(200) }).xTitle.length).toBe(80);
  });
});

describe('standalone SVG export', () => {
  it('resolves theme variables, honours fallbacks, and names a font', async () => {
    const { standaloneSvg, renderChartSvg } = await import('../src/ui/chartsvg.js');
    const { normalizeChart } = await import('../src/core/charts.js');
    const vars = { '--ink': '#111111', '--surface': '#ffffff', '--grid': '#e4e3dd', '--ink-2': '#444444', '--ink-3': '#777777' };
    const data = { categories: ['A', 'B'], series: [{ name: 'S', values: [1, 2] }], x: null, hasHeaders: true, orientation: 'cols' };
    const chart = normalizeChart({ type: 'column', range: { r1: 0, c1: 0, r2: 2, c2: 1 }, anchor: { r: 0, c: 3 }, title: 'T' });
    const raw = renderChartSvg(data, chart, 300, 200);
    expect(raw).toContain('var(--ink)');
    const out = standaloneSvg(raw, (n) => vars[n] || '');
    expect(out).not.toContain('var(');
    expect(out).toContain('fill="#111111"');
    expect(out.startsWith('<svg font-family="system-ui')).toBe(true);
    expect(standaloneSvg('<svg x="var(--missing, var(--ink))"/>', (n) => vars[n] || '')).toBe('<svg font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" x="#111111"/>');
    expect(standaloneSvg('<svg x="var(--none)"/>', () => '')).toContain('#888888');
  });
});

describe('100% stacked charts and trendlines', () => {
  it('scales stacked values to percentages of each category', () => {
    const { wb, id } = book(TABLE);
    const chart = { ...defaultChart(parseRange('A1:C4'), { r: 0, c: 4 }), stacked: true, stack100: true };
    const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 300);
    expect(svg).toContain('>100%<');
    expect(svg).not.toContain('>120<');
    expect(normalizeChart({ ...chart, anchor: { r: 0, c: 0 } })).toMatchObject({ stack100: true, trendline: false });
  });

  // Edit chart once carried a stacked column chart's stack over to a scatter, line or pie chart; such a chart,
  // saved then, read back with a stack nothing draws, and Add Chart Element and Format Trendline refused it a trendline.
  it('reads a stack a chart type cannot have as none, and keeps the stack of types that stack', async () => {
    const { trendlineAllowed } = await import('../src/core/chart-design.js');
    const base = { range: { r1: 0, c1: 0, r2: 3, c2: 2 }, anchor: { r: 0, c: 4 }, stacked: true, stack100: true };
    for (const type of ['scatter', 'pie', 'donut', 'radar', 'bubble', 'histogram']) {
      const chart = normalizeChart({ ...base, type });
      expect(chart).toMatchObject({ type, stacked: false, stack100: false });
      if (['scatter', 'bubble'].includes(type)) expect(trendlineAllowed(chart)).toBe(true);
    }
    for (const type of ['column', 'bar', 'line', 'area', 'combo']) expect(normalizeChart({ ...base, type })).toMatchObject({ type, stacked: true, stack100: true });
    const { wb, id } = book(TABLE);
    const chartId = wb.addChart(id, { ...base, type: 'scatter', trendline: true });
    expect(wb.chartById(id, chartId).stacked).toBe(false);
  });

  it('draws a dashed least-squares line for line, column, and scatter charts but not stacked ones', () => {
    const { wb, id } = book(TABLE);
    const line = { ...defaultChart(parseRange('A1:B4'), { r: 0, c: 4 }), type: 'line', trendline: true };
    expect(renderChartSvg(chartData(wb, id, line), line, 480, 300)).toContain('stroke-dasharray="5 4"');
    const column = { ...line, type: 'column' };
    expect(renderChartSvg(chartData(wb, id, column), column, 480, 300)).toContain('stroke-dasharray="5 4"');
    const stacked = { ...defaultChart(parseRange('A1:C4'), { r: 0, c: 4 }), stacked: true, trendline: true };
    expect(renderChartSvg(chartData(wb, id, stacked), stacked, 480, 300)).not.toContain('stroke-dasharray="5 4"');
    const { wb: w2, id: i2 } = book({ A1: '1', B1: '10', A2: '2', B2: '20', A3: '4', B3: '35' });
    const scatter = { ...defaultChart(parseRange('A1:B3'), { r: 0, c: 0 }), type: 'scatter', trendline: true };
    expect(renderChartSvg(chartData(w2, i2, scatter), scatter, 480, 300)).toContain('stroke-dasharray="5 4"');
    expect(linearFit([[0, 1], [1, 3], [2, 5]])).toEqual({ slope: 2, intercept: 1 });
    expect(linearFit([[1, 1]])).toBeNull();
    expect(linearFit([[2, 1], [2, 5]])).toBeNull();
  });
});

describe('chart appearance options', () => {
  it('uses chosen series colors, places the legend, fixes axis bounds, hides gridlines, and smooths lines', () => {
    const { wb, id } = book(TABLE);
    const base = defaultChart(parseRange('A1:C4'), { r: 0, c: 4 });
    const data = chartData(wb, id, base);
    const colored = { ...base, colors: ['#123456', null] };
    const svg = renderChartSvg(data, colored, 480, 300);
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('fill="var(--series-2, #eb6834)"'); // the second series keeps its palette colour, from the theme's token
    expect(normalizeChart({ ...colored, anchor: { r: 0, c: 0 }, colors: ['#123456', 'nope', '#ABCDEF', null] }).colors).toEqual(['#123456', null, '#abcdef']);
    const pie = renderChartSvg(data, { ...base, type: 'pie', colors: ['#111111'] }, 480, 300);
    expect(pie).toContain('fill="#111111"');

    // Legend on the right narrows the plot; on top it pushes the plot down.
    const bottomSvg = renderChartSvg(data, base, 480, 300);
    const rightSvg = renderChartSvg(data, { ...base, legendPos: 'right' }, 480, 300);
    const barsX = (out) => [...out.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" fill="(?:var\(--series-\d+, )?#/g)].map((m) => Number(m[1]) + Number(m[2]));
    expect(Math.max(...barsX(rightSvg))).toBeLessThan(Math.max(...barsX(bottomSvg)));
    expect(renderChartSvg(data, { ...base, legendPos: 'top' }, 480, 300)).toContain('Sales');
    expect(normalizeChart({ ...base, anchor: { r: 0, c: 0 }, legendPos: 'sideways' }).legendPos).toBe('bottom');

    // Fixed bounds: the axis shows them and marks are clipped to the plot.
    const bounded = { ...base, yMin: 50, yMax: 150 };
    const bsvg = renderChartSvg(data, bounded, 480, 300);
    expect(bsvg).toContain('>50<');
    expect(bsvg).toContain('>150<');
    expect(bsvg).not.toContain('>0<');
    expect(bsvg).toContain('clip-path="url(#plot-');
    expect(normalizeChart({ ...base, anchor: { r: 0, c: 0 }, yMin: 10, yMax: 5 })).toMatchObject({ yMin: null, yMax: null });
    // A lone bound at or past all the data still leaves the axis a positive extent.
    for (const [type, bound] of [['column', { yMin: 1000 }], ['line', { yMax: 0 }], ['bar', { yMin: 120 }], ['scatter', { yMax: 0 }], ['radar', { yMax: 0 }]]) {
      const out = renderChartSvg(data, { ...base, type, ...bound }, 480, 300);
      expect(out, `${type} ${JSON.stringify(bound)}`).not.toMatch(/NaN|Infinity/);
    }
    const flat = renderChartSvg({ categories: ['a', 'b'], series: [{ name: 'v', values: [5, 5] }] }, { ...base, yMin: 5 }, 480, 300);
    expect(flat).not.toMatch(/NaN|Infinity/);
    expect(flat).toContain('>5<');
    const above = renderChartSvg(data, { ...base, yMin: 1000 }, 480, 300);
    expect(above).toContain('>1,000<');
    expect(above).not.toContain('>0<');

    // Gridlines off leaves the value labels but no horizontal grid lines.
    const noGrid = renderChartSvg(data, { ...base, gridlines: false }, 480, 300);
    expect((noGrid.match(/stroke="var\(--grid\)"/g) || []).length).toBe(1);
    expect((bottomSvg.match(/stroke="var\(--grid\)"/g) || []).length).toBeGreaterThan(3);

    // Smooth lines are cubic paths instead of polylines.
    const smooth = renderChartSvg(data, { ...base, type: 'line', smooth: true }, 480, 300);
    expect(smooth).not.toContain('<polyline');
    expect((smooth.match(/<path d="M [\d.]+ [\d.]+ C /g) || []).length).toBe(2);
    const smoothArea = renderChartSvg(data, { ...base, type: 'area', smooth: true }, 480, 300);
    expect((smoothArea.match(/ Z" fill="(?:var\(--series-\d+, )?#/g) || []).length).toBe(2);
  });
});

describe('combo, histogram, and waterfall charts', () => {
  it('renders a histogram across a large supported sheet range', () => {
    const data = {
      categories: Array.from({ length: 20000 }, (_, i) => String(i + 1)),
      series: Array.from({ length: 10 }, (_, i) => ({ name: `Series ${i}`, values: new Array(20000).fill(i) })),
    };
    const chart = { ...defaultChart(parseRange('A1:J20000'), { r: 0, c: 11 }), type: 'histogram', bins: 3 };
    const binned = histogramBins(data.series.flatMap((s) => s.values), chart.bins);
    expect(binned).toEqual({ categories: ['0–3', '3–6', '6–9'], counts: [60000, 60000, 80000] });
    const svg = renderChartSvg(data, chart, 480, 300);
    expect(svg).toContain('80K');
    expect(svg).not.toMatch(/NaN|Infinity/);
  });

  it('draws a combo chart as columns plus a line for the last series', () => {
    const { wb, id } = book(TABLE);
    const chart = { ...defaultChart(parseRange('A1:C4'), { r: 0, c: 4 }), type: 'combo' };
    const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 300);
    expect((svg.match(/<rect [^>]*fill="var\(--series-1, #337bfc\)"/g) || []).length).toBe(3 + 1); // three Sales columns and a legend swatch
    expect((svg.match(/<polyline /g) || []).length).toBe(1);
    expect(svg).toContain('stroke="var(--series-2, #eb6834)"');
    expect(normalizeChart({ ...chart, anchor: { r: 0, c: 0 } }).type).toBe('combo');
  });

  it('bins numbers into the chosen count of equal bins, with round edges when the count is automatic', () => {
    expect(histogramBins([1, 2, 2, 3, 8, 9, 10], 3)).toEqual({ categories: ['1–4', '4–7', '7–10'], counts: [4, 0, 3] });
    expect(histogramBins([1, 2, 2, 3, 8, 9, 10])).toEqual({ categories: ['0–5', '5–10'], counts: [4, 3] });
    expect(histogramBins([5, 5, 5])).toEqual({ categories: ['5'], counts: [3] });
    expect(histogramBins([]).counts).toEqual([]);
    const { wb, id } = book({ A1: 'Score', A2: '12', A3: '18', A4: '25', A5: '31', A6: '33', A7: '47', A8: '52', A9: '58' });
    const chart = { ...defaultChart(parseRange('A1:A9'), { r: 0, c: 4 }), type: 'histogram', bins: 5 };
    const data = chartData(wb, id, chart);
    const svg = renderChartSvg(data, chart, 480, 300);
    expect(svg).toContain('12–21.2'); // five equal bins from 12 to 58
    expect(svg).toContain('Count');
    expect(normalizeChart({ ...chart, anchor: { r: 0, c: 0 }, bins: 500 }).bins).toBeNull();
    expect(normalizeChart({ ...chart, anchor: { r: 0, c: 0 } }).bins).toBe(5);
  });

  it('floats waterfall bars on the running total and ends with a total bar', () => {
    expect(waterfallSteps([100, -30, 50])).toEqual([
      { from: 0, to: 100, delta: 100, kind: 'increase' },
      { from: 100, to: 70, delta: -30, kind: 'decrease' },
      { from: 70, to: 120, delta: 50, kind: 'increase' },
      { from: 0, to: 120, delta: 120, kind: 'total' },
    ]);
    const { wb, id } = book({ A1: 'Step', B1: 'Change', A2: 'Start', B2: '100', A3: 'Refunds', B3: '-30', A4: 'Upsells', B4: '50' });
    const chart = { ...defaultChart(parseRange('A1:B4'), { r: 0, c: 4 }), type: 'waterfall', labels: true };
    const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 300);
    expect(svg).toContain('>Total<');
    expect(svg).toContain('fill="var(--critical, #c22a2a)"');
    expect(svg).toContain('−30');
    expect((svg.match(/stroke-dasharray="2 2"/g) || []).length).toBe(3);
    expect(svg).toContain('Increase');
  });
});

describe('radar and bubble charts', () => {
  it('draws one polygon per series around the categories', () => {
    const { wb, id } = book(TABLE);
    const chart = { ...defaultChart(parseRange('A1:C4'), { r: 0, c: 4 }), type: 'radar' };
    const svg = renderChartSvg(chartData(wb, id, chart), chart, 480, 300);
    expect((svg.match(/<polygon [^>]*fill="(?:var\(--series-\d+, )?#/g) || []).length).toBe(2); // Sales and Costs
    expect(svg).toContain('Jan');
    expect(svg).toContain('stroke="var(--grid)"');
    const two = renderChartSvg(chartData(wb, id, { ...chart, range: parseRange('A1:C3') }), chart, 480, 300);
    expect(two).toContain('at least three categories');
  });

  it('sizes bubbles by the third column', () => {
    const { wb, id } = book({ A1: 'x', B1: 'y', C1: 'size', A2: '1', B2: '10', C2: '4', A3: '2', B3: '20', C3: '16', A4: '3', B4: '15', C4: '1' });
    const chart = { ...defaultChart(parseRange('A1:C4'), { r: 0, c: 4 }), type: 'bubble' };
    const data = chartData(wb, id, chart);
    expect(data.x).toEqual([1, 2, 3]);
    expect(data.sizes).toEqual([4, 16, 1]);
    expect(data.series).toHaveLength(1);
    const svg = renderChartSvg(data, chart, 480, 300);
    const radii = [...svg.matchAll(/<circle [^>]*r="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(radii).toHaveLength(3);
    expect(radii[1]).toBeGreaterThan(radii[0]);
    expect(radii[0]).toBeGreaterThan(radii[2]);
    expect(Math.abs(radii[1] / radii[0] - 2)).toBeLessThan(0.01); // area follows the size: 16 vs 4 → radius ×2
    expect(normalizeChart({ ...chart, anchor: { r: 0, c: 0 } }).type).toBe('bubble');
  });
});

describe('charts show the data\'s number format', () => {
  it('labels axes and values in currency or percent when the cells are formatted so', () => {
    const { wb, id } = book({ A1: 'Item', B1: 'Price', A2: 'a', B2: '1500', A3: 'b', B3: '250' });
    wb.applyStyle(id, parseRange('B2:B3'), { fmt: 'currency', cur: 'EUR', dec: 2 });
    const chart = { ...defaultChart(parseRange('A1:B3'), { r: 0, c: 4 }), labels: true };
    const data = chartData(wb, id, chart);
    expect(data.valueStyle).toEqual({ fmt: 'currency', cur: 'EUR', dec: 2 });
    const svg = renderChartSvg(data, chart, 480, 300);
    expect(svg).toContain('€1,500');
    expect(axisLabel(2500000, { fmt: 'currency', cur: 'USD' })).toBe('$2.5M');
    expect(axisLabel(12000, { fmt: 'currency', cur: 'USD' })).toBe('$12K');
    expect(axisLabel(0.125, { fmt: 'percent' })).toBe('12.5%');
    expect(axisLabel(0.5, { fmt: 'percent' })).toBe('50%');
    expect(axisLabel(1500)).toBe('1,500');
    const { wb: w2, id: i2 } = book({ A1: 'x', B1: 'share', A2: 'a', B2: '0.25', A3: 'b', B3: '0.5' });
    w2.applyStyle(i2, parseRange('B2:B3'), { fmt: 'percent', dec: 0 });
    const svg2 = renderChartSvg(chartData(w2, i2, chart), chart, 480, 300);
    expect(svg2).toContain('50%');
  });
});

describe('duplicating a chart', () => {
  it('adds a nudged copy with the same data and a "(copy)" title, undoable', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setInput(id, 0, 0, 'a'); wb.setInput(id, 0, 1, '3');
    const first = wb.addChart(id, { ...defaultChart(parseRange('A1:B1'), { r: 2, c: 0 }), title: 'Sales', colors: ['#ff0000'] });
    const second = wb.duplicateChart(id, first);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    const copy = wb.chartById(id, second);
    const orig = wb.chartById(id, first);
    expect(copy.title).toBe('Sales (copy)');
    // The copy sits 24 pixels down and right, anchored to the cell its corner now lies in.
    expect(copy.anchor).toEqual({ r: 3, c: 0 });
    expect(copy.dx).toBe(orig.dx + 24);
    expect(copy.dy).toBe(orig.dy + 24 - wb.rowHeight(id, 2));
    expect(copy.colors).toEqual(['#ff0000']);
    expect(copy.range).toEqual(orig.range);
    expect(wb.sheet(id).charts.length).toBe(2);
    wb.undo();
    expect(wb.sheet(id).charts.length).toBe(1);
    expect(wb.duplicateChart(id, 'nope')).toBeNull();
  });
});

describe('text boxes as floating objects', () => {
  it('preserves small text box dimensions when moving or editing, including undo and redo', () => {
    const { wb, id } = book({});
    const boxId = wb.addChart(id, { type: 'text', text: 'Caption', anchor: { r: 0, c: 0 }, w: 80, h: 40 });
    wb.updateChart(id, boxId, { dx: 20, dy: 30 }, 'Move text box');
    expect(wb.chartById(id, boxId)).toMatchObject({ dx: 20, dy: 30, w: 80, h: 40 });
    wb.updateChart(id, boxId, { text: 'New caption' }, 'Edit text box');
    expect(wb.chartById(id, boxId)).toMatchObject({ text: 'New caption', w: 80, h: 40 });
    wb.undo();
    expect(wb.chartById(id, boxId)).toMatchObject({ text: 'Caption', w: 80, h: 40 });
    wb.redo();
    expect(wb.chartById(id, boxId)).toMatchObject({ text: 'New caption', w: 80, h: 40 });
    wb.updateChart(id, boxId, { w: 1, h: 1 }, 'Resize text box');
    expect(wb.chartById(id, boxId)).toMatchObject({ w: 40, h: 40 });
  });

  it('normalizes a text box with its style and keeps it in the sheet', async () => {
    const { normalizeChart, isTextBox, textBoxStyle } = await import('../src/core/charts.js');
    const { Workbook } = await import('../src/core/workbook.js');
    const box = normalizeChart({ type: 'text', text: 'Q3 review', anchor: { r: 1, c: 2 }, w: 10, h: 10, style: { size: 18, bold: true, color: '#C22A2A', bg: 'red', align: 'center', valign: 'middle', border: false } });
    expect(isTextBox(box)).toBe(true);
    expect(box.w).toBe(40);
    expect(box.style).toEqual({ size: 18, bold: true, italic: false, color: '#c22a2a', bg: null, align: 'center', valign: 'middle', border: false });
    expect(textBoxStyle(box)).toMatchObject({ fontSize: '18px', fontWeight: '600', color: '#c22a2a', textAlign: 'center', alignItems: 'center' });
    expect(normalizeChart({ type: 'text', anchor: { r: 0, c: 0 } }).style.size).toBe(13);
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    const objId = wb.addChart(id, { type: 'text', text: 'Hello', anchor: { r: 0, c: 0 }, w: 200, h: 60 });
    expect(wb.undoLabel()).toBe('Insert text box');
    wb.updateChart(id, objId, { text: 'Hello there', style: { italic: true } }, 'Edit text box');
    expect(wb.chartById(id, objId).text).toBe('Hello there');
    expect(wb.chartById(id, objId).style.italic).toBe(true);
    const dup = wb.duplicateChart(id, objId);
    expect(wb.chartById(id, dup).text).toBe('Hello there');
    expect(wb.undoLabel()).toBe('Duplicate text box');
    wb.insertRows(id, 0, 3);
    expect(wb.chartById(id, objId).anchor.r).toBe(3);
    const copy = new Workbook(wb.toJSON());
    expect(copy.sheets[0].charts[0]).toMatchObject({ type: 'text', text: 'Hello there' });
  });
});

describe('combo charts with a secondary axis', () => {
  it('draws the line against a right-hand axis in its color and keeps the bars on the left one', async () => {
    const { Workbook } = await import('../src/core/workbook.js');
    const { chartData, defaultChart, normalizeChart } = await import('../src/core/charts.js');
    const { renderChartSvg } = await import('../src/ui/chartsvg.js');
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    const rows = [['Month', 'Revenue', 'Margin %'], ['Jan', '12000', '0.31'], ['Feb', '15000', '0.28'], ['Mar', '9000', '0.35']];
    rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
    const base = { ...defaultChart(parseRange('A1:C4'), { r: 0, c: 4 }), type: 'combo' };
    const data = chartData(wb, id, base);
    const plain = renderChartSvg(data, normalizeChart(base), 480, 300);
    const dual = renderChartSvg(data, normalizeChart({ ...base, secondaryAxis: true }), 480, 300);
    expect((plain.match(/class="y2"/g) || []).length).toBe(0);
    expect((dual.match(/class="y2"/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(dual).toContain('text-anchor="start"');
    expect((dual.match(/<polyline /g) || []).length).toBe(1);
    // The margin line spans the plot on its own scale instead of hugging the baseline of the revenue scale.
    const ys = (svg) => [...svg.matchAll(/<polyline points="([^"]+)"/g)].flatMap((m) => m[1].split(' ').map((p) => Number(p.split(',')[1])));
    const spread = (list) => Math.max(...list) - Math.min(...list);
    expect(spread(ys(dual))).toBeGreaterThan(spread(ys(plain)) * 5);
    expect(normalizeChart({ ...base, secondaryAxis: 'yes' }).secondaryAxis).toBe(true);
    expect(normalizeChart(base).secondaryAxis).toBe(false);
  });
});
