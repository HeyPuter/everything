// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { modifierTypes } from '../../src/eval/modifiers';
import { decimateCollapse, decimateDissolve } from '../../src/eval/modifiers_extra';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

const mesh = (a: ReturnType<typeof prim.cube>) => newMeshData('m', a) as unknown as EvalMesh;
const faces = (m: EvalMesh) => m.offsets.length - 1;
const verts = (m: EvalMesh) => m.positions.length / 3;

function closed(m: EvalMesh) {
  const count = new Map<string, number>();
  for (let f = 0; f < faces(m); f++)
    for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
      const a = m.indices[c],
        b = m.indices[c + 1 < m.offsets[f + 1] ? c + 1 : m.offsets[f]];
      const k = a < b ? `${a}:${b}` : `${b}:${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  return [...count.values()].every((n) => n === 2);
}

const apply = (type: string, m: EvalMesh, props: Record<string, unknown> = {}, ctx?: Partial<ModifierContext>) => {
  const t = modifierTypes[type];
  return t.apply(m, { ...t.defaults(), type, name: type, ...props } as never, (ctx ?? {}) as ModifierContext);
};

describe('extra modifiers', () => {
  it('bevel: all cube edges at the default angle limit (expected counts: 26 faces / 24 verts)', () => {
    const out = apply('BEVEL', mesh(prim.cube(2)), { width: 0.2 });
    expect(faces(out)).toBe(26);
    expect(verts(out)).toBe(24);
    expect(closed(out)).toBe(true);
  });

  it('bevel: angle limit skips flat edges of a subdivided plane', () => {
    const grid = mesh(prim.grid(3, 3));
    const out = apply('BEVEL', grid, { width: 0.1 });
    expect(faces(out)).toBe(faces(grid));
  });

  it('decimate collapse halves the triangle count and keeps a closed surface', () => {
    const sphere = mesh(prim.uvSphere(32, 16, 1));
    const out = decimateCollapse(sphere, 0.5);
    const tris = (() => {
      let n = 0;
      for (let f = 0; f < faces(sphere); f++) n += sphere.offsets[f + 1] - sphere.offsets[f] - 2;
      return n;
    })();
    expect(faces(out)).toBeLessThanOrEqual(Math.ceil(tris * 0.5) + 2);
    expect(faces(out)).toBeGreaterThan(tris * 0.4);
    expect(closed(out)).toBe(true);
  });

  it('decimate planar dissolve merges a flat grid into one face', () => {
    const out = decimateDissolve(mesh(prim.grid(4, 4)), 0.1);
    expect(faces(out)).toBe(1);
    expect(verts(out)).toBe(4);
  });

  it('remesh produces a closed quad surface', () => {
    const out = apply('REMESH', mesh(prim.cube(2)), { voxel_size: 0.25 });
    expect(faces(out)).toBeGreaterThan(50);
    for (let f = 0; f < faces(out); f++) expect(out.offsets[f + 1] - out.offsets[f]).toBe(4);
    expect(closed(out)).toBe(true);
  });

  it('boolean difference cuts one cube with another', () => {
    const a = mesh(prim.cube(2));
    const b = mesh(prim.cube(2));
    const graph = new Map<string, { world: Matrix4; mesh?: EvalMesh }>([
      ['own', { world: new Matrix4() }],
      ['cutter', { world: new Matrix4().makeTranslation(1, 1, 1), mesh: b }],
    ]);
    const ctx = { ob: { id: 'own' }, doc: { collections: {} }, graph: { get: (id: string) => graph.get(id) } } as unknown as ModifierContext;
    const out = apply('BOOLEAN', a, { object: 'cutter', operation: 'DIFFERENCE' }, ctx);
    expect(faces(out)).toBeGreaterThan(6);
    // the corner at (1,1,1) is gone
    let maxSum = -Infinity;
    for (let i = 0; i < verts(out); i++) maxSum = Math.max(maxSum, out.positions[i * 3] + out.positions[i * 3 + 1] + out.positions[i * 3 + 2]);
    expect(maxSum).toBeLessThan(2.5);
  });

  it('weighted normal outputs unit custom normals per corner', () => {
    const out = apply('WEIGHTED_NORMAL', mesh(prim.cylinder(16, 1, 2)));
    expect(out.custom_normals?.length).toBe(out.indices.length * 3);
    const n = out.custom_normals!;
    for (let c = 0; c < out.indices.length; c++) expect(Math.hypot(n[c * 3], n[c * 3 + 1], n[c * 3 + 2])).toBeCloseTo(1, 4);
  });
});
