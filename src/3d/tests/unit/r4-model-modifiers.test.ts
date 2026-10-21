// @vitest-environment happy-dom
// Modifier options added in round 4, against recorded reference results: Cast with a control object
// with and without Use Transform.
import { describe, it, expect } from 'vitest';
import { Matrix4, Euler, Vector3, Quaternion } from 'three';
import fx from '../fixtures/r4_cast_transform.json';
import { modifierTypes } from '../../src/eval/modifiers';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const F = fx as Any;

describe('Cast: control object transform', () => {
  const empty = new Matrix4().compose(new Vector3(0.5, 0, 0), new Quaternion().setFromEuler(new Euler(0, 0, 0.5)), new Vector3(2, 1, 1));
  const run = (useTransform: boolean) => {
    const t = modifierTypes.CAST;
    const graph = { get: (id: string) => (id === 'ob' ? { world: new Matrix4(), ob: { id: 'ob' } } : { world: empty, ob: { id: 'e' } }) };
    const m = { positions: Float32Array.from(F.verts.flat()), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) } as EvalMesh;
    return t.apply(m, { ...t.defaults(), object: 'e', factor: 1, use_transform: useTransform } as never, { ob: { id: 'ob' }, doc: { objects: {} }, graph } as unknown as ModifierContext).positions;
  };
  it.each([false, true])('use_transform %s', (ut) => {
    const r = run(ut);
    (F[ut ? 'True' : 'False'] as number[][]).forEach((p, i) => expect(Math.hypot(r[i * 3] - p[0], r[i * 3 + 1] - p[1], r[i * 3 + 2] - p[2]), `vertex ${i}`).toBeLessThan(1e-3));
  });
});

import { buildMesh } from '../../src/mesh/mesh';
import '../../src/eval/modifiers_extra';

describe('Triangulate keeps edge data', () => {
  it('sharp edges stay on the original edges; Keep Normals carries custom normals', () => {
    const quad = buildMesh([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [{ verts: [0, 1, 2, 3] }]);
    const m = { ...quad, sharp: new Uint32Array([1, 0, 1, 0]), custom_normals: Float32Array.from([0, 0, 1, 0.6, 0, 0.8, 0, 0, 1, 0, 0.6, 0.8]) } as unknown as EvalMesh;
    const t = modifierTypes.TRIANGULATE;
    const out = t.apply(m, { ...t.defaults(), keep_custom_normals: true } as never, {} as ModifierContext);
    expect(out.offsets.length - 1).toBe(2);
    // two sharp edges survive (each on one triangle corner), the diagonal is not sharp
    expect(Array.from(out.sharp!).filter(Boolean).length).toBe(2);
    // each corner keeps its vertex's custom normal
    for (let c = 0; c < out.indices.length; c++) {
      const v = out.indices[c];
      const want = [[0, 0, 1], [0.6, 0, 0.8], [0, 0, 1], [0, 0.6, 0.8]][v];
      expect(Array.from(out.custom_normals!.subarray(c * 3, c * 3 + 3)).map((x) => +x.toFixed(3))).toEqual(want);
    }
  });
});

import wireFx from '../fixtures/r4_wireframe.json';

describe('Wireframe: relative offset and crease edges (recorded)', () => {
  const src = buildMesh([0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0, 3, 0.5, 0], [{ verts: [0, 1, 2, 3] }, { verts: [1, 4, 2] }]) as EvalMesh;
  const run = (rel: boolean, cr: boolean) => {
    const t = modifierTypes.WIREFRAME;
    return t.apply(src, { ...t.defaults(), thickness: 0.1, use_relative_offset: rel, use_crease: cr, crease_weight: 0.7 } as never, {} as ModifierContext);
  };
  const key = (p: ArrayLike<number>) => Array.from(p).map((x) => (Math.round(x * 1000) / 1000 + 0).toFixed(3)).join(',');
  it.each([false, true])('relative %s: same vertex positions', (rel) => {
    const out = run(rel, false);
    const ref = (wireFx as Any)[`${rel ? 'True' : 'False'}False`].v as number[][];
    const ours = new Set(Array.from({ length: out.positions.length / 3 }, (_, i) => key(out.positions.subarray(i * 3, i * 3 + 3))));
    for (const p of ref) expect(ours.has(key(p)), key(p)).toBe(true);
  });
  it('crease edges: inset point to tube top / bottom', () => {
    const out = run(false, true);
    const ref = (wireFx as Any).FalseTrue;
    const refSet = new Set<string>();
    ref.e.forEach((e: number[], i: number) => ref.crease[i] > 0 && refSet.add([key(ref.v[e[0]]), key(ref.v[e[1]])].sort().join('|')));
    const ours = new Set<string>();
    for (let f = 0; f + 1 < out.offsets.length; f++)
      for (let c = out.offsets[f]; c < out.offsets[f + 1]; c++) {
        if (!(out.creases![c] > 0)) continue;
        expect(out.creases![c]).toBeCloseTo(0.7, 5);
        const n = c + 1 < out.offsets[f + 1] ? c + 1 : out.offsets[f];
        const pa = out.positions.subarray(out.indices[c] * 3, out.indices[c] * 3 + 3),
          pb = out.positions.subarray(out.indices[n] * 3, out.indices[n] * 3 + 3);
        ours.add([key(pa), key(pb)].sort().join('|'));
      }
    expect([...ours].sort()).toEqual([...refSet].sort());
  });
});

import { uvSphere } from '../../src/mesh/primitives';

describe('Decimate collapse: symmetry and vertex group', () => {
  const sphere = () => {
    const s = uvSphere(32, 16, 1);
    return { ...s, normals: new Float32Array(s.indices.length * 3) } as unknown as EvalMesh;
  };
  const t = modifierTypes.DECIMATE;
  it('symmetry keeps the result mirrored across the axis', () => {
    const out = t.apply(sphere(), { ...t.defaults(), ratio: 0.3, use_symmetry: true, symmetry_axis: 'X' } as never, {} as ModifierContext);
    const key = (x: number, y: number, z: number) => [x, y, z].map((c) => (Math.round(c * 1e4) / 1e4 + 0).toFixed(4)).join(',');
    const set = new Set<string>();
    for (let i = 0; i < out.positions.length; i += 3) set.add(key(out.positions[i], out.positions[i + 1], out.positions[i + 2]));
    for (let i = 0; i < out.positions.length; i += 3) expect(set.has(key(-out.positions[i], out.positions[i + 1], out.positions[i + 2]))).toBe(true);
    expect(out.offsets.length - 1).toBeLessThan(500);
  });
  it('vertices with zero weight stay; weighted ones collapse', () => {
    const m = sphere();
    const nv = m.positions.length / 3;
    const w = Float32Array.from({ length: nv }, (_, v) => (m.positions[v * 3] > 0 ? 1 : 0));
    const mesh = { ...m, vertex_groups: [{ name: 'G' }], weights: [w] } as EvalMesh;
    const out = t.apply(mesh, { ...t.defaults(), ratio: 0.3, vertex_group: 'G' } as never, {} as ModifierContext);
    let pos = 0,
      neg = 0;
    for (let i = 0; i < out.positions.length; i += 3) (out.positions[i] > 1e-4 ? pos++ : out.positions[i] < -1e-4 ? neg++ : 0);
    const neg0 = Array.from({ length: nv }, (_, v) => m.positions[v * 3] < -1e-4).filter(Boolean).length;
    // as recorded: the unweighted half is untouched, the weighted half nearly vanishes
    expect(neg).toBe(neg0);
    expect(pos).toBeLessThan(20);
  });
});
