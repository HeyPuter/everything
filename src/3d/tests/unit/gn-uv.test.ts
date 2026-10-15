// @vitest-environment happy-dom
// UV Unwrap and Pack UV Islands nodes.
import { describe, it, expect } from 'vitest';
import { setup, node, link, run, attr, type T } from './gnmesh-harness';
import type { NodeData } from '../../src/data/types';
import { uvIslands } from '../../src/geonodes/ops/uvnodes';
import type { GeometrySet } from '../../src/geonodes/geometry';

function storeUV(t: T, geo: [NodeData, string], uv: [NodeData, string]) {
  const st = node(t, 'GeometryNodeStoreNamedAttribute', { Name: 'uv' }, { data_type: 'FLOAT_VECTOR', domain: 'CORNER' });
  link(t, geo[0], geo[1], st, 'Geometry');
  link(t, uv[0], uv[1], st, 'Value');
  return st;
}

function check(g: GeometrySet) {
  const uv = attr(g, 'uv', 'CORNER', 'VECTOR');
  for (const x of uv) {
    expect(Number.isFinite(x)).toBe(true);
    expect(x).toBeGreaterThanOrEqual(-1e-5);
    expect(x).toBeLessThanOrEqual(1 + 1e-5);
  }
  const islands = uvIslands(g.mesh!, uv, 3, null);
  // island bounding boxes do not overlap
  const boxes = islands.map((cs) => {
    const xs = cs.map((c) => uv[c * 3]),
      ys = cs.map((c) => uv[c * 3 + 1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i], boxes[j]];
      const overlap = a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6;
      expect(overlap).toBe(false);
    }
  return islands.length;
}

describe('UV Unwrap', () => {
  it('a grid unwraps into one island', () => {
    const t = setup();
    const g = node(t, 'GeometryNodeMeshGrid', { 'Vertices X': 4, 'Vertices Y': 4 });
    const u = node(t, 'GeometryNodeUVUnwrap', { 'No Flip': true });
    const r = run(t, storeUV(t, [g, 'Mesh'], [u, 'UV']), 'Geometry');
    expect(check(r.geometry)).toBe(1);
  });
  it('a cube with every edge as seam gives six islands; without seams it is split by angle', () => {
    const t = setup();
    const c = node(t, 'GeometryNodeMeshCube', { Size: [2, 2, 2] });
    const u = node(t, 'GeometryNodeUVUnwrap', { Seam: true });
    expect(check(run(t, storeUV(t, [c, 'Mesh'], [u, 'UV']), 'Geometry').geometry)).toBe(6);
    const t2 = setup();
    const c2 = node(t2, 'GeometryNodeMeshCube', { Size: [2, 2, 2] });
    const u2 = node(t2, 'GeometryNodeUVUnwrap');
    expect(check(run(t2, storeUV(t2, [c2, 'Mesh'], [u2, 'UV']), 'Geometry').geometry)).toBe(6);
  });
  it('fills holes of a chart', () => {
    const t = setup();
    const g = node(t, 'GeometryNodeMeshGrid', { 'Vertices X': 4, 'Vertices Y': 4 });
    const del = node(t, 'GeometryNodeDeleteGeometry', {}, { domain: 'FACE' });
    const i = node(t, 'GeometryNodeInputIndex');
    const cmp = node(t, 'FunctionNodeCompare', { B: 4 }, { data_type: 'INT', operation: 'EQUAL' });
    link(t, i, 'Index', cmp, 'A');
    link(t, cmp, 'Result', del, 'Selection');
    link(t, g, 'Mesh', del, 'Geometry');
    const u = node(t, 'GeometryNodeUVUnwrap', { 'Fill Holes': true });
    expect(check(run(t, storeUV(t, [del, 'Geometry'], [u, 'UV']), 'Geometry').geometry)).toBe(1);
  });
});

describe('Pack UV Islands', () => {
  it('spreads overlapping islands inside the target region', () => {
    const t = setup();
    const c = node(t, 'GeometryNodeMeshCube', { Size: [1, 1, 1] });
    const split = node(t, 'GeometryNodeSplitEdges');
    link(t, c, 'Mesh', split, 'Mesh');
    // every face gets the same unit square UVs (all islands on top of each other)
    const u = node(t, 'GeometryNodeUVUnwrap', { Seam: true });
    const p = node(t, 'GeometryNodeUVPackIslands', { Margin: 0.02 });
    link(t, u, 'UV', p, 'UV');
    const r = run(t, storeUV(t, [split, 'Mesh'], [p, 'UV']), 'Geometry');
    expect(check(r.geometry)).toBe(6);
  });
});
