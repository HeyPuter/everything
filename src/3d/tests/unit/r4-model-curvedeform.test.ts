// @vitest-environment happy-dom
// Curve modifier against recorded reference results: the default Bézier curve deforming a point grid,
// with control point radius and tilt, without radius, with Stretch and with Bounds Clamp.
import { describe, it, expect } from 'vitest';
import { Matrix4 } from 'three';
import fx from '../fixtures/r4_curve_deform.json';
import { modifierTypes } from '../../src/eval/modifiers';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const F = fx as Any;

function run(o: { radiusTilt?: boolean; use_radius?: boolean; use_stretch?: boolean; use_deform_bounds?: boolean }) {
  const sp = {
    type: 'BEZIER',
    points: [],
    use_cyclic_u: false,
    resolution_u: F.res,
    order_u: 4,
    use_smooth: true,
    material_index: 0,
    bezier_points: F.pts.map((p: number[][], i: number) => ({ co: p[0], handle_left: p[1], handle_right: p[2], handle_left_type: 'FREE', handle_right_type: 'FREE', radius: o.radiusTilt && i === 1 ? 2 : 1, tilt: o.radiusTilt && i === 1 ? 0.5 : 0 })),
  };
  const cu = { splines: [sp], resolution_u: F.res, dimensions: '3D', use_radius: o.use_radius, use_stretch: o.use_stretch, use_deform_bounds: o.use_deform_bounds };
  const t = modifierTypes.CURVE;
  const graph = { get: (id: string) => (id === 'ob' ? { world: new Matrix4() } : { world: new Matrix4(), ob: { data: 'cu' } }) };
  const m = { positions: Float32Array.from(F.verts.flat()), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) } as EvalMesh;
  return t.apply(m, { ...t.defaults(), object: 'c' } as never, { ob: { id: 'ob' }, doc: { curves: { cu } }, graph } as unknown as ModifierContext).positions;
}
const worst = (r: Float32Array, ref: number[][]) => Math.max(...ref.map((p, i) => Math.hypot(r[i * 3] - p[0], r[i * 3 + 1] - p[1], r[i * 3 + 2] - p[2])));

describe('Curve modifier (recorded reference)', () => {
  it('default', () => expect(worst(run({}), F.default)).toBeLessThan(2e-3));
  it('radius and tilt', () => expect(worst(run({ radiusTilt: true }), F.radius_tilt)).toBeLessThan(5e-3));
  it('tilt without radius', () => expect(worst(run({ radiusTilt: true, use_radius: false }), F.noradius)).toBeLessThan(5e-3));
  it('stretch', () => expect(worst(run({ radiusTilt: true, use_stretch: true }), F.stretch)).toBeLessThan(5e-3));
  it('stretch and bounds clamp', () => expect(worst(run({ radiusTilt: true, use_stretch: true, use_deform_bounds: true }), F.stretch_bounds)).toBeLessThan(5e-3));
  it('bounds clamp', () => expect(worst(run({ radiusTilt: true, use_deform_bounds: true }), F.bounds)).toBeLessThan(5e-3));
});
