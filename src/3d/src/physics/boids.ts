// Boid particles: each particle steers by a list of rules (goal, avoid, avoid collisions, separate,
// flock, follow leader, average speed) evaluated in order of the brain's rule set, flying within
// speed and acceleration limits.
import { Vector3 } from 'three';
import type { DocumentData, ID } from '../data/types';
import type { ColliderMesh } from './colliders';
import { segmentHit, newHit } from './colliders';

export type BoidRuleType = 'GOAL' | 'AVOID' | 'AVOID_COLLISION' | 'SEPARATE' | 'FLOCK' | 'FOLLOW_LEADER' | 'AVERAGE_SPEED';

export interface BoidRule {
  type: BoidRuleType;
  name: string;
  use_in_air: boolean;
  object: ID | null;
  /** goal / avoid: aim where the object will be */
  use_predict: boolean;
  /** avoid: how far away the boid starts fleeing */
  fear_factor: number;
  /** avoid collision: look-ahead time in seconds */
  look_ahead: number;
  /** follow leader: distance behind the leader */
  distance: number;
  /** average speed: target speed (fraction of max), wandering and keeping level */
  speed: number;
  wander: number;
  level: number;
}

export interface BoidSettings {
  rules: BoidRule[];
  active_rule_index: number;
  rule_fuzzy: number;
  ruleset_type: 'FUZZY' | 'RANDOM' | 'AVERAGE';
  air_speed_max: number;
  air_speed_min: number;
  air_acc_max: number;
  air_personal_space: number;
  /** neighbours further than this are ignored (flocking, separation) */
  range: number;
}

export const BOID_RULES: [BoidRuleType, string][] = [
  ['GOAL', 'Goal'],
  ['AVOID', 'Avoid'],
  ['AVOID_COLLISION', 'Avoid Collision'],
  ['SEPARATE', 'Separate'],
  ['FLOCK', 'Flock'],
  ['FOLLOW_LEADER', 'Follow Leader'],
  ['AVERAGE_SPEED', 'Average Speed'],
];

export function newBoidRule(type: BoidRuleType): BoidRule {
  return { type, name: BOID_RULES.find(([t]) => t === type)?.[1] ?? type, use_in_air: true, object: null, use_predict: false, fear_factor: 1, look_ahead: 2, distance: 1, speed: 0.5, wander: 0, level: 0 };
}

export function defaultBoidSettings(): BoidSettings {
  return { rules: [newBoidRule('SEPARATE'), newBoidRule('FLOCK')], active_rule_index: 0, rule_fuzzy: 0.5, ruleset_type: 'FUZZY', air_speed_max: 10, air_speed_min: 0, air_acc_max: 0.5, air_personal_space: 1, range: 2 };
}

/** Spatial hash of particle positions for neighbour queries. */
export class NeighbourGrid {
  private cells = new Map<number, number[]>();
  constructor(
    private pos: Float32Array,
    private cell: number,
    alive: (i: number) => boolean,
    n: number,
  ) {
    for (let i = 0; i < n; i++) {
      if (!alive(i)) continue;
      const k = this.key(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(i);
    }
  }
  private key(x: number, y: number, z: number) {
    const c = this.cell;
    return ((Math.floor(x / c) * 73856093) ^ (Math.floor(y / c) * 19349663) ^ (Math.floor(z / c) * 83492791)) | 0;
  }
  /** Call `fn` for every particle within `r` (≤ cell size) of particle i (not i itself). */
  each(i: number, r: number, fn: (j: number, dx: number, dy: number, dz: number, d: number) => void) {
    const P = this.pos;
    const x = P[i * 3],
      y = P[i * 3 + 1],
      z = P[i * 3 + 2];
    const c = this.cell;
    const ix = Math.floor(x / c),
      iy = Math.floor(y / c),
      iz = Math.floor(z / c);
    const r2 = r * r;
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (let d = -1; d <= 1; d++) {
          const l = this.cells.get((((ix + a) * 73856093) ^ ((iy + b) * 19349663) ^ ((iz + d) * 83492791)) | 0);
          if (!l) continue;
          for (const j of l) {
            if (j === i) continue;
            const dx = P[j * 3] - x,
              dy = P[j * 3 + 1] - y,
              dz = P[j * 3 + 2] - z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < r2) fn(j, dx, dy, dz, Math.sqrt(d2));
          }
        }
  }
}

const hit = newHit();

/**
 * Steering accelerations of all alive boids for one step (written to `acc`, m/s²).
 * `objects` gives world positions (and velocities) of rule objects.
 */
export function boidAccelerations(
  b: BoidSettings,
  pos: Float32Array,
  vel: Float32Array,
  alive: (i: number) => boolean,
  n: number,
  objects: Map<string, { p: Vector3; v: Vector3 }>,
  cols: ColliderMesh[],
  rand: (i: number, ch: number) => number,
  acc: Float32Array,
) {
  const range = Math.max(0.01, b.range, b.air_personal_space);
  const grid = new NeighbourGrid(pos, range, alive, n);
  const maxAcc = Math.max(0.001, b.air_acc_max) * Math.max(0.001, b.air_speed_max) * 4;
  const steer = new Vector3(),
    out = new Vector3(),
    tmp = new Vector3(),
    v = new Vector3(),
    p = new Vector3();
  for (let i = 0; i < n; i++) {
    acc[i * 3] = acc[i * 3 + 1] = acc[i * 3 + 2] = 0;
    if (!alive(i)) continue;
    p.fromArray(pos, i * 3);
    v.fromArray(vel, i * 3);
    out.set(0, 0, 0);
    let budget = 1,
      count = 0;
    const rules = b.ruleset_type === 'RANDOM' && b.rules.length ? [b.rules[Math.floor(rand(i, 7) * b.rules.length) % b.rules.length]] : b.rules;
    for (const r of rules) {
      if (!r.use_in_air) continue;
      steer.set(0, 0, 0);
      const target = r.object ? objects.get(r.object) : undefined;
      switch (r.type) {
        case 'GOAL':
          if (target) {
            tmp.copy(target.p);
            if (r.use_predict) tmp.addScaledVector(target.v, p.distanceTo(target.p) / Math.max(0.1, v.length()));
            steer.copy(tmp.sub(p)).normalize().multiplyScalar(b.air_speed_max).sub(v);
          }
          break;
        case 'AVOID':
          if (target) {
            tmp.copy(target.p);
            if (r.use_predict) tmp.addScaledVector(target.v, p.distanceTo(target.p) / Math.max(0.1, v.length()));
            const d = p.distanceTo(tmp);
            const fear = Math.max(0.01, r.fear_factor) * range * 2;
            if (d < fear) steer.copy(p).sub(tmp).normalize().multiplyScalar(b.air_speed_max * (1 - d / fear)).sub(v).multiplyScalar(2);
          }
          break;
        case 'AVOID_COLLISION': {
          const ahead = Math.max(0.01, r.look_ahead) * v.length();
          if (cols.length && ahead > 1e-4) {
            tmp.copy(v).normalize();
            if (segmentHit(cols, p.x, p.y, p.z, p.x + tmp.x * ahead, p.y + tmp.y * ahead, p.z + tmp.z * ahead, hit)) {
              // turn along the surface, harder the closer the hit
              const nrm = new Vector3(hit.nx, hit.ny, hit.nz);
              if (nrm.dot(tmp) > 0) nrm.negate();
              steer.copy(nrm).multiplyScalar(b.air_speed_max * (1 - hit.dist) * 2);
            }
          }
          break;
        }
        case 'SEPARATE': {
          const ps = Math.max(0.01, b.air_personal_space);
          grid.each(i, ps, (_j, dx, dy, dz, d) => {
            if (d < 1e-6) return;
            steer.x -= (dx / d) * (ps - d);
            steer.y -= (dy / d) * (ps - d);
            steer.z -= (dz / d) * (ps - d);
          });
          steer.multiplyScalar(b.air_speed_max);
          break;
        }
        case 'FLOCK': {
          const c = new Vector3(),
            av = new Vector3();
          let k = 0;
          grid.each(i, range, (j, dx, dy, dz) => {
            c.x += dx;
            c.y += dy;
            c.z += dz;
            av.x += vel[j * 3];
            av.y += vel[j * 3 + 1];
            av.z += vel[j * 3 + 2];
            k++;
          });
          if (k) {
            // towards the neighbours' centre and matching their heading
            steer.copy(c.divideScalar(k)).add(av.divideScalar(k).sub(v));
          }
          break;
        }
        case 'FOLLOW_LEADER':
          if (target) {
            const behind = target.v.lengthSq() > 1e-8 ? target.v.clone().normalize().multiplyScalar(-Math.max(0, r.distance)) : new Vector3();
            tmp.copy(target.p).add(behind);
            steer.copy(tmp.sub(p)).multiplyScalar(2).sub(v);
          }
          break;
        case 'AVERAGE_SPEED': {
          const want = Math.max(0, Math.min(1, r.speed)) * b.air_speed_max;
          const sp = v.length();
          if (sp > 1e-6) steer.copy(v).multiplyScalar((want - sp) / sp);
          if (r.wander) steer.add(tmp.set(rand(i, 1) - 0.5, rand(i, 2) - 0.5, rand(i, 3) - 0.5).multiplyScalar(r.wander * b.air_speed_max));
          if (r.level) steer.z -= v.z * r.level;
          break;
        }
      }
      if (steer.lengthSq() < 1e-12) continue;
      if (b.ruleset_type === 'FUZZY') {
        // the first rules that ask strongly enough take precedence
        const strength = Math.min(1, steer.length() / maxAcc);
        out.addScaledVector(steer, budget);
        count++;
        if (strength > b.rule_fuzzy) budget *= 1 - strength;
        if (budget < 0.05) break;
      } else {
        out.add(steer);
        count++;
      }
    }
    if (b.ruleset_type === 'AVERAGE' && count) out.divideScalar(count);
    if (out.length() > maxAcc) out.setLength(maxAcc);
    acc[i * 3] = out.x;
    acc[i * 3 + 1] = out.y;
    acc[i * 3 + 2] = out.z;
  }
}

/** World positions and velocities (per second) of the objects the rules refer to. */
export function ruleObjects(doc: DocumentData, b: BoidSettings, at: (id: string, frame: number) => Vector3 | null, frame: number, fpsv: number) {
  const out = new Map<string, { p: Vector3; v: Vector3 }>();
  for (const r of b.rules) {
    if (!r.object || out.has(r.object) || !doc.objects[r.object]) continue;
    const p = at(r.object, frame),
      p0 = at(r.object, frame - 1);
    if (!p) continue;
    out.set(r.object, { p, v: p0 ? p.clone().sub(p0).multiplyScalar(fpsv) : new Vector3() });
  }
  return out;
}

/** Keep boids within the speed limits. */
export function clampSpeed(vel: Float32Array, i: number, min: number, max: number) {
  const sp = Math.hypot(vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2]);
  if (sp < 1e-9) return;
  const t = sp > max ? max / sp : sp < min ? min / sp : 1;
  if (t !== 1) {
    vel[i * 3] *= t;
    vel[i * 3 + 1] *= t;
    vel[i * 3 + 2] *= t;
  }
}
