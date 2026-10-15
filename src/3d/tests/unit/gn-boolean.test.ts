// @vitest-environment happy-dom
// Mesh Boolean: face, edge and vertex counts of the rebuilt polygons (expected values).
import { describe, it, expect } from 'vitest';
import { setup, node, link, run, counts } from './gnmesh-harness';

function boolean(op: string, solver = 'FLOAT', both = true) {
  const t = setup();
  const a = node(t, 'GeometryNodeMeshCube', { Size: [2, 2, 2] });
  const b = node(t, 'GeometryNodeMeshCube', { Size: [1, 1, 1] });
  const tr = node(t, 'GeometryNodeTransform', { Translation: [1, 1, 1] });
  link(t, b, 'Mesh', tr, 'Geometry');
  const bo = node(t, 'GeometryNodeMeshBoolean', {}, { operation: op, solver });
  if (op === 'DIFFERENCE') link(t, a, 'Mesh', bo, 'Mesh 1');
  else if (both) link(t, a, 'Mesh', bo, 'Mesh 2');
  link(t, tr, 'Geometry', bo, 'Mesh 2');
  return run(t, bo, 'Mesh');
}

describe('Mesh Boolean', () => {
  it('difference of overlapping cubes', () => {
    expect(counts(boolean('DIFFERENCE').geometry)).toEqual([14, 21, 9]);
  });
  it('union and intersection', () => {
    expect(counts(boolean('UNION').geometry)).toEqual([20, 30, 12]);
    expect(counts(boolean('INTERSECT').geometry)).toEqual([8, 12, 6]);
  });
  it('union of a single mesh keeps it', () => {
    expect(counts(boolean('UNION', 'EXACT', false).geometry)).toEqual([8, 12, 6]);
  });
});
