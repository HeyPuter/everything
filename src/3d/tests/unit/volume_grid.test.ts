import { describe, expect, it } from 'vitest';
import { GridSampler, downsampleGrid, gridBounds, gridToMesh, makeGrid, meshToFog, meshToSdf, pointsToFog, pointsToSdf, quadsToPolys, triangulate, voxelSize, voxelSizeForAmount, displaceGrid, invertAffine, mulMat4, fillGrid } from '../../src/volume/grid';
import { volumeWire } from '../../src/volume/wire';

// unit cube [-1, 1]³ as quads
const CUBE_P = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);
const CUBE_F = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
];
const offsets = Uint32Array.from([0, 4, 8, 12, 16, 20, 24]);
const indices = Uint32Array.from(CUBE_F.flat());

describe('volume grids', () => {
  it('maps voxel centres through the transform and computes bounds', () => {
    const g = makeGrid('density', [4, 2, 2], 0.5, [1, 2, 3]);
    const b = gridBounds(g);
    expect(b.min).toEqual([0.75, 1.75, 2.75]);
    expect(b.max).toEqual([2.75, 2.75, 3.75]);
    expect(voxelSize(g)).toEqual([0.5, 0.5, 0.5]);
  });

  it('inverts affine matrices', () => {
    const m = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 1, 2, 3, 1];
    const p = mulMat4(m, invertAffine(m));
    p.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1][i], 9));
  });

  it('samples trilinearly, nearest and cubic', () => {
    const g = makeGrid('f', [2, 1, 1], 1, [0, 0, 0]);
    g.values.set([0, 10]);
    expect(new GridSampler(g).sample(0.25, 0, 0)).toBeCloseTo(2.5);
    expect(new GridSampler(g, 'CLOSEST').sample(0.6, 0, 0)).toBe(10);
    expect(new GridSampler(g).sample(5, 0, 0)).toBe(0);
    const ramp = fillGrid(makeGrid('r', [6, 1, 1], 1, [0, 0, 0]), (x) => x);
    // Catmull-Rom reproduces linear ramps between interior voxels
    expect(new GridSampler(ramp, 'CUBIC').sample(2.5, 0, 0)).toBeCloseTo(2.5);
  });

  it('builds a signed distance field of a closed mesh', () => {
    const tris = triangulate(offsets, indices);
    expect(tris.length).toBe(36);
    const sdf = meshToSdf(CUBE_P, tris, { voxelSize: 0.1, bandWidth: 0.3 })!;
    const s = new GridSampler(sdf);
    expect(s.sample(0, 0, 0)).toBeCloseTo(-0.3, 5); // deep inside: clamped to the band
    expect(s.sample(0.9, 0, 0)).toBeCloseTo(-0.1, 2);
    expect(s.sample(1.1, 0, 0)).toBeCloseTo(0.1, 2);
    expect(s.sample(1.5, 0, 0)).toBeCloseTo(0.3, 5);
    expect(sdf.grid_class).toBe('LEVEL_SET');
  });

  it('fills a mesh with density (Mesh to Volume)', () => {
    const tris = triangulate(offsets, indices);
    const vs = voxelSizeForAmount([-1, -1, -1], [1, 1, 1], 32);
    expect(vs).toBeCloseTo((2 * Math.sqrt(3)) / 32);
    const fog = meshToFog(CUBE_P, tris, vs, 0.2, 2)!;
    const s = new GridSampler(fog);
    expect(s.sample(0, 0, 0)).toBeCloseTo(2);
    expect(s.sample(0.9, 0.1, 0)).toBeGreaterThan(0.5);
    expect(s.sample(0.9, 0.1, 0)).toBeLessThan(2);
    expect(s.sample(1.3, 0, 0)).toBe(0);
    const b = gridBounds(fog);
    expect(b.min[0]).toBeLessThan(-1);
    expect(b.max[0]).toBeGreaterThan(1);
  });

  it('extracts a closed, outward facing surface (Volume to Mesh)', () => {
    const tris = triangulate(offsets, indices);
    const fog = meshToFog(CUBE_P, tris, 0.1, 0.2, 1)!;
    const m = gridToMesh(fog, 0.5);
    expect(m.quads.length / 4).toBeGreaterThan(100);
    // every edge is shared by exactly two faces in opposite directions (closed, consistently wound)
    const edges = new Map<string, number>();
    for (let q = 0; q < m.quads.length; q += 4)
      for (let k = 0; k < 4; k++) {
        const a = m.quads[q + k],
          b = m.quads[q + ((k + 1) % 4)];
        edges.set(`${a},${b}`, (edges.get(`${a},${b}`) ?? 0) + 1);
      }
    for (const [k, n] of edges) {
      const [a, b] = k.split(',');
      expect(n).toBe(1);
      expect(edges.get(`${b},${a}`)).toBe(1);
    }
    // vertices lie near the cube surface
    let maxErr = 0;
    for (let v = 0; v < m.positions.length; v += 3) {
      const d = Math.max(Math.abs(m.positions[v]), Math.abs(m.positions[v + 1]), Math.abs(m.positions[v + 2]));
      maxErr = Math.max(maxErr, Math.abs(d - 0.9));
    }
    expect(maxErr).toBeLessThan(0.12);
    // normals point outwards: signed volume is positive
    const { offsets: o, indices: ix } = quadsToPolys(m.quads);
    let vol = 0;
    const t = triangulate(o, ix);
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
      const P = m.positions;
      vol += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    }
    expect(vol).toBeGreaterThan(4);
    expect(vol).toBeLessThan(8.5);
  });

  it('reduces polygons with adaptivity', () => {
    const fog = meshToFog(CUBE_P, triangulate(offsets, indices), 0.1, 0.2, 1)!;
    const a = gridToMesh(fog, 0.5, false, 0);
    const b = gridToMesh(fog, 0.5, false, 1);
    expect(b.quads.length).toBeLessThan(a.quads.length * 0.6);
  });

  it('splats points into fog and distance grids', () => {
    const fog = pointsToFog([0, 0, 0, 2, 0, 0], [0.5, 0.25], 3, { voxelSize: 0.05 })!;
    const s = new GridSampler(fog);
    expect(s.sample(0, 0, 0)).toBeCloseTo(3);
    expect(s.sample(2, 0, 0)).toBeCloseTo(3);
    expect(s.sample(1, 0, 0)).toBe(0);
    const sdf = pointsToSdf([0, 0, 0], 0.5, { voxelSize: 0.05 })!;
    expect(new GridSampler(sdf).sample(0.6, 0, 0)).toBeCloseTo(0.1, 2);
  });

  it('downsamples while keeping the covered region', () => {
    const g = fillGrid(makeGrid('f', [8, 8, 8], 0.25, [0, 0, 0]), () => 1);
    const d = downsampleGrid(g, 2);
    expect(d.dims).toEqual([4, 4, 4]);
    const a = gridBounds(g),
      b = gridBounds(d);
    for (let k = 0; k < 3; k++) {
      expect(b.min[k]).toBeCloseTo(a.min[k]);
      expect(b.max[k]).toBeCloseTo(a.max[k]);
    }
    expect(d.values[0]).toBe(1);
  });

  it('displaces density by a texture', () => {
    const g = pointsToFog([0, 0, 0], 0.5, 1, { voxelSize: 0.1 })!;
    // a constant texture value of 1 (mid 0.5) shifts everything by +strength·0.5
    const d = displaceGrid(g, () => [1, 0.5, 0.5], 1, [0.5, 0.5, 0.5]);
    const s = new GridSampler(d);
    expect(s.sample(0.5, 0, 0)).toBeCloseTo(1);
    expect(s.sample(-0.5, 0, 0)).toBeCloseTo(0, 1);
  });

  it('draws bounds, boxes and points wireframes', () => {
    const g = pointsToFog([0, 0, 0], 0.5, 1, { voxelSize: 0.05 })!;
    const bounds = volumeWire([g], { wireframe_type: 'BOUNDS', wireframe_detail: 'COARSE' });
    expect(bounds.positions.length).toBe(24);
    expect(bounds.edges.length).toBe(24);
    const fine = volumeWire([g], { wireframe_type: 'BOXES', wireframe_detail: 'FINE' });
    const coarse = volumeWire([g], { wireframe_type: 'BOXES', wireframe_detail: 'COARSE' });
    expect(fine.edges.length).toBeGreaterThan(coarse.edges.length);
    const pts = volumeWire([g], { wireframe_type: 'POINTS', wireframe_detail: 'FINE' });
    expect(pts.edges.length).toBe(0);
    expect(pts.points).toBe(true);
    expect(volumeWire([g], { wireframe_type: 'NONE', wireframe_detail: 'FINE' }).positions.length).toBe(0);
  });
});
