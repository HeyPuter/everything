// @vitest-environment happy-dom
// Solidify (simple mode) against recorded reference results: plain, even thickness, high quality
// normals, clamp, vertex group factor; a four-face apex; clamp limits at several thicknesses.
import { describe, it, expect } from 'vitest';
import fx from '../fixtures/r4_solidify.json';
import apex from '../fixtures/r4_solidify_apex.json';
import { modifierTypes } from '../../src/eval/modifiers';
import { buildMesh } from '../../src/mesh/mesh';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const F = fx as Any;
const cases: [string, Record<string, unknown>][] = [
  ['plain', {}],
  ['even', { use_even_offset: true }],
  ['quality', { use_quality_normals: true }],
  ['clamp', { thickness_clamp: 0.5 }],
  ['vg', { vertex_group: 'G', thickness_vertex_group: 0.1 }],
  ['vg_flat', { vertex_group: 'G', thickness_vertex_group: 0.1, use_flat_faces: true }],
];

describe('Solidify simple mode (recorded)', () => {
  const src = buildMesh((F.V as number[][]).flat(), (F.F as number[][]).map((verts) => ({ verts })));
  const weights = Float32Array.from([1, 0.5, 1, 0.2, 1, 0.7, 0.3]);
  const mesh = { ...src, vertex_groups: [{ name: 'G' }], weights: [weights] } as unknown as EvalMesh;
  it.each(cases)('%s', (tag, props) => {
    const t = modifierTypes.SOLIDIFY;
    const out = t.apply(mesh, { ...t.defaults(), thickness: 0.2, offset: -1, ...props } as never, {} as ModifierContext);
    const ref = F[tag] as number[][];
    const ours = Array.from({ length: out.positions.length / 3 }, (_, i) => Array.from(out.positions.subarray(i * 3, i * 3 + 3)));
    expect(ours.length).toBe(ref.length);
    const err = Math.max(...ref.map((p, i) => Math.hypot(p[0] - ours[i][0], p[1] - ours[i][1], p[2] - ours[i][2])));
    expect(err, JSON.stringify({ ref, ours: ours.map((p) => p.map((x) => +x.toFixed(4))) })).toBeLessThan(2e-3);
  });
});

describe('Solidify at a four-face apex (recorded)', () => {
  const A = apex as Any;
  const src = buildMesh((A.V as number[][]).flat(), (A.F as number[][]).map((verts) => ({ verts }))) as unknown as EvalMesh;
  it.each([
    ['nFalse', false, false],
    ['nTrue', false, true],
    ['False', true, false],
    ['True', true, true],
  ] as [string, boolean, boolean][])('%s', (key, quality, even) => {
    const t = modifierTypes.SOLIDIFY;
    const out = t.apply(src, { ...t.defaults(), thickness: 0.2, offset: -1, use_quality_normals: quality, use_even_offset: even } as never, {} as ModifierContext);
    const ref = A[key] as number[][];
    ref.forEach((p, i) => expect(Math.hypot(p[0] - out.positions[i * 3], p[1] - out.positions[i * 3 + 1], p[2] - out.positions[i * 3 + 2]), `vertex ${i}`).toBeLessThan(2e-3));
  });
});

describe('Solidify clamp (recorded offsets)', () => {
  const src = buildMesh((F.V as number[][]).flat(), (F.F as number[][]).map((verts) => ({ verts }))) as unknown as EvalMesh;
  // thickness, clamp -> offset length of each vertex
  const rows: [number, number, number[]][] = [
    [0.5, 0.5, [0.5, 0.5, 0.5, 0.5, 0.4, 0.5, 0.4]],
    [1, 1, [1, 0.9434, 0.9434, 1, 0.2, 0.9434, 0.2]],
    [2, 0.5, [2, 1.8868, 1.8868, 2, 0.4, 1.8868, 0.4]],
    [2, 0.1, [2, 2, 2, 2, 2, 2, 2]],
  ];
  it.each(rows)('thickness %s clamp %s', (thickness, clamp, lens) => {
    const t = modifierTypes.SOLIDIFY;
    const out = t.apply(src, { ...t.defaults(), thickness, offset: -1, thickness_clamp: clamp } as never, {} as ModifierContext);
    lens.forEach((l, i) => {
      const j = i + 7;
      expect(Math.hypot(out.positions[j * 3] - src.positions[i * 3], out.positions[j * 3 + 1] - src.positions[i * 3 + 1], out.positions[j * 3 + 2] - src.positions[i * 3 + 2])).toBeCloseTo(l, 3);
    });
  });
});
