import { expect, it } from 'vitest';
import { renderChartSvg } from '../src/ui/chartsvg.js';

const data = (values) => ({ categories: ['a', 'b', 'c', 'd'], series: [{ name: 'A', values }] });
const points = (svg) => [...svg.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)" r="3"/g)].map((m) => [+m[1], +m[2]]);

it('plots negative values below zero on a radar chart instead of on its centre', () => {
  const svg = renderChartSvg(data([-3, 5, 2, -1]), { type: 'radar', legend: false }, 480, 300);
  const [a, b, c, d] = points(svg);
  // The four spokes leave from one centre: a points up and c down, so the centre lies between them on x.
  const cx = a[0], cy = b[1];
  const r = ([x, y]) => Math.hypot(x - cx, y - cy);
  expect(r(a)).toBeGreaterThan(0);
  expect(r(d)).toBeGreaterThan(r(a));
  expect(r(c)).toBeGreaterThan(r(d));
  expect(r(b)).toBeGreaterThan(r(c));
  // The rings carry the axis below zero, the centre its floor.
  expect(svg).toMatch(/>-2</);
  expect(svg).toMatch(/>-4</);
  expect(svg).not.toMatch(/NaN|Infinity/);
});

it('spreads a radar chart of values all below zero', () => {
  const svg = renderChartSvg(data([-3, -5, -2, -1]), { type: 'radar', legend: false }, 480, 300);
  const pts = points(svg);
  const cx = pts[0][0], cy = pts[1][1];
  const r = pts.map(([x, y]) => Math.hypot(x - cx, y - cy));
  expect(new Set(r.map((v) => v.toFixed(1))).size).toBe(4);
  expect(r[3]).toBeGreaterThan(r[2]);
  expect(r[2]).toBeGreaterThan(r[0]);
  expect(r[0]).toBeGreaterThan(r[1]);
});

it('keeps a radar chart of positive values centred on zero', () => {
  const svg = renderChartSvg(data([0, 5, 2, 1]), { type: 'radar', legend: false }, 480, 300);
  const [a, b] = points(svg);
  // The zero lies on the centre: the point at a sits on the horizontal through b.
  expect(Math.abs(a[1] - b[1])).toBeLessThan(0.1);
  expect(svg).not.toMatch(/>-\d/);
});
