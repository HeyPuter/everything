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

describe('Screw: Calculate Order (recorded orientations)', () => {
  const V = [1, 0, 0, 1.5, 0, 0.5, 1.2, 0, 1, 1, 0, 1.5];
  const outward = (E: number[], calc: boolean, flip: boolean) => {
    const m = { ...buildMesh(V, []), looseEdges: Uint32Array.from(E) } as unknown as EvalMesh;
    const t = modifierTypes.SCREW;
    const out = t.apply(m, { ...t.defaults(), steps: 8, use_normal_calculate: calc, use_normal_flip: flip } as never, {} as ModifierContext);
    let sum = 0;
    for (let f = 0; f + 1 < out.offsets.length; f++) {
      const s = out.offsets[f];
      const c = [0, 1, 2].map((k) => { let x = 0; for (let i = s; i < out.offsets[f + 1]; i++) x += out.positions[out.indices[i] * 3 + k]; return x / (out.offsets[f + 1] - s); });
      sum += Math.sign(out.normals[s * 3] * c[0] + out.normals[s * 3 + 1] * c[1]);
    }
    return sum;
  };
  it.each([
    [[0, 1, 1, 2, 2, 3], false, false, -24],
    [[0, 1, 1, 2, 2, 3], true, false, 24],
    [[1, 0, 2, 1, 3, 2], false, false, 24],
    [[0, 1, 2, 1, 2, 3], false, false, -8],
    [[0, 1, 2, 1, 2, 3], true, false, 24],
    [[0, 1, 2, 1, 2, 3], true, true, -24],
  ] as [number[], boolean, boolean, number][])('edges %j calc %s flip %s', (E, calc, flip, want) => expect(outward(E, calc, flip)).toBe(want));
});

describe('Mask: Smooth cuts along the threshold (recorded)', () => {
  const src = buildMesh([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0], [{ verts: [0, 1, 4, 3] }, { verts: [1, 2, 5, 4] }]);
  const mesh = { ...src, vertex_groups: [{ name: 'G' }], weights: [Float32Array.from([1, 0.6, 0, 1, 0.2, 0])] } as unknown as EvalMesh;
  const key = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`;
  it.each([
    [false, ['0.000,0.000', '1.000,0.000', '0.000,1.000', '1.000,0.500', '0.750,1.000', '1.333,0.000'], [5, 3]],
    [true, ['2.000,0.000', '1.000,1.000', '2.000,1.000', '1.000,0.500', '0.750,1.000', '1.333,0.000'], [3, 5]],
  ] as [boolean, string[], number[]][])('invert %s', (inv, verts, sizes) => {
    const t = modifierTypes.MASK;
    const out = t.apply(mesh, { ...t.defaults(), vertex_group: 'G', threshold: 0.4, use_smooth: true, invert_vertex_group: inv } as never, {} as ModifierContext);
    const ours = Array.from({ length: out.positions.length / 3 }, (_, i) => key(out.positions[i * 3], out.positions[i * 3 + 1]));
    expect(ours.sort()).toEqual([...verts].sort());
    expect(Array.from({ length: out.offsets.length - 1 }, (_, f) => out.offsets[f + 1] - out.offsets[f])).toEqual(sizes);
  });
});

describe('Shrinkwrap: auxiliary target', () => {
  const plane = (z: number) => buildMesh([-5, -5, z, 5, -5, z, 5, 5, z, -5, 5, z], [{ verts: [0, 1, 2, 3] }]) as unknown as EvalMesh;
  it('projects onto the nearer of the target and the auxiliary target', () => {
    const graph = new Map<string, Any>([
      ['ob', { world: new Matrix4(), ob: { id: 'ob' } }],
      ['t', { world: new Matrix4(), mesh: plane(-1) }],
      ['aux', { world: new Matrix4(), mesh: plane(0.5) }],
    ]);
    const m = buildMesh([0, 0, 0], []) as unknown as EvalMesh;
    const t = modifierTypes.SHRINKWRAP;
    const run = (aux: string | null) =>
      t.apply(m, { ...t.defaults(), target: 't', auxiliary_target: aux, wrap_method: 'PROJECT', use_project_z: true, use_negative_direction: true } as never, { ob: { id: 'ob' }, graph } as unknown as ModifierContext).positions[2];
    expect(run(null)).toBeCloseTo(-1, 5);
    expect(run('aux')).toBeCloseTo(0.5, 5);
  });
});

describe('Texture coordinates shared by Displace, Warp and Wave', () => {
  const tri = () => {
    const m = buildMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [{ verts: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1] }]) as Any;
    m.uv_map_name = 'UVMap';
    m.uv_layers_extra = [{ name: 'Second', data: Float32Array.from([0.25, 0, 0.75, 0, 0.5, 1]) }];
    return m as EvalMesh;
  };
  const blend = { type: 'BLEND' };
  it('Displace reads the chosen UV map', () => {
    const m = tri();
    const t = modifierTypes.DISPLACE;
    const ctx = { ob: { id: 'ob' }, source: m, graph: new Map() } as unknown as ModifierContext;
    const run = (uv_layer: string) => t.apply(m, { ...t.defaults(), texture: blend, texture_coords: 'UV', uv_layer, direction: 'Z', mid_level: 0 } as never, ctx).positions;
    // the blend texture is the u coordinate here
    expect([0, 1, 2].map((v) => +run('')[v * 3 + 2].toFixed(4))).toEqual([0, 1, 0]);
    expect([0, 1, 2].map((v) => +run('Second')[v * 3 + 2].toFixed(4))).toEqual([0.25, 0.75, 0.5]);
  });
  it('Wave height follows its texture', () => {
    const m = tri();
    const t = modifierTypes.WAVE;
    const ctx = { ob: { id: 'ob' }, source: m, frame: 0, graph: new Map() } as unknown as ModifierContext;
    const base = { ...t.defaults(), use_cyclic: true, width: 2, time_offset: 0, speed: 0 };
    const plain = t.apply(m, base as never, ctx).positions;
    const tex = t.apply(m, { ...base, texture: blend, texture_coords: 'UV' } as never, ctx).positions;
    // vertex 1 has u = 1 (full height), vertex 0 has u = 0 (no wave)
    expect(tex[1 * 3 + 2]).toBeCloseTo(plain[1 * 3 + 2], 5);
    expect(tex[0 * 3 + 2]).toBeCloseTo(0, 5);
  });
});

describe('Mirror: UV flip within UDIM tiles (recorded)', () => {
  it.each([
    [false, 0, [0, -0.3, -1, -1]],
    [true, 0, [1, 1.7, 2, 2]],
    [true, 0.25, [1.25, 1.95, 2.25, 2.25]],
  ] as [boolean, number, number[]][])('udim %s offset %s', (udim, off, us) => {
    const m = buildMesh([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [{ verts: [0, 1, 2, 3], uvs: [1, 0.2, 2, 0.2, 2, 0.8, 1.3, 0.8] }]) as unknown as EvalMesh;
    const t = modifierTypes.MIRROR;
    const out = t.apply(m, { ...t.defaults(), use_mirror_u: true, use_mirror_udim: udim, mirror_offset_u: off, use_mirror_merge: false } as never, { ob: { id: 'ob' }, graph: new Map() } as unknown as ModifierContext);
    // the mirrored face's corners in reverse order: 0, 3, 2, 1
    const got = [4, 5, 6, 7].map((c) => +out.uvs[c * 2].toFixed(4));
    const byCorner = [got[0], got[3], got[2], got[1]];
    expect(byCorner.sort()).toEqual([...us].sort());
  });
});
