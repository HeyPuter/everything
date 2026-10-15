// Rotation nodes. Rotation fields hold XYZ Euler triples; these nodes convert through unit
// quaternions so results are independent of the Euler representation.
import './fdata';
import { gn, sprop } from './defs';
import { lift } from './flift';
import { eulerToQuat, quatToEuler, quatMul, quatConj, rotateVec, axisAngleToQuat, quatToAxisAngle, quatToMat3, quatNormalize, type Quat, type Vec3 } from '../rotmath';
import { geoExecs } from '../exec';
import { getNodeType } from '../../nodes/registry';
import type { SocketDef } from '../../nodes/types';

const toQ = (e: number | number[]) => {
  const a = e as number[];
  return eulerToQuat(a[0], a[1], a[2]);
};
const toE = (q: Quat) => quatToEuler(q, [0, 0, 0]) as number[];
const vec = (v: number | number[]) => v as number[] as Vec3;
const len = (v: ArrayLike<number>) => Math.hypot(v[0], v[1], v[2]);
const norm = (v: ArrayLike<number>): Vec3 => {
  const l = len(v);
  return l ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
};
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const AXES = { X: 0, Y: 1, Z: 2 } as Record<string, number>;

/** Local axis k (0 = X …) of a rotation. */
function axisOf(q: Quat, k: number): Vec3 {
  const m = quatToMat3(q);
  return [m[k * 3], m[k * 3 + 1], m[k * 3 + 2]];
}

/**
 * Turn `q` so its local `axis` points along `target`, by `factor` of the full turn. With a pivot
 * (0…2) the turn happens around that local axis only; otherwise around the shortest arc.
 */
export function alignToVector(q: Quat, axis: number, pivot: number | null, factor: number, target: Vec3): Quat {
  const t = norm(target);
  if (!len(t)) return q;
  const old = axisOf(q, axis);
  let rotAxis: Vec3;
  let angle: number;
  if (pivot === null) {
    rotAxis = cross(old, t);
    if (len(rotAxis) < 1e-12) {
      rotAxis = cross(old, [1, 0, 0]);
      if (len(rotAxis) < 1e-12) rotAxis = cross(old, [0, 1, 0]);
    }
    angle = Math.acos(Math.max(-1, Math.min(1, dot(norm(old), t))));
  } else {
    rotAxis = axisOf(q, pivot);
    if (pivot === axis) return q;
    const proj = (v: Vec3): Vec3 => {
      const d = dot(v, rotAxis);
      return norm([v[0] - rotAxis[0] * d, v[1] - rotAxis[1] * d, v[2] - rotAxis[2] * d]);
    };
    const a = proj(old),
      b = proj(t);
    if (!len(b)) return q;
    angle = Math.atan2(dot(cross(a, b), rotAxis), dot(a, b));
  }
  return quatMul(axisAngleToQuat(rotAxis, angle * factor), q);
}

gn(
  'FunctionNodeAlignRotationToVector',
  'converter',
  {
    exec: (ctx) => {
      const axis = AXES[sprop(ctx.node, 'axis')] ?? 2;
      const pv = sprop(ctx.node, 'pivot_axis');
      const pivot = pv === 'AUTO' || !pv ? null : AXES[pv];
      return {
        Rotation: lift('ROTATION', [ctx.field('Rotation', 'ROTATION'), ctx.field('Factor', 'FLOAT'), ctx.field('Vector', 'VECTOR')], ([r, f, v]) =>
          toE(alignToVector(toQ(r), axis, pivot, f as number, vec(v))),
        ),
      };
    },
  },
  { propPatch: { axis: { expand: true }, pivot_axis: { expand: true } } },
);

gn(
  'FunctionNodeAlignEulerToVector',
  'converter',
  {
    exec: (ctx) => {
      const axis = AXES[sprop(ctx.node, 'axis')] ?? 0;
      const pv = sprop(ctx.node, 'pivot_axis');
      const pivot = pv === 'AUTO' || !pv ? null : AXES[pv];
      return {
        Rotation: lift('VECTOR', [ctx.field('Rotation', 'VECTOR'), ctx.field('Factor', 'FLOAT'), ctx.field('Vector', 'VECTOR')], ([r, f, v]) =>
          toE(alignToVector(toQ(r), axis, pivot, f as number, vec(v))),
        ),
      };
    },
  },
  { propPatch: { axis: { expand: true }, pivot_axis: { expand: true } } },
);

/** Rotation whose `primary` local axis follows `p` and whose `secondary` axis lies in the p/s plane. */
export function axesToQuat(p: Vec3, s: Vec3, primary: number, secondary: number): Quat {
  if (primary === secondary) return [1, 0, 0, 0];
  const a = norm(p);
  if (!len(a)) return [1, 0, 0, 0];
  const d = dot(s, a);
  let b = norm([s[0] - a[0] * d, s[1] - a[1] * d, s[2] - a[2] * d]);
  if (!len(b)) {
    // secondary direction parallel to the primary: pick any perpendicular
    b = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
  }
  const third = 3 - primary - secondary;
  // right-handed basis: the third axis follows from the other two in cyclic order
  const cols: Vec3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  cols[primary] = a;
  cols[secondary] = b;
  cols[third] = (primary + 1) % 3 === secondary ? cross(a, b) : cross(b, a);
  const m = [...cols[0], ...cols[1], ...cols[2]];
  return matToQuat3(m);
}

function matToQuat3(m: number[]): Quat {
  const m00 = m[0],
    m10 = m[1],
    m20 = m[2],
    m01 = m[3],
    m11 = m[4],
    m21 = m[5],
    m02 = m[6],
    m12 = m[7],
    m22 = m[8];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = 2 * Math.sqrt(tr + 1);
    q = [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
  }
  return quatNormalize(q);
}

gn(
  'FunctionNodeAxesToRotation',
  'converter',
  {
    exec: (ctx) => {
      const pa = AXES[sprop(ctx.node, 'primary_axis')] ?? 2,
        sa = AXES[sprop(ctx.node, 'secondary_axis')] ?? 0;
      if (pa === sa) ctx.warn('The primary and secondary axis must be different');
      return {
        Rotation: lift('ROTATION', [ctx.field('Primary Axis', 'VECTOR'), ctx.field('Secondary Axis', 'VECTOR')], ([p, s]) => toE(axesToQuat(vec(p), vec(s), pa, sa))),
      };
    },
  },
  { propPatch: { primary_axis: { expand: true }, secondary_axis: { expand: true } } },
);

gn('FunctionNodeAxisAngleToRotation', 'converter', {
  exec: (ctx) => ({
    Rotation: lift('ROTATION', [ctx.field('Axis', 'VECTOR'), ctx.field('Angle', 'FLOAT')], ([a, g]) => toE(axisAngleToQuat(vec(a), g as number))),
  }),
});

gn('FunctionNodeRotationToAxisAngle', 'converter', {
  exec: (ctx) => {
    const r = ctx.field('Rotation', 'ROTATION');
    return {
      Axis: lift('VECTOR', [r], ([e]) => quatToAxisAngle(toQ(e)).axis),
      Angle: lift('FLOAT', [r], ([e]) => quatToAxisAngle(toQ(e)).angle),
    };
  },
});

gn('FunctionNodeInvertRotation', 'converter', {
  exec: (ctx) => ({ Rotation: lift('ROTATION', [ctx.field('Rotation', 'ROTATION')], ([e]) => toE(quatConj(quatNormalize(toQ(e))))) }),
});

gn(
  'FunctionNodeRotateRotation',
  'converter',
  {
    exec: (ctx) => {
      const local = sprop(ctx.node, 'rotation_space') === 'LOCAL';
      return {
        Rotation: lift('ROTATION', [ctx.field('Rotation', 'ROTATION'), ctx.field('Rotate By', 'ROTATION')], ([a, b]) => {
          const qa = toQ(a),
            qb = toQ(b);
          return toE(local ? quatMul(qa, qb) : quatMul(qb, qa));
        }),
      };
    },
  },
  { propPatch: { rotation_space: { expand: true } } },
);

gn('FunctionNodeRotateVector', 'converter', {
  exec: (ctx) => ({
    Vector: lift('VECTOR', [ctx.field('Vector', 'VECTOR'), ctx.field('Rotation', 'ROTATION')], ([v, e]) => rotateVec(toQ(e), vec(v))),
  }),
});

gn('FunctionNodeRotationToQuaternion', 'converter', {
  exec: (ctx) => {
    const r = ctx.field('Rotation', 'ROTATION');
    const c = (k: number) => lift('FLOAT', [r], ([e]) => toQ(e)[k]);
    return { W: c(0), X: c(1), Y: c(2), Z: c(3) };
  },
});

gn('FunctionNodeQuaternionToRotation', 'converter', {
  exec: (ctx) => ({
    Rotation: lift(
      'ROTATION',
      ['W', 'X', 'Y', 'Z'].map((id) => ctx.field(id, 'FLOAT')),
      ([w, x, y, z]) => toE(quatNormalize([w as number, x as number, y as number, z as number])),
    ),
  }),
});

// Rotate Euler (kept for older files): Euler in, Euler out
gn(
  'FunctionNodeRotateEuler',
  'converter',
  {
    exec: (ctx) => {
      const axisAngle = sprop(ctx.node, 'rotation_type') === 'AXIS_ANGLE';
      const local = sprop(ctx.node, 'space') === 'LOCAL';
      const by = axisAngle ? lift('ROTATION', [ctx.field('Axis', 'VECTOR'), ctx.field('Angle', 'FLOAT')], ([a, g]) => toE(axisAngleToQuat(vec(a), g as number))) : ctx.field('Rotate By', 'ROTATION');
      return {
        Rotation: lift('VECTOR', [ctx.field('Rotation', 'VECTOR'), by], ([a, b]) => {
          const qa = toQ(a),
            qb = toQ(b);
          return toE(local ? quatMul(qa, qb) : quatMul(qb, qa));
        }),
      };
    },
  },
  {
    propPatch: { rotation_type: { expand: true }, space: { expand: true } },
    dynamicSockets: (node) => {
      const inputs: SocketDef[] = [{ name: 'Rotation', identifier: 'Rotation', type: 'VECTOR', default: [0, 0, 0], subtype: 'EULER', hide_value: true }];
      if (sprop(node, 'rotation_type') === 'AXIS_ANGLE')
        inputs.push({ name: 'Axis', identifier: 'Axis', type: 'VECTOR', default: [0, 0, 1], subtype: 'XYZ' }, { name: 'Angle', identifier: 'Angle', type: 'FLOAT', default: 0, subtype: 'ANGLE' });
      else inputs.push({ name: 'Rotate By', identifier: 'Rotate By', type: 'VECTOR', default: [0, 0, 0], subtype: 'EULER' });
      return { inputs, outputs: [{ name: 'Rotation', identifier: 'Rotation', type: 'VECTOR', default: [0, 0, 0], subtype: 'EULER' }] };
    },
  },
);

// Rotation to Euler gives the canonical angles of the rotation (smallest equivalent Euler set)
if (getNodeType('FunctionNodeRotationToEuler'))
  geoExecs.FunctionNodeRotationToEuler = {
    exec: (ctx) => ({ Euler: lift('VECTOR', [ctx.field('Rotation', 'ROTATION')], ([e]) => toE(toQ(e))) }),
  };
