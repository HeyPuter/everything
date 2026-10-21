// Rigid body constraints as physics engine joints: every type is a joint whose frame is the
// constraint object's placement; free axes, limits, springs and motors are set per axis.
//  - Hinge: turns around Z.  Slider: moves along X.  Piston: moves along and turns around X.
//  - Generic: every axis is free unless limited.  Generic Spring: Generic plus springs.
//  - Motor: drives the second body around / along X relative to the first.
import { Quaternion, Vector3 } from 'three';
import type RAPIERNS from '@dimforge/rapier3d-compat';
import type { RigidBodyConstraintData } from './types';

type Rapier = typeof RAPIERNS;

/** Axis indices as the engine numbers them. */
const LIN = [0, 1, 2],
  ANG = [3, 4, 5];
const KEYS = ['x', 'y', 'z'] as const;

export const RBC_TYPES: [string, string][] = [
  ['FIXED', 'Fixed'],
  ['POINT', 'Point'],
  ['HINGE', 'Hinge'],
  ['SLIDER', 'Slider'],
  ['PISTON', 'Piston'],
  ['GENERIC', 'Generic'],
  ['GENERIC_SPRING', 'Generic Spring'],
  ['MOTOR', 'Motor'],
];

/** Settings added to older constraint data (in place). */
export function rbcDefaults(): Partial<RigidBodyConstraintData> {
  const out: Record<string, unknown> = {
    use_breaking: false,
    breaking_threshold: 10,
    use_motor_lin: false,
    use_motor_ang: false,
    motor_lin_target_velocity: 1,
    motor_ang_target_velocity: 1,
    motor_lin_max_impulse: 1,
    motor_ang_max_impulse: 1,
    spring_type: 'SPRING2',
    use_override_solver_iterations: false,
    solver_iterations: 10,
  };
  for (const a of KEYS) {
    out[`use_limit_lin_${a}`] = false;
    out[`use_limit_ang_${a}`] = false;
    out[`limit_lin_${a}_lower`] = -1;
    out[`limit_lin_${a}_upper`] = 1;
    out[`limit_ang_${a}_lower`] = -Math.PI / 4;
    out[`limit_ang_${a}_upper`] = Math.PI / 4;
    out[`use_spring_${a}`] = false;
    out[`use_spring_ang_${a}`] = false;
    out[`spring_stiffness_${a}`] = 10;
    out[`spring_stiffness_ang_${a}`] = 10;
    out[`spring_damping_${a}`] = 0.5;
    out[`spring_damping_ang_${a}`] = 0.5;
  }
  return out as Partial<RigidBodyConstraintData>;
}

export interface JointBody {
  body: RAPIERNS.RigidBody;
}

/** Free axes (engine indices) of a constraint type; limits may restrict them further. */
function freeAxes(type: string): number[] {
  switch (type) {
    case 'HINGE':
      return [5];
    case 'SLIDER':
      return [0];
    case 'PISTON':
      return [0, 3];
    case 'GENERIC':
    case 'GENERIC_SPRING':
    case 'MOTOR':
      return [0, 1, 2, 3, 4, 5];
    default:
      return [];
  }
}

/** Limits of a constraint (engine axis → [lower, upper]) for its type. */
export function jointLimits(c: RigidBodyConstraintData): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const cc = c as unknown as Record<string, number | boolean>;
  const lin = (i: number) => {
    const a = KEYS[i];
    if (cc[`use_limit_lin_${a}`]) out.set(LIN[i], [Number(cc[`limit_lin_${a}_lower`] ?? -1), Number(cc[`limit_lin_${a}_upper`] ?? 1)]);
  };
  const ang = (i: number) => {
    const a = KEYS[i];
    if (cc[`use_limit_ang_${a}`]) out.set(ANG[i], [Number(cc[`limit_ang_${a}_lower`] ?? 0), Number(cc[`limit_ang_${a}_upper`] ?? 0)]);
  };
  if (c.type === 'HINGE') ang(2);
  else if (c.type === 'SLIDER') lin(0);
  else if (c.type === 'PISTON') {
    lin(0);
    ang(0);
  } else if (c.type === 'GENERIC' || c.type === 'GENERIC_SPRING') for (const i of [0, 1, 2]) lin(i), ang(i);
  for (const [k, [lo, hi]] of out) if (lo > hi) out.set(k, [hi, lo]);
  return out;
}

/**
 * Create the joint between two bodies. `anchor`/`rotation` give the constraint object's world placement.
 * `dt` is the simulation step (motor impulses become forces).
 */
/**
 * Damping coefficient of a spring: the legacy model reads the damping as a share (at most 1) of
 * critical damping; the standard model uses it directly.
 */
export function springDamping(c: RigidBodyConstraintData, stiffness: number, damping: number): number {
  const d = Math.max(0, damping);
  return c.spring_type === 'SPRING1' ? Math.min(1, d) * 2 * Math.sqrt(stiffness) : d;
}

export function createJoint(R: Rapier, world: RAPIERNS.World, c: RigidBodyConstraintData, b1: JointBody, b2: JointBody, anchor: Vector3, rotation: Quaternion, dt: number): RAPIERNS.ImpulseJoint {
  const local = (b: JointBody) => {
    const t = b.body.translation(),
      r = b.body.rotation();
    const qi = new Quaternion(r.x, r.y, r.z, r.w).invert();
    const a = anchor.clone().sub(new Vector3(t.x, t.y, t.z)).applyQuaternion(qi);
    const frame = qi.clone().multiply(rotation);
    return { a: { x: a.x, y: a.y, z: a.z }, frame: { x: frame.x, y: frame.y, z: frame.z, w: frame.w } };
  };
  const l1 = local(b1),
    l2 = local(b2);
  if (c.type === 'FIXED') return world.createImpulseJoint(R.JointData.fixed(l1.a, l1.frame, l2.a, l2.frame), b1.body, b2.body, true);
  if (c.type === 'POINT') return world.createImpulseJoint(R.JointData.spherical(l1.a, l2.a), b1.body, b2.body, true);
  const free = freeAxes(c.type);
  let locked = 0;
  for (let i = 0; i < 6; i++) if (!free.includes(i)) locked |= 1 << i;
  const xAxis = new Vector3(1, 0, 0).applyQuaternion(new Quaternion(l1.frame.x, l1.frame.y, l1.frame.z, l1.frame.w));
  const joint = world.createImpulseJoint(R.JointData.generic(l1.a, l2.a, { x: xAxis.x, y: xAxis.y, z: xAxis.z }, locked as RAPIERNS.JointAxesMask), b1.body, b2.body, true);
  const raw = world.impulseJoints.raw;
  const h = joint.handle;
  // full frames, so the Y and Z axes follow the constraint object too
  const f1 = R.RotationOps.intoRaw(l1.frame),
    f2 = R.RotationOps.intoRaw(l2.frame);
  raw.jointSetFrameX1(h, f1);
  raw.jointSetFrameX2(h, f2);
  f1.free();
  f2.free();
  for (const [axis, [lo, hi]] of jointLimits(c)) raw.jointSetLimits(h, axis as RAPIERNS.JointAxis as never, lo, hi);
  const cc = c as unknown as Record<string, number | boolean>;
  if (c.type === 'GENERIC_SPRING')
    for (let i = 0; i < 3; i++) {
      const a = KEYS[i];
      if (cc[`use_spring_${a}`]) {
        const k = Math.max(0, Number(cc[`spring_stiffness_${a}`] ?? 10));
        raw.jointConfigureMotorModel(h, LIN[i] as never, 1 as never);
        raw.jointConfigureMotorPosition(h, LIN[i] as never, 0, k, springDamping(c, k, Number(cc[`spring_damping_${a}`] ?? 0.5)));
      }
      if (cc[`use_spring_ang_${a}`]) {
        const k = Math.max(0, Number(cc[`spring_stiffness_ang_${a}`] ?? 10));
        raw.jointConfigureMotorModel(h, ANG[i] as never, 1 as never);
        raw.jointConfigureMotorPosition(h, ANG[i] as never, 0, k, springDamping(c, k, Number(cc[`spring_damping_ang_${a}`] ?? 0.5)));
      }
    }
  if (c.type === 'MOTOR') {
    const drive = (axis: number, vel: number, impulse: number) => {
      raw.jointConfigureMotorModel(h, axis as never, 1 as never);
      raw.jointConfigureMotorVelocity(h, axis as never, vel, 1e6);
      raw.jointSetMotorMaxForce(h, axis as never, Math.max(0, impulse) / Math.max(1e-6, dt));
    };
    if (cc.use_motor_lin) drive(0, Number(cc.motor_lin_target_velocity ?? 1), Number(cc.motor_lin_max_impulse ?? 1));
    if (cc.use_motor_ang) drive(3, Number(cc.motor_ang_target_velocity ?? 1), Number(cc.motor_ang_max_impulse ?? 1));
  }
  return joint;
}
