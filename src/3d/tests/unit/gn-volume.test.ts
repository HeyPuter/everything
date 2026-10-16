// @vitest-environment happy-dom
// Volume geometry nodes: primitives, conversions between meshes, points and grids, named grids,
// sampling and grid operations.
import { describe, it, expect } from 'vitest';
import { setup, node, link, run, counts, attr } from './gnmesh-harness';
import '../../src/volume/geonodes';
import { GridSampler } from '../../src/volume/grid';

describe('volume nodes', () => {
  it('Volume Cube evaluates its density field per voxel and meshes back', () => {
    const t = setup();
    const pos = node(t, 'GeometryNodeInputPosition');
    const len = node(t, 'ShaderNodeVectorMath', {}, { operation: 'LENGTH' });
    link(t, pos, 'Position', len, 'Vector');
    const sub = node(t, 'ShaderNodeMath', { Value: 1 }, { operation: 'SUBTRACT' });
    link(t, len, 'Value', sub, 'Value_001');
    const cube = node(t, 'GeometryNodeVolumeCube', { 'Resolution X': 20, 'Resolution Y': 20, 'Resolution Z': 20, Min: [-1.5, -1.5, -1.5], Max: [1.5, 1.5, 1.5] });
    link(t, sub, 'Value', cube, 'Density');
    const r = run(t, cube, 'Volume');
    const g = r.geometry.volume!.grids[0];
    expect(g.dims).toEqual([20, 20, 20]);
    const s = new GridSampler(g);
    expect(s.sample(0, 0, 0)).toBeCloseTo(1 - Math.hypot(0.075, 0.075, 0.075) * 0, 0);
    const t2 = setup();
    const c2 = node(t2, 'GeometryNodeVolumeCube', { Density: 1, 'Resolution X': 8, 'Resolution Y': 8, 'Resolution Z': 8 });
    const v2m = node(t2, 'GeometryNodeVolumeToMesh', { Threshold: 0.5 });
    link(t2, c2, 'Volume', v2m, 'Volume');
    const [nv, , nf] = counts(run(t2, v2m, 'Mesh').geometry);
    expect(nf).toBeGreaterThan(20);
    expect(nv).toBeGreaterThan(20);
  });

  it('Mesh to Volume fills a cube; Distribute Points in Volume scatters inside it', () => {
    const t = setup();
    const cube = node(t, 'GeometryNodeMeshCube', { Size: [2, 2, 2] });
    const m2v = node(t, 'GeometryNodeMeshToVolume', { 'Voxel Size': 0.1, 'Interior Band Width': 0.1 }, { 'Resolution Mode': 'Size' });
    link(t, cube, 'Mesh', m2v, 'Mesh');
    const dist = node(t, 'GeometryNodeDistributePointsInVolume', { Density: 50, Threshold: 0.5 });
    link(t, m2v, 'Volume', dist, 'Volume');
    const r = run(t, dist, 'Points');
    const p = r.geometry.points!;
    // ~ 50 points per unit volume over the inner (2 − 2·0.05)³ region
    expect(p.count).toBeGreaterThan(250);
    expect(p.count).toBeLessThan(450);
    for (let i = 0; i < p.positions.length; i++) expect(Math.abs(p.positions[i])).toBeLessThan(1.05);
  });

  it('stores, reads and samples named grids', () => {
    const t = setup();
    const pts = node(t, 'GeometryNodePoints', { Count: 1 });
    const p2v = node(t, 'GeometryNodePointsToVolume', { Radius: 0.5, 'Voxel Size': 0.05, Density: 2 }, { 'Resolution Mode': 'Size' });
    link(t, pts, 'Points', p2v, 'Points');
    const get = node(t, 'GeometryNodeGetNamedGrid', { Name: 'density', Remove: false });
    link(t, p2v, 'Volume', get, 'Volume');
    const store = node(t, 'GeometryNodeStoreNamedGrid', { Name: 'copy' });
    link(t, get, 'Volume', store, 'Volume');
    link(t, get, 'Grid', store, 'Grid');
    const r = run(t, store, 'Volume');
    expect(r.geometry.volume!.grids.map((g) => g.name)).toEqual(['density', 'copy']);
    // sample the grid at the points of a line
    const t2 = setup();
    const p2 = node(t2, 'GeometryNodePoints', { Count: 1 });
    const pv = node(t2, 'GeometryNodePointsToVolume', { Radius: 0.5, 'Voxel Size': 0.05, Density: 2 }, { 'Resolution Mode': 'Size' });
    link(t2, p2, 'Points', pv, 'Points');
    const g2 = node(t2, 'GeometryNodeGetNamedGrid', { Name: 'density' });
    link(t2, pv, 'Volume', g2, 'Volume');
    const line = node(t2, 'GeometryNodeMeshLine', { Count: 3, 'Start Location': [0, 0, 0], Offset: [0.6, 0, 0] });
    const sg = node(t2, 'GeometryNodeSampleGrid');
    link(t2, g2, 'Grid', sg, 'Grid');
    const st = node(t2, 'GeometryNodeStoreNamedAttribute', { Name: 'd' }, { data_type: 'FLOAT', domain: 'POINT' });
    link(t2, line, 'Mesh', st, 'Geometry');
    link(t2, sg, 'Value', st, 'Value');
    const vals = attr(run(t2, st, 'Geometry').geometry, 'd');
    expect(vals[0]).toBeCloseTo(2);
    expect(vals[1]).toBe(0);
  });

  it('combines distance grids and meshes them', () => {
    const t = setup();
    const a = node(t, 'GeometryNodeMeshCube', { Size: [2, 2, 2] });
    const b = node(t, 'GeometryNodeMeshCube', { Size: [2, 2, 2] });
    const tr = node(t, 'GeometryNodeTransform', { Translation: [1, 0, 0] });
    link(t, b, 'Mesh', tr, 'Geometry');
    const sa = node(t, 'GeometryNodeMeshToSDFGrid', { 'Voxel Size': 0.1 });
    const sb = node(t, 'GeometryNodeMeshToSDFGrid', { 'Voxel Size': 0.1 });
    link(t, a, 'Mesh', sa, 'Mesh');
    link(t, tr, 'Geometry', sb, 'Mesh');
    const un = node(t, 'GeometryNodeSDFGridBoolean', {}, { operation: 'UNION' });
    link(t, sa, 'SDF Grid', un, 'Grid 2');
    link(t, sb, 'SDF Grid', un, 'Grid 2');
    const g2m = node(t, 'GeometryNodeGridToMesh');
    link(t, un, 'Grid', g2m, 'Grid');
    const m = run(t, g2m, 'Mesh').geometry.mesh!;
    let minX = Infinity,
      maxX = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) {
      minX = Math.min(minX, m.positions[i]);
      maxX = Math.max(maxX, m.positions[i]);
    }
    expect(minX).toBeCloseTo(-1, 1);
    expect(maxX).toBeCloseTo(2, 1);
  });

  it('separates the volume component', () => {
    const t = setup();
    const c = node(t, 'GeometryNodeVolumeCube', { 'Resolution X': 4, 'Resolution Y': 4, 'Resolution Z': 4 });
    const sep = node(t, 'GeometryNodeSeparateComponents');
    link(t, c, 'Volume', sep, 'Geometry');
    expect(run(t, sep, 'Volume').geometry.volume?.grids.length).toBe(1);
  });
});
