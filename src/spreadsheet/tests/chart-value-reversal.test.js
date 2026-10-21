import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { normalizeChart } from '../src/core/charts.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

const parser = new (new JSDOM('').window.DOMParser)();
const data = { categories: ['Alpha', 'Beta', 'Gamma'], x: [1, 2, 3], series: [
  { name: 'First', values: [-60, 30, 80], x: [1, 2, 3], sizes: [4, 9, 16] },
] };
function render(type, appearance = {}, options = {}, values = data) {
  const chart = normalizeChart({ type, anchor: { r: 0, c: 0 }, range: { r1: 0, c1: 0, r2: 2, c2: 1 }, legend: false,
    yMin: -100, yMax: 100, ...options, appearance: { plot: { x: .2, y: .2, w: .6, h: .6 },
      xRotationAuto: false, yStep: 50, xMin: 0, xMax: 4, xStep: 1,
      axisStyles: { x: { color: '#111111', majorTick: 'out' }, y: { color: '#222222', majorTick: 'out' }, y2: { color: '#333333' } }, ...appearance } });
  const doc = parser.parseFromString(renderChartSvg(values, chart, 600, 400), 'image/svg+xml');
  const rect = doc.querySelector('clipPath rect');
  const plot = { x: +rect.getAttribute('x'), y: +rect.getAttribute('y') + 1, w: +rect.getAttribute('width'), h: +rect.getAttribute('height') - 2 };
  return { doc, plot, chart, axis: key => doc.querySelector(`.chart-axis-line.chart-axis-${key}`) };
}

it.each(['column', 'bar', 'line', 'area', 'scatter', 'bubble'])('reverses %s values, gridlines, crossings and adjacent labels independently of category order', type => {
  for (const reverseCategories of [false, true]) for (const cross of ['autoZero', 'min', 'max', 40, -200, 200]) {
    const { doc, plot, axis } = render(type, { reverseValues: true, reverseCategories, axisCrossings: { x: cross }, bubble: type === 'bubble' ? {} : undefined });
    const horizontal = type === 'bar', key = horizontal ? 'x' : 'y';
    const value = cross === 'max' ? 100 : cross === 'min' ? -100 : typeof cross === 'number' ? Math.max(-100, Math.min(100, cross)) : 0;
    const coordinate = v => horizontal ? plot.x + (100 - v) / 200 * plot.w : plot.y + (v + 100) / 200 * plot.h;
    expect(+axis('x').getAttribute(`${key}1`)).toBeCloseTo(coordinate(value));
    const high = cross !== 'max';
    const texts = [...doc.querySelectorAll('text')];
    const category = texts.find(e => e.textContent === (['scatter', 'bubble'].includes(type) ? '1' : 'Alpha'));
    const offset = +category.getAttribute(key) - coordinate(value);
    expect(offset * (horizontal ? 1 : -1) > 0).toBe(high);
    expect(Math.abs(offset)).toBeLessThan(30); // nextTo stays at an interior crossing.
    const tick = doc.querySelector('.chart-axis-x.chart-axis-tick-major');
    expect((+tick.getAttribute(`${key}2`) - +tick.getAttribute(`${key}1`)) * (horizontal ? 1 : -1) > 0).toBe(high);
    const valueLabel = texts.find(e => e.textContent === '-100');
    expect(+valueLabel.getAttribute(horizontal ? 'x' : 'y')).toBeCloseTo(coordinate(-100) + (horizontal ? 0 : +valueLabel.getAttribute('font-size') * .35));
    const grid = doc.querySelector('.chart-gridline-y');
    expect(+grid.getAttribute(`${key}1`)).toBeCloseTo(coordinate(-100));
    if (type === 'column' || horizontal) {
      [...doc.querySelectorAll(horizontal ? '.chart-bar' : '.chart-column')].forEach((mark, i) => {
        expect(+mark.getAttribute(key)).toBeCloseTo(Math.min(coordinate(value), coordinate(data.series[0].values[i])));
        expect(+mark.getAttribute(horizontal ? 'width' : 'height')).toBeCloseTo(Math.abs(coordinate(value) - coordinate(data.series[0].values[i])));
      });
    } else if (type === 'bubble') {
      [...doc.querySelectorAll('.chart-bubble')].forEach((mark, i) => expect(+mark.getAttribute('cy')).toBeCloseTo(coordinate(data.series[0].values[i])));
    } else {
      const path = doc.querySelector('path.chart-series').getAttribute('d');
      for (const v of data.series[0].values) expect(path).toContain(` ${coordinate(v)}`);
      if (type === 'area') expect(path).toContain(` ${coordinate(value)} Z`);
    }
  }
});

it.each(['column', 'bar'])('follows perpendicular low/high ends when %s values reverse', type => {
  for (const position of ['low', 'high']) {
    const { doc, plot } = render(type, { reverseValues: true, xLabelPosition: position, axisCrossings: { x: 40 } });
    const label = [...doc.querySelectorAll('text')].find(e => e.textContent === 'Alpha');
    const coordinate = +label.getAttribute(type === 'bar' ? 'x' : 'y');
    if (type === 'bar') expect(position === 'low' ? coordinate > plot.x + plot.w : coordinate < plot.x).toBe(true);
    else expect(position === 'low' ? coordinate < plot.y : coordinate > plot.y + plot.h).toBe(true);
  }
});

it.each(['column', 'bar', 'area'])('reflects signed %s stacks without changing sums or fills', type => {
  const values = { ...data, series: [...data.series, { name: 'Second', values: [20, -10, 5] }] };
  for (const stack100 of [false, true]) {
    const options = { stacked: true, stack100, yMin: stack100 ? -1 : -100, yMax: stack100 ? 1 : 100 };
    const ordinary = render(type, {}, options, values), reversed = render(type, { reverseValues: true }, options, values);
    const marks = r => [...r.doc.querySelectorAll(type === 'area' ? '.chart-area' : '.chart-column,.chart-bar')];
    const coordinate = type === 'bar' ? 'x' : 'y', size = type === 'bar' ? 'width' : 'height';
    marks(ordinary).forEach((mark, i) => {
      const reflected = marks(reversed)[i];
      expect(reflected.getAttribute('fill')).toBe(mark.getAttribute('fill'));
      if (type !== 'area') {
        const start = +mark.getAttribute(coordinate), length = +mark.getAttribute(size);
        const edge = type === 'bar' ? ordinary.plot.x : ordinary.plot.y, extent = type === 'bar' ? ordinary.plot.w : ordinary.plot.h;
        expect(+reflected.getAttribute(coordinate)).toBeCloseTo(2 * edge + extent - start - length);
        expect(+reflected.getAttribute(size)).toBeCloseTo(length);
      } else {
        const coords = path => [...path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(m => [+m[1], +m[2]]);
        const first = coords(mark.getAttribute('d')), second = coords(reflected.getAttribute('d'));
        expect(second).toHaveLength(first.length);
        first.forEach(([x, y], j) => { expect(second[j][0]).toBe(x); expect(second[j][1]).toBeCloseTo(2 * ordinary.plot.y + ordinary.plot.h - y); });
      }
    });
  }
});

it('reverses the secondary scale independently of primary columns and preserves trend direction', () => {
  const values = { ...data, series: [...data.series, { name: 'Secondary', values: [2, 6, 8], x: [1, 2, 3] }] };
  for (const reverseValues of [false, true]) {
    const { doc, plot } = render('combo', { reverseValues, reverseSecondaryValues: true, y2Min: 0, y2Max: 10, y2Step: 2 }, { secondaryAxis: true, trendline: true }, values);
    const line = doc.querySelector('path.chart-series').getAttribute('d');
    for (const v of [2, 6, 8]) expect(line).toContain(` ${plot.y + v / 10 * plot.h}`);
    // The columns' trendline comes first; the line's, on the secondary scale, last.
    const trend = [...doc.querySelectorAll('line[stroke-dasharray="5 4"]')].at(-1);
    expect(+trend.getAttribute('y2')).toBeGreaterThan(+trend.getAttribute('y1'));
    const first = doc.querySelector('.chart-column');
    const expected = plot.y + plot.h * (reverseValues ? .2 : .5);
    expect(+first.getAttribute('y')).toBeCloseTo(expected);
  }
});

it('reflects bubble errors and retains their native plus/minus meaning', () => {
  const { doc, plot } = render('bubble', { reverseValues: true, reverseCategories: true, bubble: { series: [{ errors: [
    { axis: 'y', type: 'fixedVal', value: 10, direction: 'plus' }, { axis: 'x', type: 'fixedVal', value: .5, direction: 'minus' },
  ] }] } });
  const y = doc.querySelector('.chart-error-bar[data-axis="y"]').getAttribute('d');
  expect(y).toContain(` ${plot.y + .2 * plot.h} L`);
  expect(y).toContain(` ${plot.y + .25 * plot.h}`);
  const x = doc.querySelector('.chart-error-bar[data-axis="x"]').getAttribute('d');
  expect(x).toContain(`M ${plot.x + .875 * plot.w} `);
  expect(x).toContain(` L ${plot.x + .75 * plot.w} `);
});

it.each(['column', 'bar'])('places %s outside labels beyond reversed endpoints', type => {
  const { doc } = render(type, { reverseValues: true, valueLabels: [{ show: true, position: 'outEnd' }] }, { labels: true });
  const mark = doc.querySelector(type === 'bar' ? '.chart-bar' : '.chart-column');
  const label = [...doc.querySelectorAll('text')].find(e => e.textContent === '-60');
  if (type === 'bar') expect(+label.getAttribute('x')).toBeGreaterThan(+mark.getAttribute('x') + +mark.getAttribute('width'));
  else expect(+label.getAttribute('y')).toBeLessThan(+mark.getAttribute('y'));
});

it('accepts only boolean reversal flags and leaves malformed values at the normal orientation', () => {
  for (const invalid of ['maxMin', 'false', 1, null, {}, []]) {
    const { chart } = render('column', { reverseValues: invalid, reverseSecondaryValues: invalid });
    expect(chart.appearance.reverseValues).toBe(false);
    expect(chart.appearance.reverseSecondaryValues).toBe(false);
  }
});

it('aligns legacy bubble axis paint with reversed crossings and avoids duplicate native axes', () => {
  const bubble = { xAxisColor: '#123456', yAxisColor: '#654321' };
  const legacy = render('bubble', { reverseValues: true, reverseCategories: true, axisStyles: undefined, axisCrossings: { x: 40, y: 1 }, bubble });
  const x = legacy.doc.querySelector('line[stroke="#123456"]'), y = legacy.doc.querySelector('line[stroke="#654321"]');
  expect(+x.getAttribute('y1')).toBeCloseTo(legacy.plot.y + .7 * legacy.plot.h);
  expect(+y.getAttribute('x1')).toBeCloseTo(legacy.plot.x + .75 * legacy.plot.w);
  const native = render('bubble', { reverseValues: true, bubble });
  expect(native.doc.querySelector('line[stroke="#123456"]')).toBeNull();
  expect(native.doc.querySelector('line[stroke="#654321"]')).toBeNull();
  expect(native.doc.querySelectorAll('.chart-axis-line')).toHaveLength(2);
});
