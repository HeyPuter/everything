// @vitest-environment happy-dom
// To Circle, Flatten and Space Evenly against recorded reference results (tests/fixtures/r4_shapeops.json):
// an irregular 8-vertex ring with a centre fan, a bumpy 4×4 grid, an unevenly spaced strip and a ring.
import { describe, it, expect } from 'vitest';
import fx from '../fixtures/r4_shapeops.json';
import { buildMesh, type PolyFace } from '../../src/mesh/mesh';
import { newMeshData } from '../../src/data/defaults';
import { MeshEdit } from '../../src/modes/editmesh/meshedit';
import { circularize, flattenSelection, spaceEvenly, fitCircle2D, cubicSpline, type CircleOptions } from '../../src/modes/editmesh/shapeops';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const F = fx as Any;

function edit(verts: number[][], faces: number[][], sel: number[]) {
  const me = newMeshData('M', buildMesh(verts.flat(), faces.map((f) => ({ verts: f }) as PolyFace)));
  const m = MeshEdit.from(me);
  m.sel = m.sel.map((_, i) => (sel.includes(i) ? 1 : 0));
  return m;
}
const maxErr = (m: MeshEdit, ref: number[][], idx?: number[]) => Math.max(...(idx ?? ref.map((_, i) => i)).map((i) => Math.max(...[0, 1, 2].map((k) => Math.abs(m.p(i)[k] - ref[i][k])))));
const base: CircleOptions = { factor: 1, fit_method: 'LEAST_SQUARE', angle: 0, use_custom_radius: false, custom_radius: 1, regular: true, flatten: 1, lock: [false, false, false] };
const ring = F.ring;
const ringIdx = [0, 1, 2, 3, 4, 5, 6, 7];

describe('To Circle', () => {
  const cases: [string, Partial<CircleOptions>][] = [
    ['default', {}],
    ['contract', { fit_method: 'CONTRACT' }],
    ['irregular', { regular: false }],
    ['radius', { use_custom_radius: true, custom_radius: 0.5 }],
    ['angle', { angle: 0.3 }],
    ['factor', { factor: 0.5 }],
    ['noflat', { flatten: 0 }],
    ['lockz', { lock: [false, false, true] }],
  ];
  it.each(cases)('ring %s', (name, o) => {
    const m = edit(ring.verts, ring.faces, ringIdx);
    expect(circularize(m, { ...base, ...o })).toBe(1);
    expect(maxErr(m, ring.out[`ring_${name}`].co, ringIdx)).toBeLessThan(name === 'noflat' ? 3e-3 : 2e-4);
    // the centre vertex stays
    expect(m.p(8)).toEqual(ring.verts[8].map((x: number) => Math.fround(x)));
  });
  it('the boundary of selected faces is the loop', () => {
    const m = edit(ring.verts, ring.faces, [...ringIdx, 8]);
    circularize(m, base);
    expect(maxErr(m, ring.out.fan_all.co)).toBeLessThan(2e-4);
  });
  it('an open chain keeps its span', () => {
    const m = edit(ring.verts, ring.faces, [0, 1, 2, 3, 4]);
    circularize(m, base);
    expect(maxErr(m, ring.out.chain.co, [0, 1, 2, 3, 4])).toBeLessThan(5e-4);
  });
  it('least squares circle fit of exact circle points', () => {
    const pts = [0, 1, 2, 3, 4].map((i) => [2 + 3 * Math.cos(i), -1 + 3 * Math.sin(i)] as [number, number]);
    const c = fitCircle2D(pts);
    expect([c.cx, c.cy, c.r].map((x) => +x.toFixed(6))).toEqual([2, -1, 3]);
  });
});

describe('Flatten', () => {
  const g = F.grid;
  const all = [...Array(16).keys()];
  it('Normal: the plane of the area-weighted normal through the centroid (recorded)', () => {
    const m = edit(g.verts, g.faces, all);
    flattenSelection(m, { factor: 1, method: 'NORMAL', lock: [false, false, false] });
    expect(maxErr(m, F.out.flat_normal.co)).toBeLessThan(1e-4);
  });
  it('Best Fit: planar result through the centroid, factor and lock', () => {
    const m = edit(g.verts, g.faces, all);
    flattenSelection(m, { factor: 1, method: 'BEST_FIT', lock: [false, false, false] });
    // all points on one plane
    const p = all.map((i) => m.p(i));
    const n = (() => {
      const a = p[0],
        b = p[3],
        c = p[12];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(...x);
      return x.map((k) => k / l);
    })();
    for (const q of p) expect(Math.abs((q[0] - p[0][0]) * n[0] + (q[1] - p[0][1]) * n[1] + (q[2] - p[0][2]) * n[2])).toBeLessThan(1e-5);
    const h = edit(g.verts, g.faces, all);
    flattenSelection(h, { factor: 0.5, method: 'BEST_FIT', lock: [true, false, false] });
    all.forEach((i) => {
      expect(h.p(i)[0]).toBeCloseTo(g.verts[i][0], 5);
      expect(h.p(i)[2]).toBeCloseTo((g.verts[i][2] + m.p(i)[2]) / 2, 5);
    });
  });
});

describe('Space Evenly', () => {
  const s = F.strip;
  const idx = [0, 1, 2, 3, 4, 5, 6, 7];
  it.each([
    ['cubic', 'CUBIC', 1],
    ['linear', 'LINEAR', 1],
    ['half', 'CUBIC', 0.5],
  ] as const)('open chain %s', (name, interpolation, factor) => {
    const m = edit(s.verts, s.faces, idx);
    expect(spaceEvenly(m, { factor, interpolation, lock: [false, false, false] })).toBe(1);
    expect(maxErr(m, F.out[`space_${name}`].co, idx)).toBeLessThan(1e-5);
  });
  it('closed loop (periodic spline)', () => {
    const m = edit(F.ring8.verts, [idx], idx);
    // only the edges: no face selection
    m.faces = [];
    m.looseEdges = idx.map((i) => [i, (i + 1) % 8] as [number, number]);
    spaceEvenly(m, { factor: 1, interpolation: 'CUBIC', lock: [false, false, false] });
    expect(maxErr(m, F.out.space_ring.co)).toBeLessThan(1e-5);
  });
  it('natural spline interpolates its knots', () => {
    const f = cubicSpline([0, 1, 3, 4], [0, 2, -1, 5], false);
    expect([0, 1, 3, 4].map(f).map((x) => +x.toFixed(9))).toEqual([0, 2, -1, 5]);
  });
});
