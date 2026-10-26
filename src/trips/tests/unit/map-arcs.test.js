// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { geodesicArc, arcGeoJSON } from '../../src/map/arcs.js';
const vector = ([lng, lat]) => [Math.cos(lat * Math.PI / 180) * Math.cos(lng * Math.PI / 180), Math.cos(lat * Math.PI / 180) * Math.sin(lng * Math.PI / 180), Math.sin(lat * Math.PI / 180)];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
const lines = feature => feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
const equivalent = (a, b) => vector(a).every((n, i) => Math.abs(n - vector(b)[i]) < 1e-8);
function invariant(feature, from, to) {
  const segments = lines(feature); expect(equivalent(segments[0][0], from)).toBe(true); expect(equivalent(segments.at(-1).at(-1), to)).toBe(true);
  for (const line of segments) {
    expect(line.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < line.length; i++) {
      expect(line[i].every(Number.isFinite)).toBe(true); expect(Math.abs(line[i][0])).toBeLessThanOrEqual(180); expect(Math.abs(line[i][1])).toBeLessThanOrEqual(90);
      if (i) expect(Math.abs(line[i][0] - line[i - 1][0])).toBeLessThanOrEqual(180 + 1e-8);
    }
  }
}
describe('geodesic arcs', () => {
  it('samples a spherical great circle and preserves detached properties', () => {
    const from = [-123, 49], to = [139, 35], properties = { label: 'Route' }; const feature = geodesicArc(from, to, { segments: 64, properties, id: 'flight' }); invariant(feature, from, to);
    const normal = cross(vector(from), vector(to)); for (const point of lines(feature).flat()) expect(Math.abs(dot(normal, vector(point)))).toBeLessThan(1e-10);
    expect(feature.id).toBe('flight'); feature.properties.label = 'Other'; expect(properties.label).toBe('Route');
  });
  it('splits dateline crossings at geographically identical ±180 edges', () => {
    const from = [170, 10], to = [-170, 20], arc = geodesicArc(from, to); invariant(arc, from, to); expect(arc.geometry.type).toBe('MultiLineString');
    const [first, second] = arc.geometry.coordinates; expect(first.at(-1)[0]).toBe(180); expect(second[0][0]).toBe(-180); expect(first.at(-1)[1]).toBeCloseTo(second[0][1], 10);
    expect(first.at(-1)[1]).toBeGreaterThan(15); expect(first.at(-1)[1]).toBeLessThan(16);
  });
  it.each([[[0, 0], [180, 0]], [[45, 20], [-135, -20]], [[10, 89], [-170, -89]], [[0, 0], [179.99999999, 0]], [[180, 10], [-170, 20]], [[-180, 10], [170, 20]], [[180, 10], [-180, 10]], [[0, 90], [0, -90]]])('handles antipodal, polar and boundary endpoints %j → %j', (from, to) => {
    const one = geodesicArc(from, to), two = geodesicArc(from, to); invariant(one, from, to); expect(two).toEqual(one);
  });
  it('chooses the same antipodal half-circle in either direction', () => {
    const a = [45, 20], b = [-135, -20]; const forward = lines(geodesicArc(a, b)).flat(), backward = lines(geodesicArc(b, a)).flat().reverse();
    expect(forward.length).toBe(backward.length); for (let i = 0; i < forward.length; i++) expect(equivalent(forward[i], backward[i])).toBe(true);
  });
  it('keeps ordinary short arcs unsplit and bounds sampling work', () => {
    const arc = arcGeoJSON([-10, 0], [10, 0], { segments: 4 }); expect(arc.type).toBe('FeatureCollection'); expect(arc.features[0].geometry.type).toBe('LineString'); expect(arc.features[0].geometry.coordinates).toHaveLength(5);
    for (const segments of [0, 1, 2049, Infinity, 2.1]) expect(() => geodesicArc([0, 0], [1, 1], { segments })).toThrow(); expect(() => geodesicArc([181, 0], [0, 0])).toThrow();
  });
  it('keeps a seeded set of long routes finite and short within every line component', () => {
    let seed = 7; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 100; i++) { const a = [random() * 360 - 180, random() * 178 - 89], b = [random() * 360 - 180, random() * 178 - 89]; invariant(geodesicArc(a, b, { segments: 32 }), a, b); }
  });
});
