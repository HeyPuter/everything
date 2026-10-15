import { describe, it, expect } from 'vitest';
import { grid, uvSphere } from '../../src/mesh/primitives';
import { faceNormals, vertexFaces, vertexNeighbors } from '../../src/mesh/mesh';
import { applyMeshFilter, type FilterMesh } from '../../src/paint/filters';
import { expandInside, expandValue, geodesicDistances, normalAngles, normalizeField, topologySteps } from '../../src/paint/expandmath';

function filterMesh(a: ReturnType<typeof grid>, extra: Partial<FilterMesh> = {}): FilterMesh {
  const m = { positions: a.positions, offsets: a.offsets, indices: a.indices };
  const nb = vertexNeighbors(m);
  const fn = faceNormals(m);
  const vf = vertexFaces(m);
  const nv = a.positions.length / 3;
  const normals = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    let x = 0,
      y = 0,
      z = 0;
    for (let k = vf.offsets[v]; k < vf.offsets[v + 1]; k++) {
      const f = vf.faces[k];
      x += fn[f * 3];
      y += fn[f * 3 + 1];
      z += fn[f * 3 + 2];
    }
    const l = Math.hypot(x, y, z) || 1;
    normals.set([x / l, y / l, z / l], v * 3);
  }
  return { orig: a.positions, normals, nbOffsets: nb.offsets, nb: nb.neighbors, ...extra };
}

const radius = (P: Float32Array, v: number) => Math.hypot(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);

describe('mesh filters', () => {
  const sphere = uvSphere(16, 8, 1);
  it('inflate pushes along the normals, negative strength deflates', () => {
    const fm = filterMesh(sphere);
    expect(radius(applyMeshFilter(fm, { type: 'INFLATE', strength: 0.5 }), 5)).toBeGreaterThan(1.01);
    expect(radius(applyMeshFilter(fm, { type: 'INFLATE', strength: -0.5 }), 5)).toBeLessThan(0.99);
  });
  it('scale scales around the origin', () => {
    const fm = filterMesh(sphere);
    expect(radius(applyMeshFilter(fm, { type: 'SCALE', strength: 1 }), 5)).toBeCloseTo(1.5, 4);
  });
  it('smooth shrinks a sphere, zero strength keeps it', () => {
    const fm = filterMesh(sphere);
    expect(radius(applyMeshFilter(fm, { type: 'SMOOTH', strength: 1 }), 20)).toBeLessThan(0.99);
    expect(Array.from(applyMeshFilter(fm, { type: 'SMOOTH', strength: 0 }))).toEqual(Array.from(sphere.positions));
  });
  it('respects the mask and hidden vertices', () => {
    const nv = sphere.positions.length / 3;
    const mask = new Float32Array(nv).fill(1);
    const res = applyMeshFilter(filterMesh(sphere, { mask }), { type: 'INFLATE', strength: 1 });
    expect(Array.from(res)).toEqual(Array.from(sphere.positions));
    const hidden = new Uint8Array(nv).fill(1);
    expect(Array.from(applyMeshFilter(filterMesh(sphere, { hidden }), { type: 'SCALE', strength: 1 }))).toEqual(Array.from(sphere.positions));
  });
  it('limits the deformation to the enabled axes', () => {
    const res = applyMeshFilter(filterMesh(sphere), { type: 'SCALE', strength: 1, axes: [false, false, true] });
    for (let v = 0; v < sphere.positions.length / 3; v++) {
      expect(res[v * 3]).toBeCloseTo(sphere.positions[v * 3]);
      expect(res[v * 3 + 2]).toBeCloseTo(sphere.positions[v * 3 + 2] * 1.5);
    }
  });
  it('sphere turns a flat grid round, random is deterministic per seed', () => {
    const g = grid(6, 6, 2);
    const s = applyMeshFilter(filterMesh(g), { type: 'SPHERE', strength: 1 });
    const d = [0, 10, 24].map((v) => Math.hypot(s[v * 3], s[v * 3 + 1], s[v * 3 + 2]));
    expect(d[0]).toBeCloseTo(d[1], 4);
    const fm = filterMesh(sphere);
    const a = applyMeshFilter(fm, { type: 'RANDOM', strength: 1, seed: 3 });
    expect(Array.from(applyMeshFilter(fm, { type: 'RANDOM', strength: 1, seed: 3 }))).toEqual(Array.from(a));
    expect(Array.from(applyMeshFilter(fm, { type: 'RANDOM', strength: 1, seed: 4 }))).not.toEqual(Array.from(a));
  });
  it('relax keeps a flat grid flat', () => {
    const g = grid(4, 4, 2);
    const P = g.positions.slice();
    P[12 * 3] += 0.2; // move the center vertex sideways
    const res = applyMeshFilter(filterMesh({ ...g, positions: P }), { type: 'RELAX', strength: 1 });
    for (let v = 0; v < res.length / 3; v++) expect(res[v * 3 + 2]).toBeCloseTo(0);
    expect(Math.abs(res[12 * 3])).toBeLessThan(0.2);
  });
});

describe('expand fields', () => {
  const g = grid(4, 4, 2); // 5×5 vertices
  const nb = vertexNeighbors(g);
  it('geodesic and topology distances grow away from the origin', () => {
    const d = geodesicDistances(g.positions, nb.offsets, nb.neighbors, [0]);
    expect(d[0]).toBe(0);
    expect(d[1]).toBeCloseTo(0.5);
    expect(d[24]).toBeCloseTo(4 * 0.5 * 2, 4);
    const t = topologySteps(nb.offsets, nb.neighbors, [0]);
    expect(t[24]).toBe(8);
    const hidden = new Uint8Array(25);
    for (let i = 0; i < 5; i++) hidden[5 + i] = 1; // a hidden row cuts the grid
    expect(topologySteps(nb.offsets, nb.neighbors, [0], hidden)[24]).toBe(Infinity);
    expect(normalizeField(new Float32Array([0, 2, Infinity, 4]))).toEqual(new Float32Array([0, 0.5, 1, 1]));
  });
  it('maps thresholds to inside tests and gradient values', () => {
    expect(expandInside(0.2, 0.3)).toBe(true);
    expect(expandInside(0.4, 0.3)).toBe(false);
    expect(expandInside(0.4, 0.3, { invert: true })).toBe(true);
    expect(expandValue(0.15, 0.3, { gradient: true })).toBeCloseTo(0.5);
    // two loops repeat the band
    expect(expandInside(0.6, 0.3, { loops: 2 })).toBe(true);
  });
  it('measures normal angles', () => {
    const N = new Float32Array([0, 0, 1, 1, 0, 0, 0, 0, -1]);
    const a = normalAngles(N, 0);
    expect(a[1]).toBeCloseTo(Math.PI / 2);
    expect(a[2]).toBeCloseTo(Math.PI);
  });
});
