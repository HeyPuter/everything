import { describe, it, expect } from 'vitest';
import {
  parseGraphData,
  parseDelimited,
  toDelimited,
  transposeCells,
  switchXY,
  niceScale,
  formatValue,
  layoutGraph,
  wedgeAnchors,
  thickLine,
  cellNumber,
  trimCells,
  valueScale,
  graphOptions,
  dataNotes,
  dataNotesText,
} from '../src/features/graphs/graph-math.js';

const DATA = [
  ['', 'A', 'B'],
  ['Q1', '3', '2'],
  ['Q2', '5', '-1'],
];

describe('graph data', () => {
  it('reads legends, categories and values', () => {
    const d = parseGraphData(DATA, 'column');
    expect(d.categories).toEqual(['Q1', 'Q2']);
    expect(d.series.map((s) => s.name)).toEqual(['A', 'B']);
    expect(d.series[1].values).toEqual([2, -1]);
  });

  it('detects labels without an empty corner and keeps quoted numbers as labels', () => {
    const d = parseGraphData([['"2024"', '4'], ['"2025"', '6']], 'column');
    expect(d.headerRow).toBe(false);
    expect(d.categories).toEqual(['2024', '2025']);
    expect(d.series[0].values).toEqual([4, 6]);
    const plain = parseGraphData([['1', '2'], ['3', '4']], 'column');
    expect(plain.series).toHaveLength(2);
    expect(plain.categories).toEqual(['', '']);
    expect(cellNumber('1,234.5')).toBe(1234.5);
    expect(cellNumber('abc')).toBeNull();
    expect(cellNumber('')).toBeNull();
  });

  it('reads scatter data as y and x column pairs', () => {
    const d = parseGraphData([['S1', ''], ['2', '1'], ['4', '3']], 'scatter');
    expect(d.series).toHaveLength(1);
    expect(d.series[0].name).toBe('S1');
    expect(d.series[0].values).toEqual([2, 4]);
    expect(d.series[0].xs).toEqual([1, 3]);
    const sw = switchXY([['S1', ''], ['2', '1'], ['4', '3']]);
    expect(sw[1]).toEqual(['1', '2']);
    expect(sw[0]).toEqual(['S1', '']);
  });

  it('transposes and trims', () => {
    expect(transposeCells(DATA)).toEqual([
      ['', 'Q1', 'Q2'],
      ['A', '3', '5'],
      ['B', '2', '-1'],
    ]);
    expect(trimCells([['1', '', ''], ['', '', ''], ['']])).toEqual([['1']]);
  });

  it('imports CSV and TSV', () => {
    expect(parseDelimited('a,b\n1,2\r\n3,4\n')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(parseDelimited('x\ty\n"1"\t2')).toEqual([['x', 'y'], ['"1"', '2']]);
    expect(parseDelimited('"a, b","say ""hi"""\n1,2')).toEqual([['a, b', 'say "hi"'], ['1', '2']]);
    expect(parseDelimited('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseDelimited('﻿a,b')).toEqual([['a', 'b']]);
    expect(toDelimited([['a', 'b'], ['1', '2']])).toBe('a\tb\n1\t2');
    expect(toDelimited([['a,b', 'c']], ',')).toBe('"a,b",c');
  });
});

describe('scales', () => {
  it('picks readable steps and includes zero', () => {
    expect(niceScale(3, 97, 5)).toEqual({ min: 0, max: 100, step: 20, divisions: 5 });
    expect(niceScale(-12, 40, 5)).toMatchObject({ min: -20, max: 40, step: 20 });
    expect(niceScale(0.12, 0.93, 5)).toMatchObject({ min: 0, max: 1, step: 0.2 });
    expect(niceScale(5, 5, 5)).toMatchObject({ min: 0, max: 5 });
    expect(niceScale(102, 108, 5, false)).toMatchObject({ min: 102, max: 108, step: 2, divisions: 3 });
  });

  it('honors manual values and formats labels', () => {
    const opt = graphOptions({ value: { manual: true, min: 10, max: 50, divisions: 4 } });
    expect(valueScale([1, 2], opt)).toEqual({ min: 10, max: 50, divisions: 4, step: 10 });
    expect(formatValue(2.5, '$', 'k')).toBe('$2.5k');
    expect(formatValue(1 / 3)).toBe('0.33');
  });
});

describe('data notes', () => {
  it('counts cells left out of the graph: text among the values and negative pie values', () => {
    const cells = [['', 'A', 'B'], ['Q1', '-5', 'abc'], ['Q2', '3', '-1']];
    expect(dataNotes(cells, 'column')).toEqual({ text: 1, negative: 0 });
    expect(dataNotes(cells, 'pie')).toEqual({ text: 1, negative: 2 });
    expect(dataNotesText(dataNotes(cells, 'pie'))).toBe('Left out: 1 cell is not a number; 2 negative values (pie graphs show positive values only).');
    expect(dataNotesText(dataNotes(DATA, 'column'))).toBe('');
  });
});

describe('graph layout', () => {
  const base = { type: 'column', data: DATA, options: {}, frame: { w: 200, h: 100 } };

  it('lays out every graph type with finite geometry for enormous values', () => {
    const scale = niceScale(-1e300, 1e300);
    expect([scale.min, scale.max, scale.step].every(Number.isFinite)).toBe(true);
    const data = [['', 'A', 'B'], ['x', '1e308', '-1e308'], ['y', '5', '1e300']];
    const finite = (o) => (typeof o === 'number' ? Number.isFinite(o) : !o || typeof o !== 'object' || Object.values(o).every(finite));
    for (const type of ['column', 'stacked-column', 'bar', 'stacked-bar', 'line', 'area', 'scatter', 'pie', 'radar']) {
      const s = layoutGraph({ ...base, type, data });
      if (type !== 'scatter') expect(s.marks.length, type).toBeGreaterThan(0);
      expect(finite(s.marks) && finite(s.lines) && finite(s.texts) && finite(s.bars), type).toBe(true);
    }
  });

  it('lays out grouped columns from zero', () => {
    const s = layoutGraph(base);
    expect(s.scale).toMatchObject({ min: -2, max: 6 });
    const bars = s.bars;
    expect(bars).toHaveLength(4);
    const a1 = bars.find((b) => b.series === 0 && b.category === 0);
    // Value 3 on a -2..6 axis over 100 units: from y 75 (zero) up to y 37.5.
    expect(a1.rect.y).toBeCloseTo(37.5);
    expect(a1.rect.h).toBeCloseTo(37.5);
    // Cluster 80% of 100, two columns of 40 each at 90%.
    expect(a1.rect.w).toBeCloseTo(36);
    expect(a1.rect.x).toBeCloseTo(10 + 2);
    const neg = bars.find((b) => b.series === 1 && b.category === 1);
    expect(neg.rect.y).toBeCloseTo(75);
    expect(neg.negative).toBe(true);
    expect(s.texts.some((t) => t.text === 'Q1' && t.align === 'center')).toBe(true);
    expect(s.texts.some((t) => t.text === '6' && t.role === 'value')).toBe(true);
    expect(s.legend.map((l) => l.label.text)).toEqual(['A', 'B']);
    expect(s.keys[0]).toEqual(s.legend[0].rect);
  });

  it('stacks columns and bars', () => {
    const s = layoutGraph({ ...base, type: 'stacked-column', data: [['', 'A', 'B'], ['x', '2', '3']] });
    const [b0, b1] = [s.bars.find((b) => b.series === 0), s.bars.find((b) => b.series === 1)];
    expect(b1.rect.y + b1.rect.h).toBeCloseTo(b0.rect.y);
    const h = layoutGraph({ ...base, type: 'stacked-bar', data: [['', 'A', 'B'], ['x', '2', '3']] });
    const [h0, h1] = [h.bars.find((b) => b.series === 0), h.bars.find((b) => b.series === 1)];
    expect(h0.horizontal).toBe(true);
    expect(h1.rect.x).toBeCloseTo(h0.rect.x + h0.rect.w);
  });

  it('draws lines with markers, filled lines and edge-to-edge placement', () => {
    const s = layoutGraph({ ...base, type: 'line' });
    expect(s.marks.filter((m) => m.role === 'line')).toHaveLength(2);
    expect(s.marks.filter((m) => m.role === 'marker')).toHaveLength(4);
    const firstMarker = s.marks.find((m) => m.role === 'marker' && m.series === 0 && m.category === 0);
    expect(firstMarker.rect.x + firstMarker.rect.w / 2).toBeCloseTo(50);
    const e = layoutGraph({ ...base, type: 'line', options: { edgeToEdge: true, filledLines: true, markPoints: false } });
    expect(e.marks.every((m) => m.role === 'fill' && m.closed)).toBe(true);
    const xs = e.marks[0].anchors.map((a) => a.x);
    expect(Math.min(...xs)).toBeCloseTo(0, 0);
  });

  it('stacks areas edge to edge', () => {
    const s = layoutGraph({ ...base, type: 'area', data: [['', 'A', 'B'], ['x', '1', '1'], ['y', '2', '2']] });
    expect(s.marks).toHaveLength(2);
    const top = s.marks[1].anchors.slice(0, 2);
    expect(top[0].x).toBe(0);
    expect(top[1].x).toBe(200);
  });

  it('places scatter points on numeric axes', () => {
    const s = layoutGraph({ ...base, type: 'scatter', data: [['S', ''], ['0', '0'], ['10', '10']], options: { connectPoints: false } });
    const m = s.marks.filter((x) => x.role === 'marker');
    expect(m).toHaveLength(2);
    expect(m[1].rect.x + m[1].rect.w / 2).toBeCloseTo(200);
    expect(m[1].rect.y + m[1].rect.h / 2).toBeCloseTo(0);
  });

  it('splits pies into wedges in proportion', () => {
    const s = layoutGraph({ ...base, type: 'pie', data: [['', 'A', 'B'], ['', '1', '3']], options: { pieLegend: 'wedges' } });
    expect(s.marks).toHaveLength(2);
    expect(s.legend).toHaveLength(0);
    expect(s.texts.filter((t) => t.role === 'wedge').map((t) => t.text)).toEqual(['A', 'B']);
    // The first wedge spans a quarter turn clockwise from 12 o'clock.
    const w = s.marks[0].anchors;
    expect(w[1].y).toBeLessThan(w[0].y);
    expect(w[w.length - 1].x).toBeGreaterThan(w[0].x);
    const even = layoutGraph({ ...base, type: 'pie', data: [['', 'A'], ['p', '1'], ['q', '4']], options: { piePosition: 'even' } });
    const radius = (m) => Math.max(...m.anchors.map((a) => a.x)) - Math.min(...m.anchors.map((a) => a.x));
    expect(radius(even.marks[0])).toBeCloseTo(radius(even.marks[1]));
    const ratio = layoutGraph({ ...base, type: 'pie', data: [['', 'A'], ['p', '1'], ['q', '4']] });
    expect(radius(ratio.marks[1]) / radius(ratio.marks[0])).toBeCloseTo(2);
  });

  it('draws radar spokes and series polygons', () => {
    const s = layoutGraph({ ...base, type: 'radar', data: [['', 'A'], ['x', '1'], ['y', '2'], ['z', '3']], options: { value: { tickLength: 'full' } } });
    expect(s.lines.filter((l) => l.role === 'axis')).toHaveLength(3);
    expect(s.lines.some((l) => l.role === 'grid')).toBe(true);
    expect(s.marks.find((m) => m.role === 'line').closed).toBe(true);
  });

  it('places value axes and gridlines from options', () => {
    const s = layoutGraph({ ...base, options: { valueAxis: 'both', value: { tickLength: 'full', prefix: '$' } } });
    expect(s.lines.filter((l) => l.role === 'axis').length).toBe(3);
    expect(s.lines.some((l) => l.role === 'grid')).toBe(true);
    expect(s.texts.some((t) => t.text === '$6' && t.align === 'left')).toBe(true);
    const top = layoutGraph({ ...base, options: { legendTop: true } });
    expect(top.legend[0].rect.y).toBeLessThan(0);
    expect(top.legend[1].rect.x).toBeGreaterThan(top.legend[0].rect.x);
  });

  it('builds wedge and thick line geometry', () => {
    const full = wedgeAnchors(0, 0, 10, 0, Math.PI * 2);
    expect(full).toHaveLength(4);
    const q = wedgeAnchors(0, 0, 10, 0, Math.PI / 2);
    expect(q[0]).toMatchObject({ x: 0, y: 0 });
    expect(q[1].y).toBeCloseTo(-10);
    expect(q[2].x).toBeCloseTo(10);
    const t = thickLine([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2);
    expect(t.map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual([[0, 1], [10, 1], [10, -1], [0, -1]]);
  });
});
