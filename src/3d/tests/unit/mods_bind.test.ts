// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { laplacianDeform, meanValueCoords, bindMeshDeform, bindSurface, applySurfaceBind } from '../../src/eval/mods/bind';
import { triangles } from '../../src/eval/mods/spatial';
import { modifierTypes } from '../../src/eval/modifiers';
import '../../src/eval/mods/index';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

const mesh = (a: ReturnType<typeof prim.cube>) => newMeshData('m', a) as unknown as EvalMesh;
const xform = (P: Float32Array, m: Matrix4) => {
  const out = new Float32Array(P.length);
  const v = new Vector3();
  for (let i = 0; i < P.length; i += 3) {
    v.fromArray(P, i).applyMatrix4(m);
    out.set([v.x, v.y, v.z], i);
  }
  return out;
};
const maxErr = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let e = 0;
  for (let i = 0; i < a.length; i++) e = Math.max(e, Math.abs(a[i] - b[i]));
  return e;
};

describe('Laplacian Deform', () => {
  const grid = () => mesh(prim.grid(10, 10, 2));
  const edgeAnchors = (m: EvalMesh) => Uint8Array.from({ length: m.positions.length / 3 }, (_, v) => (Math.abs(Math.abs(m.positions[v * 3]) - 1) < 1e-6 ? 1 : 0));

  it('keeps the rest shape when the anchors do not move', () => {
    const m = grid();
    const out = laplacianDeform(m, m.positions, edgeAnchors(m), 1);
    expect(maxErr(out, m.positions)).toBeLessThan(1e-5);
  });

  it('moves the anchors exactly and bends the rest smoothly between them', () => {
    const m = grid();
    const anchors = edgeAnchors(m);
    const input = Float32Array.from(m.positions);
    for (let v = 0; v < anchors.length; v++) if (anchors[v] && input[v * 3] > 0) input[v * 3 + 2] += 1;
    const out = laplacianDeform({ ...m, positions: input }, m.positions, anchors, 2);
    for (let v = 0; v < anchors.length; v++) if (anchors[v]) expect(out[v * 3 + 2]).toBeCloseTo(input[v * 3 + 2], 5);
    // heights increase from the left to the right side along a row
    const row = Array.from({ length: 11 }, (_, i) => out[(5 * 11 + i) * 3 + 2]);
    for (let i = 1; i < 11; i++) expect(row[i]).toBeGreaterThan(row[i - 1] - 1e-6);
    expect(row[5]).toBeGreaterThan(0.2);
    expect(row[5]).toBeLessThan(0.8);
  });

  it('translates with all anchors', () => {
    const m = grid();
    const anchors = edgeAnchors(m);
    const input = Float32Array.from(m.positions);
    for (let v = 0; v < anchors.length; v++) if (anchors[v]) input[v * 3 + 1] += 0.5;
    const out = laplacianDeform({ ...m, positions: input }, m.positions, anchors, 1);
    expect(maxErr(out, xform(m.positions, new Matrix4().makeTranslation(0, 0.5, 0)))).toBeLessThan(1e-4);
  });

  it('does nothing until bound and needs an anchor group', () => {
    const t = modifierTypes.LAPLACIANDEFORM;
    const m = grid();
    expect(t.apply(m, { ...t.defaults(), vertex_group: 'A' } as never, {} as ModifierContext)).toBe(m);
    expect(() => t.apply(m, { ...t.defaults(), vertex_group: 'A', _bind_rest: m.positions } as never, {} as ModifierContext)).toThrow(/Anchor/);
  });
});

describe('Mesh Deform (mean value coordinates)', () => {
  const cage = mesh(prim.cube(3));
  const { tris } = triangles(cage);
  it('reproduces points inside the cage and sums to one', () => {
    const w = new Float64Array(8);
    const p = new Vector3(0.3, -0.2, 0.5);
    expect(meanValueCoords(p, cage.positions, tris, w)).toBe(true);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const r = new Vector3();
    for (let j = 0; j < 8; j++) r.addScaledVector(new Vector3().fromArray(cage.positions, j * 3), w[j]);
    expect(r.distanceTo(p)).toBeLessThan(1e-9);
  });

  it('follows affine changes of the cage exactly', () => {
    const sphere = mesh(prim.uvSphere(12, 6, 1));
    const b = bindMeshDeform(sphere.positions, cage.positions, tris);
    const t = modifierTypes.MESH_DEFORM;
    const mat = new Matrix4().makeRotationZ(0.4).scale(new Vector3(1.5, 0.8, 1.2)).setPosition(0.3, 0, -1);
    const moved = { ...cage, positions: xform(cage.positions, mat) };
    const ctx = { ob: { id: 'ob' }, graph: { get: (id: string) => (id === 'ob' ? { world: new Matrix4() } : { world: new Matrix4(), mesh: moved }) } } as unknown as ModifierContext;
    const mod = { ...t.defaults(), object: 'cage', _bind_cage: b.cage, _bind_index: b.index, _bind_weight: b.weight, _bind_rest: b.rest, _bind_k: b.k } as never;
    const out = t.apply(sphere, mod, ctx);
    expect(maxErr(out.positions, xform(sphere.positions, mat))).toBeLessThan(1e-4);
  });
});

describe('Surface Deform', () => {
  it('carries bound vertices along with a moving target', () => {
    const target = mesh(prim.grid(4, 4, 2));
    const m = mesh(prim.grid(6, 6, 1.6));
    const P = Float32Array.from(m.positions);
    for (let i = 2; i < P.length; i += 3) P[i] = 0.3 + 0.1 * Math.sin(i);
    const b = bindSurface(P, target, target.positions, 4, null);
    expect(maxErr(applySurfaceBind(P, b, target.positions, 1, null), P)).toBeLessThan(1e-5);
    const mat = new Matrix4().makeRotationX(0.7).setPosition(0, 1, 2);
    expect(maxErr(applySurfaceBind(P, b, xform(target.positions, mat), 1, null), xform(P, mat))).toBeLessThan(1e-4);
    // half strength lands half way
    const half = applySurfaceBind(P, b, xform(target.positions, new Matrix4().makeTranslation(0, 0, 1)), 0.5, null);
    expect(half[2] - P[2]).toBeCloseTo(0.5, 4);
  });
});
