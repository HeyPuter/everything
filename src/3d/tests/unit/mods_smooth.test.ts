// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { correctiveSmooth } from '../../src/eval/mods/smooth';
import { modifierTypes } from '../../src/eval/modifiers';
import '../../src/eval/mods/index';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

// A 4×4 grid (size 2) bent into a wave and sheared ("input"), smoothed with the rest shape being
// the flat grid; expected positions were measured with the same settings.
const REF: Record<string, number[]> = {"input": [-1.1, -1.0, 0.3812, -0.6, -1.0, 0.6127, -0.1, -1.0, 0.7, 0.4, -1.0, 0.6127, 0.9, -1.0, 0.3812, -1.05, -0.5, 0.2312, -0.55, -0.5, 0.4627, -0.05, -0.5, 0.55, 0.45, -0.5, 0.4627, 0.95, -0.5, 0.2312, -1.0, 0.0, 0.1812, -0.5, 0.0, 0.4127, 0.0, 0.0, 0.5, 0.5, 0.0, 0.4127, 1.0, 0.0, 0.1812, -0.95, 0.5, 0.2312, -0.45, 0.5, 0.4627, 0.05, 0.5, 0.55, 0.55, 0.5, 0.4627, 1.05, 0.5, 0.2312, -0.9, 1.0, 0.3812, -0.4, 1.0, 0.6127, 0.1, 1.0, 0.7, 0.6, 1.0, 0.6127, 1.1, 1.0, 0.3812], "default": [-1.0776, -0.9829, 0.406, -0.5852, -0.9925, 0.5125, -0.0838, -0.9974, 0.5551, 0.4176, -1.0033, 0.508, 0.9149, -1.0207, 0.4033, -1.0374, -0.4872, 0.3278, -0.5455, -0.4963, 0.4435, -0.0465, -0.4996, 0.4937, 0.4531, -0.5039, 0.443, 0.9476, -0.5192, 0.3292, -0.9919, 0.0156, 0.298, -0.4989, 0.0034, 0.4124, -0.0, 0.0, 0.4637, 0.4989, -0.0034, 0.4124, 0.9919, -0.0156, 0.298, -0.9476, 0.5192, 0.3292, -0.4531, 0.5039, 0.443, 0.0465, 0.4996, 0.4937, 0.5455, 0.4963, 0.4435, 1.0374, 0.4872, 0.3278, -0.9149, 1.0207, 0.4033, -0.4176, 1.0033, 0.508, 0.0838, 0.9974, 0.5551, 0.5852, 0.9925, 0.5125, 1.0776, 0.9829, 0.406], "only": [-0.6829, -0.6209, 0.4311, -0.466, -0.6668, 0.4833, -0.068, -0.6796, 0.5174, 0.3326, -0.6668, 0.4833, 0.5588, -0.6209, 0.4311, -0.7068, -0.3993, 0.3913, -0.4659, -0.4236, 0.4481, -0.043, -0.4295, 0.4876, 0.3812, -0.4236, 0.4481, 0.6269, -0.3993, 0.3913, -0.6796, 0.0, 0.3677, -0.4295, 0.0, 0.4233, -0.0, 0.0, 0.4637, 0.4295, 0.0, 0.4233, 0.6796, 0.0, 0.3677, -0.6269, 0.3993, 0.3913, -0.3812, 0.4236, 0.4481, 0.043, 0.4295, 0.4876, 0.4659, 0.4236, 0.4481, 0.7068, 0.3993, 0.3913, -0.5588, 0.6209, 0.4311, -0.3326, 0.6668, 0.4833, 0.068, 0.6796, 0.5174, 0.466, 0.6668, 0.4833, 0.6829, 0.6209, 0.4311], "lenw": [-1.0777, -0.9882, 0.4036, -0.5911, -0.9936, 0.5419, -0.0866, -0.9975, 0.6005, 0.4186, -1.0055, 0.5367, 0.9126, -1.0246, 0.4003, -1.0328, -0.4954, 0.2953, -0.5498, -0.4996, 0.4504, -0.0476, -0.5014, 0.5179, 0.4557, -0.5063, 0.4498, 0.9429, -0.5227, 0.2961, -0.9862, 0.0129, 0.2548, -0.502, 0.0025, 0.4099, 0.0, 0.0, 0.4789, 0.502, -0.0025, 0.4099, 0.9862, -0.0129, 0.2548, -0.9429, 0.5227, 0.2961, -0.4557, 0.5063, 0.4498, 0.0476, 0.5014, 0.5179, 0.5498, 0.4996, 0.4504, 1.0328, 0.4954, 0.2953, -0.9126, 1.0246, 0.4003, -0.4186, 1.0055, 0.5367, 0.0866, 0.9975, 0.6005, 0.5911, 0.9936, 0.5419, 1.0777, 0.9882, 0.4036], "pin": [-1.1, -1.0, 0.3812, -0.6, -1.0, 0.6127, -0.1, -1.0, 0.7, 0.4, -1.0, 0.6127, 0.9, -1.0, 0.3812, -1.05, -0.5, 0.2312, -0.55, -0.5, 0.4426, -0.05, -0.5, 0.5189, 0.45, -0.5, 0.4426, 0.95, -0.5, 0.2312, -1.0, 0.0, 0.1812, -0.5, 0.0, 0.3889, -0.0, 0.0, 0.4632, 0.5, 0.0, 0.3889, 1.0, 0.0, 0.1812, -0.95, 0.5, 0.2312, -0.45, 0.5, 0.4426, 0.05, 0.5, 0.5189, 0.55, 0.5, 0.4426, 1.05, 0.5, 0.2312, -0.9, 1.0, 0.3812, -0.4, 1.0, 0.6127, 0.1, 1.0, 0.7, 0.6, 1.0, 0.6127, 1.1, 1.0, 0.3812], "lw_only_1": [-0.8194, -0.7562, 0.4266, -0.5981, -0.8896, 0.5445, -0.0887, -0.8865, 0.6276, 0.4202, -0.8896, 0.5445, 0.6682, -0.7562, 0.4266, -0.9342, -0.5041, 0.3075, -0.5554, -0.5023, 0.4555, -0.0502, -0.5024, 0.5414, 0.455, -0.5023, 0.4555, 0.8334, -0.5041, 0.3075, -0.8823, 0.0, 0.2572, -0.5052, 0.0, 0.4048, -0.0, 0.0, 0.4906, 0.5052, 0.0, 0.4048, 0.8823, 0.0, 0.2572, -0.8334, 0.5041, 0.3075, -0.455, 0.5023, 0.4555, 0.0502, 0.5024, 0.5414, 0.5554, 0.5023, 0.4555, 0.9342, 0.5041, 0.3075, -0.6682, 0.7562, 0.4266, -0.4202, 0.8896, 0.5445, 0.0887, 0.8865, 0.6276, 0.5981, 0.8896, 0.5445, 0.8194, 0.7562, 0.4266]};

const grid = () => newMeshData('g', prim.grid(4, 4, 2)) as unknown as EvalMesh;
const base = { iterations: 5, factor: 0.5, scale: 1, lengthWeighted: false, pinBoundary: false, onlySmooth: false, weights: null };
const maxErr = (a: ArrayLike<number>, b: number[]) => b.reduce((e, v, i) => Math.max(e, Math.abs(v - a[i])), 0);

describe('Corrective Smooth', () => {
  const def = Float32Array.from(REF.input);
  it('smooths to the expected values (simple, length weighted, pinned boundary)', () => {
    const m = grid();
    expect(maxErr(correctiveSmooth(m, def, m.positions, { ...base, onlySmooth: true }), REF.only)).toBeLessThan(2e-4);
    expect(maxErr(correctiveSmooth(m, def, m.positions, { ...base, onlySmooth: true, lengthWeighted: true, iterations: 1, factor: 1 }), REF.lw_only_1)).toBeLessThan(2e-4);
    expect(maxErr(correctiveSmooth(m, def, m.positions, { ...base, pinBoundary: true }), REF.pin)).toBeLessThan(2e-4);
  });

  it('restores the rest detail in tangent space', () => {
    const m = grid();
    expect(maxErr(correctiveSmooth(m, def, m.positions, base), REF.default)).toBeLessThan(5e-3);
    expect(maxErr(correctiveSmooth(m, def, m.positions, { ...base, lengthWeighted: true }), REF.lenw)).toBeLessThan(8e-3);
  });

  it('leaves an undeformed or rigidly moved mesh unchanged', () => {
    const m = newMeshData('s', prim.uvSphere(16, 8, 1)) as unknown as EvalMesh;
    const same = correctiveSmooth(m, m.positions, m.positions, base);
    expect(maxErr(same, Array.from(m.positions))).toBeLessThan(1e-5);
    const rot = new Matrix4().makeRotationAxis(new Vector3(0.3, 0.5, 0.8).normalize(), 0.7).setPosition(1, 2, 3);
    const moved = Float32Array.from(m.positions);
    for (let i = 0; i < moved.length; i += 3) {
      const e = rot.elements;
      const [x, y, z] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
      moved[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
      moved[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      moved[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    expect(maxErr(correctiveSmooth(m, moved, m.positions, base), Array.from(moved))).toBeLessThan(1e-4);
  });

  it('uses bind data when the rest source is Bind', () => {
    const m = grid();
    const t = modifierTypes.CORRECTIVE_SMOOTH;
    const mod = { ...t.defaults(), type: 'CORRECTIVE_SMOOTH', rest_source: 'BIND' } as never;
    expect(() => t.apply({ ...m, positions: def }, mod, { source: null } as unknown as ModifierContext)).toThrow(/Bind/);
    const bound = { ...(mod as object), _bind_coords: Float32Array.from(m.positions) } as never;
    const out = t.apply({ ...m, positions: def }, bound, { source: null } as unknown as ModifierContext);
    expect(maxErr(out.positions, REF.default)).toBeLessThan(5e-3);
  });
});
