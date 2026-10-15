// @vitest-environment happy-dom
// Sampling nodes (results recorded from the reference behaviour of these nodes).
import { describe, it, expect } from 'vitest';
import { setup, node, link, run, attr, type T } from './gnmesh-harness';
import type { NodeData } from '../../src/data/types';

/** Chain Store Named Attribute nodes for several outputs onto a geometry; returns the last. */
function storeAll(t: T, geo: [NodeData, string], values: [NodeData, string, string, string][]): NodeData {
  let cur = geo;
  for (const [n, sock, name, type] of values) {
    const st = node(t, 'GeometryNodeStoreNamedAttribute', { Name: name }, { data_type: type, domain: 'POINT' });
    link(t, cur[0], cur[1], st, 'Geometry');
    link(t, n, sock, st, 'Value');
    cur = [st, 'Geometry'];
  }
  return cur[0];
}
const round = (a: number[]) => a.map((x) => Math.round(x * 1e4) / 1e4 || 0);
const vec = (a: number[]) => {
  const out: number[][] = [];
  for (let i = 0; i < a.length; i += 3) out.push(round(a.slice(i, i + 3)));
  return out;
};

describe('Geometry Proximity and Sample Nearest', () => {
  for (const [mode, pos, dist, faceIdx] of [
    [
      'POINTS',
      [
        [0, 0, 0],
        [0.5, 0, 0],
        [0.5, 0, 0],
        [0.5, 0, 0],
      ],
      [1.0247, 0.4583, 0.7348, 1.4457],
      [4, 7, 7, 7],
    ],
    [
      'EDGES',
      [
        [0.2, 0, 0],
        [0.5, 0.1, 0],
        [0.5, 0.1, 0],
        [0.5, 0.1, 0],
      ],
      [1.005, 0.4472, 0.728, 1.4422],
      null,
    ],
    [
      'FACES',
      [
        [0.2, 0.1, 0],
        [0.5, 0.1, 0],
        [0.5, 0.1, 0],
        [0.5, 0.1, 0],
      ],
      [1.0, 0.4472, 0.728, 1.4422],
      [3, 3, 3, 3],
    ],
  ] as const) {
    it(mode, () => {
      const t = setup();
      const line = node(t, 'GeometryNodeMeshLine', { Count: 4, 'Start Location': [0.2, 0.1, 1], Offset: [0.5, 0, -0.6] });
      const grid = node(t, 'GeometryNodeMeshGrid', { 'Vertices X': 3, 'Vertices Y': 3 });
      const p = node(t, 'GeometryNodeProximity', {}, { target_element: mode });
      link(t, grid, 'Mesh', p, 'Target');
      const sn = node(t, 'GeometryNodeSampleNearest', {}, { domain: mode.slice(0, -1) });
      link(t, grid, 'Mesh', sn, 'Geometry');
      const last = storeAll(
        t,
        [line, 'Mesh'],
        [
          [p, 'Position', 'pp', 'FLOAT_VECTOR'],
          [p, 'Distance', 'dd', 'FLOAT'],
          [p, 'Is Valid', 'ok', 'BOOLEAN'],
          [sn, 'Index', 'ni', 'INT'],
        ],
      );
      const g = run(t, last, 'Geometry').geometry;
      expect(vec(attr(g, 'pp', 'POINT', 'VECTOR'))).toEqual(pos);
      expect(round(attr(g, 'dd'))).toEqual(dist);
      expect(attr(g, 'ok', 'POINT', 'BOOLEAN')).toEqual([1, 1, 1, 1]);
      if (faceIdx) expect(attr(g, 'ni', 'POINT', 'INT')).toEqual(faceIdx);
    });
  }
});

describe('Raycast', () => {
  it('hits a smooth ico sphere with face normals and corner-interpolated attributes', () => {
    const t = setup();
    const line = node(t, 'GeometryNodeMeshLine', { Count: 3, 'Start Location': [0.3, 0.2, 5], Offset: [0.5, 0, 0] });
    const ico = node(t, 'GeometryNodeMeshIcoSphere', { Radius: 1, Subdivisions: 1 });
    const ss = node(t, 'GeometryNodeSetShadeSmooth', { 'Shade Smooth': true });
    link(t, ico, 'Mesh', ss, 'Geometry');
    const r = node(t, 'GeometryNodeRaycast', {}, { data_type: 'FLOAT' });
    link(t, ss, 'Geometry', r, 'Target Geometry');
    link(t, node(t, 'GeometryNodeInputIndex'), 'Index', r, 'Attribute');
    const last = storeAll(
      t,
      [line, 'Mesh'],
      [
        [r, 'Is Hit', 'hit', 'BOOLEAN'],
        [r, 'Hit Position', 'hp', 'FLOAT_VECTOR'],
        [r, 'Hit Normal', 'hn', 'FLOAT_VECTOR'],
        [r, 'Hit Distance', 'hd', 'FLOAT'],
        [r, 'Attribute', 'ha', 'FLOAT'],
      ],
    );
    const g = run(t, last, 'Geometry').geometry;
    expect(attr(g, 'hit', 'POINT', 'BOOLEAN')).toEqual([1, 1, 0]);
    expect(vec(attr(g, 'hp', 'POINT', 'VECTOR'))).toEqual([
      [0.3, 0.2, 0.7248],
      [0.8, 0.2, 0.2317],
      [0, 0, 0],
    ]);
    const hn = attr(g, 'hn', 'POINT', 'VECTOR');
    [0.4911, 0.3568, 0.7947, 0.7946, 0.5774, 0.1876, 0, 0, 0].forEach((x, i) => expect(hn[i]).toBeCloseTo(x, 3));
    expect(round(attr(g, 'hd'))).toEqual([4.2752, 4.7683, 100]);
    expect(round(attr(g, 'ha')).map((x) => Math.round(x * 100) / 100)).toEqual([58.24, 43.43, 0]);
  });
});

describe('Index of Nearest, Sample UV Surface, Sample Nearest Surface', () => {
  it('index of nearest within groups', () => {
    const t = setup();
    const grid = node(t, 'GeometryNodeMeshGrid', { 'Vertices X': 3, 'Vertices Y': 3, 'Size X': 2, 'Size Y': 1 });
    const mod = node(t, 'ShaderNodeMath', { Value_001: 4 }, { operation: 'FLOORED_MODULO' });
    link(t, node(t, 'GeometryNodeInputIndex'), 'Index', mod, 'Value');
    const n = node(t, 'GeometryNodeIndexOfNearest');
    link(t, mod, 'Value', n, 'Group ID');
    const last = storeAll(
      t,
      [grid, 'Mesh'],
      [
        [n, 'Index', 'idx', 'INT'],
        [n, 'Has Neighbor', 'has', 'BOOLEAN'],
      ],
    );
    const g = run(t, last, 'Geometry').geometry;
    expect(attr(g, 'idx', 'POINT', 'INT')).toEqual([4, 5, 6, 7, 0, 1, 2, 3, 4]);
    expect(attr(g, 'has', 'POINT', 'BOOLEAN')).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });
  it('uv surface and nearest surface', () => {
    const t = setup();
    const line = node(t, 'GeometryNodeMeshLine', { Count: 3, 'Start Location': [0.25, 0.25, 0], Offset: [0.6, -0.1, 0] });
    const grid = node(t, 'GeometryNodeMeshGrid', { 'Vertices X': 3, 'Vertices Y': 3 });
    const s = node(t, 'GeometryNodeSampleUVSurface', {}, { data_type: 'FLOAT_VECTOR' });
    link(t, grid, 'Mesh', s, 'Mesh');
    link(t, node(t, 'GeometryNodeInputPosition'), 'Position', s, 'Value');
    link(t, grid, 'UV Map', s, 'Source UV Map');
    link(t, node(t, 'GeometryNodeInputPosition'), 'Position', s, 'Sample UV');
    const sns = node(t, 'GeometryNodeSampleNearestSurface', {}, { data_type: 'FLOAT' });
    link(t, grid, 'Mesh', sns, 'Mesh');
    link(t, node(t, 'GeometryNodeInputIndex'), 'Index', sns, 'Value');
    const last = storeAll(
      t,
      [line, 'Mesh'],
      [
        [s, 'Value', 'v', 'FLOAT_VECTOR'],
        [s, 'Is Valid', 'ok', 'BOOLEAN'],
        [sns, 'Value', 'ns', 'FLOAT'],
      ],
    );
    const g = run(t, last, 'Geometry').geometry;
    expect(vec(attr(g, 'v', 'POINT', 'VECTOR'))).toEqual([
      [-0.25, -0.25, 0],
      [0.35, -0.35, 0],
      [0, 0, 0],
    ]);
    expect(attr(g, 'ok', 'POINT', 'BOOLEAN')).toEqual([1, 1, 0]);
    expect(round(attr(g, 'ns'))).toEqual([13, 13.3, 13.1]);
  });
});
