// Boid particles: each particle steers by a list of rules (goal, avoid, avoid collisions, separate,
// flock, follow leader, average speed, fight) evaluated in order of the active state's rule set,
// flying (or walking on collision surfaces) within speed and acceleration limits. Boids of enemy
// target systems are attacked or fled from and wear down each other's health.
import { Vector3 } from 'three';
import type { DocumentData, ID } from '../data/types';
import type { ColliderMesh } from './colliders';
import { segmentHit, newHit } from './colliders';

export type BoidRuleType = 'GOAL' | 'AVOID' | 'AVOID_COLLISION' | 'SEPARATE' | 'FLOCK' | 'FOLLOW_LEADER' | 'AVERAGE_SPEED' | 'FIGHT';

export interface BoidRule {
  type: BoidRuleType;
  name: string;
  use_in_air: boolean;
  /** the rule also applies to boids walking on the ground */
  use_on_land?: boolean;
  /** avoid collision: avoid other boids / deflector surfaces */
  use_avoid?: boolean;
  use_avoid_collision?: boolean;
  /** follow leader: follow each other in lines of `queue_count` boids (0: one line) */
  use_line?: boolean;
  queue_count?: number;
  /** fight: distance to attack enemies from, and to flee from stronger enemies */
  flee_distance?: number;
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

export interface BoidState {
  name: string;
  rules: BoidRule[];
  active_boid_rule_index: number;
  rule_fuzzy: number;
  ruleset_type: 'FUZZY' | 'RANDOM' | 'AVERAGE';
  volume: number;
  falloff: number;
}

export interface BoidSettings {
  /** rules of a single state (older files); `states` replaces them once edited */
  rules: BoidRule[];
  active_rule_index: number;
  rule_fuzzy: number;
  ruleset_type: 'FUZZY' | 'RANDOM' | 'AVERAGE';
  states?: BoidState[];
  active_boid_state_index?: number;
  use_flight?: boolean;
  use_land?: boolean;
  use_climb?: boolean;
  air_ave_max?: number;
  land_speed_max?: number;
  land_jump_speed?: number;
  land_acc_max?: number;
  land_ave_max?: number;
  land_personal_space?: number;
  land_stick_force?: number;
  land_smooth?: number;
  health?: number;
  strength?: number;
  aggression?: number;
  accuracy?: number;
  bank?: number;
  pitch?: number;
  height?: number;
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
  ['FIGHT', 'Fight'],
];

export function newBoidRule(type: BoidRuleType): BoidRule {
  return {
    type,
    name: BOID_RULES.find(([t]) => t === type)?.[1] ?? type,
    use_in_air: true,
    use_on_land: true,
    object: null,
    use_predict: false,
    fear_factor: 1,
    look_ahead: 2,
    distance: type === 'FIGHT' ? 100 : 1,
    flee_distance: 100,
    speed: 0.5,
    wander: 0,
    level: 0,
    use_avoid: true,
    use_avoid_collision: true,
    use_line: false,
    queue_count: 0,
  };
}

export function newBoidState(name = 'State', rules: BoidRule[] = []): BoidState {
  return { name, rules, active_boid_rule_index: 0, rule_fuzzy: 0.5, ruleset_type: 'FUZZY', volume: 1, falloff: 0 };
}

export function defaultBoidSettings(): BoidSettings {
  return {
    rules: [newBoidRule('SEPARATE'), newBoidRule('FLOCK')],
    active_rule_index: 0,
    rule_fuzzy: 0.5,
    ruleset_type: 'FUZZY',
    air_speed_max: 10,
    air_speed_min: 0,
    air_acc_max: 0.5,
    air_ave_max: 0.5,
    air_personal_space: 1,
    range: 2,
    use_flight: true,
    use_land: false,
    use_climb: false,
    land_speed_max: 5,
    land_jump_speed: 0,
    land_acc_max: 0.5,
    land_ave_max: 0.5,
    land_personal_space: 1,
    land_stick_force: 1,
    land_smooth: 3,
    health: 1,
    strength: 0.1,
    aggression: 2,
    accuracy: 1,
    bank: 1,
    pitch: 1,
    height: 1,
  };
}

/** Move the rules of older files into a state list (in place) and return the states. */
export function ensureBoidStates(b: BoidSettings): BoidState[] {
  if (!b.states || !b.states.length) {
    const st = newBoidState('State', b.rules ?? []);
    st.active_boid_rule_index = b.active_rule_index ?? 0;
    st.rule_fuzzy = b.rule_fuzzy ?? 0.5;
    st.ruleset_type = b.ruleset_type ?? 'FUZZY';
    b.states = [st];
    b.active_boid_state_index = 0;
  }
  return b.states;
}

/** The state whose rules steer the boids. */
export function activeBoidState(b: BoidSettings): BoidState {
  if (b.states?.length) return b.states[Math.max(0, Math.min(b.states.length - 1, b.active_boid_state_index ?? 0))];
  return { name: 'State', rules: b.rules ?? [], active_boid_rule_index: b.active_rule_index ?? 0, rule_fuzzy: b.rule_fuzzy ?? 0.5, ruleset_type: b.ruleset_type ?? 'FUZZY', volume: 1, falloff: 0 };
}

/** Boids of another particle system: their positions and how they relate to these boids. */
export interface BoidOthers {
  pos: Float32Array;
  alive: Uint8Array;
  alliance: 'FRIEND' | 'NEUTRAL' | 'ENEMY';
  /** their attack strength (per second at full accuracy) and accuracy */
  strength: number;
  accuracy: number;
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

/** Extra per-step input: which boids walk on the ground, other systems' boids and own health. */
export interface BoidStepExtras {
  land?: Uint8Array | null;
  others?: BoidOthers[];
  health?: Float32Array | null;
}

/** Nearest boid of the given alliance within `r` (index into `others` and the particle), or null. */
function nearestOther(others: BoidOthers[], alliance: BoidOthers['alliance'], p: Vector3, r: number): { o: BoidOthers; j: number; d: number } | null {
  let best: { o: BoidOthers; j: number; d: number } | null = null;
  for (const o of others) {
    if (o.alliance !== alliance) continue;
    for (let j = 0; j < o.alive.length; j++) {
      if (!o.alive[j]) continue;
      const d = Math.hypot(o.pos[j * 3] - p.x, o.pos[j * 3 + 1] - p.y, o.pos[j * 3 + 2] - p.z);
      if (d < r && (!best || d < best.d)) best = { o, j, d };
    }
  }
  return best;
}

function countOthers(others: BoidOthers[], alliance: BoidOthers['alliance'], p: Vector3, r: number): number {
  let n = 0;
  for (const o of others) {
    if (o.alliance !== alliance) continue;
    for (let j = 0; j < o.alive.length; j++) if (o.alive[j] && Math.hypot(o.pos[j * 3] - p.x, o.pos[j * 3 + 1] - p.y, o.pos[j * 3 + 2] - p.z) < r) n++;
  }
  return n;
}

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
  extras: BoidStepExtras = {},
) {
  const state = activeBoidState(b);
  const landSpace = b.land_personal_space ?? 1;
  const range = Math.max(0.01, b.range, b.air_personal_space, landSpace);
  const grid = new NeighbourGrid(pos, range, alive, n);
  const airAcc = Math.max(0.001, b.air_acc_max) * Math.max(0.001, b.air_speed_max) * 4;
  const landAcc = Math.max(0.001, b.land_acc_max ?? 0.5) * Math.max(0.001, b.land_speed_max ?? 5) * 4;
  const others = extras.others ?? [];
  const steer = new Vector3(),
    out = new Vector3(),
    tmp = new Vector3(),
    v = new Vector3(),
    p = new Vector3();
  // follow-the-leader lines: the previous alive boid of the same line
  const prevInLine = new Int32Array(n).fill(-1);
  for (let i = 0, last = -1; i < n; i++) {
    if (!alive(i)) continue;
    prevInLine[i] = last;
    last = i;
  }
  for (let i = 0; i < n; i++) {
    acc[i * 3] = acc[i * 3 + 1] = acc[i * 3 + 2] = 0;
    if (!alive(i)) continue;
    const onLand = !!extras.land?.[i];
    const maxAcc = onLand ? landAcc : airAcc;
    const maxSpeed = onLand ? (b.land_speed_max ?? 5) : b.air_speed_max;
    const space = Math.max(0.01, onLand ? landSpace : b.air_personal_space);
    p.fromArray(pos, i * 3);
    v.fromArray(vel, i * 3);
    out.set(0, 0, 0);
    let budget = 1,
      count = 0;
    const rules = state.ruleset_type === 'RANDOM' && state.rules.length ? [state.rules[Math.floor(rand(i, 7) * state.rules.length) % state.rules.length]] : state.rules;
    for (const r of rules) {
      if (onLand ? r.use_on_land === false : !r.use_in_air) continue;
      steer.set(0, 0, 0);
      const target = r.object ? objects.get(r.object) : undefined;
      switch (r.type) {
        case 'GOAL':
          if (target) {
            tmp.copy(target.p);
            if (r.use_predict) tmp.addScaledVector(target.v, p.distanceTo(target.p) / Math.max(0.1, v.length()));
            steer.copy(tmp.sub(p)).normalize().multiplyScalar(maxSpeed).sub(v);
          } else {
            // without an object: chase the nearest enemy boid
            const e = nearestOther(others, 'ENEMY', p, Infinity);
            if (e) steer.set(e.o.pos[e.j * 3] - p.x, e.o.pos[e.j * 3 + 1] - p.y, e.o.pos[e.j * 3 + 2] - p.z).normalize().multiplyScalar(maxSpeed).sub(v);
          }
          break;
        case 'AVOID': {
          const fear = Math.max(0.01, r.fear_factor) * range * 2;
          if (target) {
            tmp.copy(target.p);
            if (r.use_predict) tmp.addScaledVector(target.v, p.distanceTo(target.p) / Math.max(0.1, v.length()));
          } else {
            // without an object: flee from enemy boids
            const e = nearestOther(others, 'ENEMY', p, fear);
            if (!e) break;
            tmp.set(e.o.pos[e.j * 3], e.o.pos[e.j * 3 + 1], e.o.pos[e.j * 3 + 2]);
          }
          const d = p.distanceTo(tmp);
          if (d < fear) steer.copy(p).sub(tmp).normalize().multiplyScalar(maxSpeed * (1 - d / fear)).sub(v).multiplyScalar(2);
          break;
        }
        case 'AVOID_COLLISION': {
          const look = Math.max(0.01, r.look_ahead);
          const ahead = look * v.length();
          if (r.use_avoid_collision !== false && cols.length && ahead > 1e-4) {
            tmp.copy(v).normalize();
            if (segmentHit(cols, p.x, p.y, p.z, p.x + tmp.x * ahead, p.y + tmp.y * ahead, p.z + tmp.z * ahead, hit)) {
              // turn along the surface, harder the closer the hit
              const nrm = new Vector3(hit.nx, hit.ny, hit.nz);
              if (nrm.dot(tmp) > 0) nrm.negate();
              steer.copy(nrm).multiplyScalar(maxSpeed * (1 - hit.dist) * 2);
            }
          }
          if (r.use_avoid !== false) {
            // other boids on a collision course within the look-ahead time
            let tBest = Infinity;
            const away = new Vector3();
            grid.each(i, range, (j, dx, dy, dz) => {
              const rvx = vel[j * 3] - v.x,
                rvy = vel[j * 3 + 1] - v.y,
                rvz = vel[j * 3 + 2] - v.z;
              const rv2 = rvx * rvx + rvy * rvy + rvz * rvz;
              if (rv2 < 1e-9) return;
              const t = -(dx * rvx + dy * rvy + dz * rvz) / rv2;
              if (t <= 0 || t > look || t >= tBest) return;
              const cx = dx + rvx * t,
                cy = dy + rvy * t,
                cz = dz + rvz * t;
              if (Math.hypot(cx, cy, cz) > space) return;
              tBest = t;
              away.set(-cx, -cy, -cz);
            });
            if (tBest < Infinity) steer.add(away.normalize().multiplyScalar(maxSpeed * (1 - tBest / look)));
          }
          break;
        }
        case 'SEPARATE': {
          grid.each(i, space, (_j, dx, dy, dz, d) => {
            if (d < 1e-6) return;
            steer.x -= (dx / d) * (space - d);
            steer.y -= (dy / d) * (space - d);
            steer.z -= (dz / d) * (space - d);
          });
          steer.multiplyScalar(maxSpeed);
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
        case 'FOLLOW_LEADER': {
          let lp: Vector3 | null = null,
            lv: Vector3 | null = null;
          const q = Math.max(0, Math.round(r.queue_count ?? 0));
          const head = !r.use_line || prevInLine[i] < 0 || (q > 0 && i % q === 0);
          if (!head) {
            const j = prevInLine[i];
            lp = new Vector3().fromArray(pos, j * 3);
            lv = new Vector3().fromArray(vel, j * 3);
          } else if (target) {
            lp = target.p;
            lv = target.v;
          }
          if (lp && lv) {
            const behind = lv.lengthSq() > 1e-8 ? lv.clone().normalize().multiplyScalar(-Math.max(0, r.distance)) : new Vector3();
            tmp.copy(lp).add(behind);
            steer.copy(tmp.sub(p)).multiplyScalar(2).sub(v);
          }
          break;
        }
        case 'AVERAGE_SPEED': {
          const want = Math.max(0, Math.min(1, r.speed)) * maxSpeed;
          const sp = v.length();
          if (sp > 1e-6) steer.copy(v).multiplyScalar((want - sp) / sp);
          if (r.wander) steer.add(tmp.set(rand(i, 1) - 0.5, rand(i, 2) - 0.5, rand(i, 3) - 0.5).multiplyScalar(r.wander * maxSpeed));
          if (r.level) steer.z -= v.z * r.level;
          break;
        }
        case 'FIGHT': {
          const e = nearestOther(others, 'ENEMY', p, Math.max(0, r.distance));
          if (!e) break;
          const ex = e.o.pos[e.j * 3] - p.x,
            ey = e.o.pos[e.j * 3 + 1] - p.y,
            ez = e.o.pos[e.j * 3 + 2] - p.z;
          // outnumbered (and hurt) boids flee, the others attack
          let friends = 1;
          grid.each(i, b.range, () => friends++);
          friends += countOthers(others, 'FRIEND', p, b.range);
          const enemies = countOthers(others, 'ENEMY', p, b.range);
          const hp = extras.health ? extras.health[i] / Math.max(1e-6, b.health ?? 1) : 1;
          const flee = enemies > friends * Math.max(0.01, b.aggression ?? 2) * hp && e.d < (r.flee_distance ?? 100);
          steer.set(ex, ey, ez).normalize().multiplyScalar(flee ? -maxSpeed : maxSpeed).sub(v);
          break;
        }
      }
      if (steer.lengthSq() < 1e-12) continue;
      if (state.ruleset_type === 'FUZZY') {
        // the first rules that ask strongly enough take precedence
        const strength = Math.min(1, steer.length() / maxAcc);
        out.addScaledVector(steer, budget);
        count++;
        if (strength > state.rule_fuzzy) budget *= 1 - strength;
        if (budget < 0.05) break;
      } else {
        out.add(steer);
        count++;
      }
    }
    if (state.ruleset_type === 'AVERAGE' && count) out.divideScalar(count);
    if (out.length() > maxAcc) out.setLength(maxAcc);
    acc[i * 3] = out.x;
    acc[i * 3 + 1] = out.y;
    acc[i * 3 + 2] = out.z;
  }
}

/** Health lost by each boid in one step from the enemy boids within the attack range. */
export function boidDamage(b: BoidSettings, pos: Float32Array, alive: (i: number) => boolean, n: number, others: BoidOthers[], dt: number, health: Float32Array) {
  const r = Math.max(0, b.range);
  for (let i = 0; i < n; i++) {
    if (!alive(i)) continue;
    const x = pos[i * 3],
      y = pos[i * 3 + 1],
      z = pos[i * 3 + 2];
    for (const o of others) {
      if (o.alliance !== 'ENEMY' || o.strength <= 0) continue;
      for (let j = 0; j < o.alive.length; j++) {
        if (!o.alive[j]) continue;
        if (Math.hypot(o.pos[j * 3] - x, o.pos[j * 3 + 1] - y, o.pos[j * 3 + 2] - z) < r) health[i] -= o.strength * Math.max(0, Math.min(1, o.accuracy)) * dt;
      }
    }
  }
}

/** World positions and velocities (per second) of the objects the rules refer to. */
export function ruleObjects(doc: DocumentData, b: BoidSettings, at: (id: string, frame: number) => Vector3 | null, frame: number, fpsv: number) {
  const out = new Map<string, { p: Vector3; v: Vector3 }>();
  for (const r of activeBoidState(b).rules) {
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
