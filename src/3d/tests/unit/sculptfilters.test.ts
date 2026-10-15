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

describe('mask helpers', async () => {
  const { mixMask, boundaryLoops, cavityValues } = await import('../../src/paint/maskmath');
  it('mixes mask values', () => {
    expect(mixMask('MIX', 0.2, 0.8, 1)).toBeCloseTo(0.8);
    expect(mixMask('MULTIPLY', 0.5, 0.5, 1)).toBeCloseTo(0.25);
    expect(mixMask('ADD', 0.7, 0.7, 1)).toBe(1);
    expect(mixMask('SUBTRACT', 0.2, 0.5, 1)).toBe(0);
    expect(mixMask('MIX', 0.2, 0.8, 0.5)).toBeCloseTo(0.5);
  });
  it('finds the open boundary loop of a grid, oriented to close it', () => {
    const loops = boundaryLoops([
      { verts: [0, 1, 4, 3] },
      { verts: [1, 2, 5, 4] },
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(6);
  });
  it('marks a dent as a cavity', () => {
    const g = grid(4, 4, 2);
    const P = g.positions.slice();
    P[12 * 3 + 2] = -0.3;
    const nb = vertexNeighbors(g);
    const N = new Float32Array((P.length / 3) * 3);
    for (let v = 0; v < P.length / 3; v++) N[v * 3 + 2] = 1;
    const c = cavityValues(P, N, nb.offsets, nb.neighbors);
    expect(c[12]).toBeGreaterThan(0);
    expect(c[7]).toBeLessThan(0);
  });
});

describe('paint color / weight helpers', async () => {
  const { adjustColor, rgbToHsv, hsvToRgb, quantize, mirrorVertexMap } = await import('../../src/paint/paintmath');
  it('adjusts levels, hsv and brightness/contrast', () => {
    const c = new Float32Array([0.2, 0.4, 0.6, 0.5]);
    adjustColor(c, { offset: 0.1, gain: 2 });
    expect(Array.from(c).map((x) => +x.toFixed(3))).toEqual([0.6, 1, 1, 0.5]);
    const d = new Float32Array([1, 0, 0, 1]);
    adjustColor(d, { hue: 0.5 + 1 / 3 });
    expect(Array.from(d).map((x) => +x.toFixed(3))).toEqual([0, 1, 0, 1]);
    const e = new Float32Array([0.25, 0.5, 0.75, 1]);
    adjustColor(e, { contrast: -1 });
    expect(Array.from(e.subarray(0, 3)).map((x) => +x.toFixed(3))).toEqual([0.5, 0.5, 0.5]);
    adjustColor(e, { brightness: 0.25 });
    expect(e[0]).toBeCloseTo(0.75);
    const [h, s, v] = rgbToHsv(0.2, 0.6, 0.4);
    expect(hsvToRgb(h, s, v).map((x) => +x.toFixed(4))).toEqual([0.2, 0.6, 0.4]);
  });
  it('quantizes weights and finds mirrored vertices', () => {
    expect(quantize(0.3, 2)).toBe(0.5);
    expect(quantize(0.2, 2)).toBe(0);
    const map = mirrorVertexMap([1, 2, 3, -1, 2, 3, 0, 1, 1, 5, 5, 5]);
    expect(Array.from(map)).toEqual([1, 0, 2, -1]);
  });
});

describe('symmetrize and fairing', async () => {
  const { symmetrizeMesh, fairVertices } = await import('../../src/paint/symmetrize');
  it('mirrors one half of a mesh across the plane', () => {
    // an asymmetric grid: shift x so the plane cuts through faces
    const g = grid(4, 2, 2);
    const P = g.positions.slice();
    for (let v = 0; v < P.length / 3; v++) P[v * 3] += 0.3;
    P[0 * 3 + 2] = 0.5; // a bump on one side
    const r = symmetrizeMesh({ positions: P, offsets: g.offsets, indices: g.indices, uvs: g.uvs }, 0, 1);
    const nv = r.positions.length / 3;
    // every vertex has a mirror partner
    const key = (x: number, y: number, z: number) => `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    const set = new Set<string>();
    for (let v = 0; v < nv; v++) set.add(key(r.positions[v * 3], r.positions[v * 3 + 1], r.positions[v * 3 + 2]));
    for (let v = 0; v < nv; v++) expect(set.has(key(-r.positions[v * 3] + 0, r.positions[v * 3 + 1], r.positions[v * 3 + 2]).replace('-0.0000', '0.0000'))).toBe(true);
    // no vertex on the dropped (-X) side beyond the mirrored extent
    let minX = Infinity,
      maxX = -Infinity;
    for (let v = 0; v < nv; v++) (minX = Math.min(minX, r.positions[v * 3])), (maxX = Math.max(maxX, r.positions[v * 3]));
    expect(minX).toBeCloseTo(-maxX);
    expect(r.srcFace.length).toBe(r.offsets.length - 1);
  });
  it('fairs free vertices toward a smooth surface', () => {
    const g = grid(6, 6, 2);
    const P = g.positions.slice();
    const nb = vertexNeighbors(g);
    const free = new Uint8Array(49);
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) free[y * 7 + x] = 1;
    P[24 * 3 + 2] = 1; // spike in the middle
    fairVertices(P, nb.offsets, nb.neighbors, free, 'POSITION', 200);
    expect(Math.abs(P[24 * 3 + 2])).toBeLessThan(0.01);
    const Q = g.positions.slice();
    Q[24 * 3 + 2] = 1;
    fairVertices(Q, nb.offsets, nb.neighbors, free, 'TANGENCY', 400);
    expect(Math.abs(Q[24 * 3 + 2])).toBeLessThan(0.2);
  });
});
