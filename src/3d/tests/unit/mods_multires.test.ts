// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { catmullClark } from '../../src/eval/modifiers';
import { unsubdivide, subdividedMap, encodeDisps, decodeDisps, multiresAtLevel, subdivideDisps } from '../../src/eval/mods/multires';
import type { EvalMesh } from '../../src/eval/types';

const mesh = (a: ReturnType<typeof prim.cube>) => newMeshData('m', a) as unknown as EvalMesh;
const maxErr = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let e = 0;
  for (let i = 0; i < a.length; i++) e = Math.max(e, Math.abs(a[i] - b[i]));
  return e;
};
const faceSet = (m: EvalMesh, map?: Int32Array) => {
  const s = new Set<string>();
  for (let f = 0; f < m.offsets.length - 1; f++) s.add(Array.from(m.indices.subarray(m.offsets[f], m.offsets[f + 1]), (v) => (map ? map[v] : v)).sort((a, b) => a - b).join(','));
  return s;
};

describe('Multires', () => {
  it('stores detail as displacements that follow the base', () => {
    const base = mesh(prim.cube(2));
    const top = catmullClark(base, 2);
    const target = Float32Array.from(top.positions, (x, i) => x * (1 + 0.1 * Math.sin(i)));
    const d = encodeDisps(top, target);
    expect(maxErr(decodeDisps(top, d), target)).toBeLessThan(1e-5);
    const mod = { id: 'm', name: 'M', type: 'MULTIRES', total_levels: 2, _disps: d } as never;
    expect(maxErr(multiresAtLevel(base, mod, 2).positions, target)).toBeLessThan(1e-5);
    // level 1 samples the detailed surface at its own vertices
    const l1 = multiresAtLevel(base, mod, 1);
    expect(l1.positions.length).toBe(catmullClark(base, 1).positions.length);
    expect(maxErr(l1.positions, target.subarray(0, l1.positions.length))).toBeLessThan(1e-5);
    // a scaled base carries the detail along
    const big = { ...base, positions: Float32Array.from(base.positions, (x) => x * 2) };
    const shifted = multiresAtLevel(big, mod, 2).positions;
    const bigTop = catmullClark(big, 2).positions;
    expect(maxErr(Float32Array.from(shifted, (x, i) => x - bigTop[i]), Float32Array.from(target, (x, i) => x - top.positions[i]))).toBeLessThan(1e-4);
  });

  it('adds a level keeping the shape with simple subdivision', () => {
    const base = mesh(prim.cube(2));
    const mod = { id: 'm', name: 'M', type: 'MULTIRES', total_levels: 1 } as Record<string, unknown>;
    const lin = subdivideDisps(base, mod as never, 'LINEAR');
    mod.total_levels = 2;
    mod._disps = lin;
    const out = multiresAtLevel(base, mod as never, 2);
    // a linear split of the level-1 surface: all new points stay on the level-1 faces' planes
    const l1 = catmullClark(base, 1);
    expect(maxErr(out.positions.subarray(0, l1.positions.length), l1.positions)).toBeLessThan(1e-5);
  });

  it('recovers the coarse mesh of a subdivided mesh', () => {
    const base = mesh(prim.cube(2));
    const fine = catmullClark(base, 1);
    const r = unsubdivide(fine)!;
    expect(r).not.toBeNull();
    expect(r.coarse.positions.length / 3).toBe(8);
    expect(r.coarse.offsets.length - 1).toBe(6);
    const again = catmullClark(r.coarse, 1, true);
    const want = faceSet(again);
    for (const k of faceSet(fine, r.map)) expect(want.has(k)).toBe(true);
    // two levels at once through the composed map
    const fine2 = catmullClark(base, 2);
    const r1 = unsubdivide(fine2)!;
    const r2 = unsubdivide(r1.coarse)!;
    expect(r2.coarse.offsets.length - 1).toBe(6);
    const m2 = subdividedMap(r1.coarse, catmullClark(r2.coarse, 1, true), r2.map, 1);
    const composed = Int32Array.from(r1.map, (v) => m2[v]);
    const target = new Float32Array(fine2.positions.length);
    for (let v = 0; v < composed.length; v++) target.set(fine2.positions.subarray(v * 3, v * 3 + 3), composed[v] * 3);
    expect(faceSet(catmullClark(r2.coarse, 2, true)).size).toBe(faceSet(fine2).size);
    for (const k of faceSet(fine2, composed)) expect(faceSet(catmullClark(r2.coarse, 2, true)).has(k)).toBe(true);
    expect(target.every((x) => Number.isFinite(x))).toBe(true);
  });

  it('refuses meshes that are not subdivided', () => {
    expect(unsubdivide(mesh(prim.cube(2)))).toBeNull();
    expect(unsubdivide(mesh(prim.uvSphere(8, 4, 1)))).toBeNull();
  });
});
