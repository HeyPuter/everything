// Motion studies: an assembly's mechanism driven by motors over time.
//
// Each frame is a solve of the mates from the frame before (a warm start),
// with the motors as hard goals: a rotary motor turns its component by what
// its profile turns it in that frame, a linear motor moves it, a mate driver
// sets its mate's value. Coupling mates (gears, racks, screws) measure motion
// from the frame before, so their turns add up over the study. A frame that
// cannot be solved stops the study: a limit is reached, or the mechanism
// locks up (the motors ask for a motion the mates do not allow).
//
// Results come from the frames: positions of a point of a component, its
// turn, or what a mate measures, with velocities and accelerations by finite
// differences.

import type { Quat, Vec3 } from '../math/vec';
import { add, dot, len, normalize, qMul } from '../math/vec';
import type { MotionMotor, Placement } from '../model/assembly';
import type { Id } from '../model/types';
import {
  CONFLICT_TOL, type Drive, type Geo, MateSolver, type SolverBody, type SolverEntity, type SolverMate, applyPlacement, mateBodies, matesMoving, mateMeasure, placeGeo, quatRotVec,
} from './solver';

/** A motor ready to run: what it moves and its motion over time. */
export interface MotorInput {
  id: Id;
  name: string;
  kind: MotionMotor['kind'];
  /** Rotary and linear: the component moved, and the axis or direction entity (on it, or on another component). */
  body?: Id;
  entity?: SolverEntity;
  /** Mate driver: the mate whose value it sets. */
  mate?: Id;
  /** Rotary: the turn (radians); linear: the travel (mm), from the start of the study. Mate driver: the mate's value (mm or degrees). */
  at: (t: number) => number;
}

/** Numbers of a motor's profile, evaluated (degrees, mm, seconds, Hz). */
export interface ProfileValues {
  profile: MotionMotor['profile'];
  speed?: number;
  rpm?: boolean;
  amplitude?: number;
  frequency?: number;
  from?: number;
  to?: number;
  reverse?: boolean;
}

/**
 * A motor's motion over time. Rotary motors give radians, linear ones mm;
 * a mate driver gives its mate's value, starting from `base` (the value the
 * mate has) unless it ramps between two values.
 */
export function profileOf(kind: MotionMotor['kind'], p: ProfileValues, duration: number, base = 0): (t: number) => number {
  const sign = p.reverse ? -1 : 1;
  // Rotary values are in degrees (rpm for speeds when asked), turned into radians.
  const k = kind === 'rotary' ? Math.PI / 180 : 1;
  const speed = (p.speed ?? 0) * (kind === 'rotary' && p.rpm ? 6 : 1);
  if (p.profile === 'constant') return (t) => base + sign * k * speed * t;
  if (p.profile === 'oscillate') {
    const a = p.amplitude ?? 0, f = p.frequency ?? 0;
    return (t) => base + sign * k * a * Math.sin(2 * Math.PI * f * t);
  }
  const from = p.from ?? 0, to = p.to ?? 0;
  return (t) => from + ((to - from) * Math.min(1, Math.max(0, t / Math.max(duration, 1e-9))));
}

export interface MotionSetup {
  bodies: SolverBody[];
  /** The mates that hold (conflicting and broken ones left out). */
  mates: SolverMate[];
  motors: MotorInput[];
  duration: number;
  fps: number;
  /** The assembly's size (see SolveOptions.scale). */
  scale: number;
  /** Names of mates and motors, for the messages. */
  names?: Map<Id, string>;
}

export interface MotionStop {
  /** Seconds. */
  time: number;
  kind: 'limit' | 'locked';
  message: string;
  /** The mate whose limit was reached, or that could not hold. */
  mate?: Id;
}

export interface MotionResult {
  /** Seconds, one per frame computed. */
  times: number[];
  /** Placements of every component in each frame. */
  frames: Map<Id, Placement>[];
  /** Why the study stopped before its end, or null. */
  stop: MotionStop | null;
  /** The study's length (seconds), even when it stopped early. */
  duration: number;
}

/**
 * Steps a study frame by frame (so the caller can share the time: see
 * runMotion). The first frame is the assembly as it is.
 */
export class MotionRun {
  readonly count: number;
  readonly dt: number;
  readonly result: MotionResult;
  private k = 0;
  private solverMates: SolverMate[];

  constructor(private setup: MotionSetup) {
    this.count = Math.max(1, Math.round(setup.duration * setup.fps));
    this.dt = setup.duration / this.count;
    // Only what the motors move is solved: the mates of the components they drive and those linked to them.
    const moving = new Set<SolverMate>();
    for (const m of setup.motors) {
      const ids = m.body ? [m.body] : setup.mates.filter((x) => x.id === m.mate).flatMap(mateBodies);
      for (const id of ids) for (const x of matesMoving(id, setup.bodies, setup.mates)) moving.add(x);
    }
    this.solverMates = setup.mates.filter((x) => moving.has(x));
    const first = new Map(setup.bodies.map((b) => [b.id, b.placement]));
    this.result = { times: [0], frames: [first], stop: null, duration: setup.duration };
  }

  get done(): boolean {
    return this.k >= this.count || !!this.result.stop;
  }

  /** Frames computed so far, out of count + 1. */
  get progress(): number {
    return this.k / this.count;
  }

  /** Computes the next frame; false once the study is over (or stopped). */
  step(): boolean {
    if (this.done) return false;
    const s = this.setup;
    const t0 = this.k * this.dt, t1 = (this.k + 1) * this.dt;
    const prev = this.result.frames[this.result.frames.length - 1];
    const drives: Drive[] = [];
    let mates = this.solverMates;
    for (const m of s.motors) {
      if (m.kind === 'mate') {
        const v = m.at(t1);
        mates = mates.map((x) => (x.id === m.mate ? { ...x, value: v } : x));
        continue;
      }
      if (!m.body || !m.entity) continue;
      const g = placeGeo(m.entity.geo, m.entity.body ? prev.get(m.entity.body) ?? null : null);
      const dir = directionOf(g);
      if (!dir) continue;
      const amount = m.at(t1) - m.at(t0);
      if (m.kind === 'rotary') drives.push({ kind: 'rotate', body: m.body, axis: dir, amount });
      else {
        // A point of the moved component: the entity's, when it is on it.
        const local: Vec3 = m.entity.body === m.body ? pointOfGeo(m.entity.geo) ?? [0, 0, 0] : s.bodies.find((b) => b.id === m.body)?.center ?? [0, 0, 0];
        drives.push({ kind: 'translate', body: m.body, local, dir, amount });
      }
    }
    const bodies = s.bodies.map((b) => ({ ...b, placement: prev.get(b.id) ?? b.placement }));
    const solver = new MateSolver(bodies, mates);
    const r = solver.solve({ scale: s.scale, drives, maxIter: 80 });
    this.k++;
    if (!r.ok) {
      this.result.stop = this.whyStopped(solver, r.placements, prev, mates, r.residuals, t1);
      return false;
    }
    this.result.times.push(t1);
    this.result.frames.push(r.placements);
    return !this.done;
  }

  private whyStopped(solver: MateSolver, pl: Map<Id, Placement>, prev: Map<Id, Placement>, mates: SolverMate[], residuals: Map<Id, number>, t: number): MotionStop {
    const name = (id: Id) => this.setup.names?.get(id) ?? id;
    const time = Math.round(t * 1e4) / 1e4;
    // A limit reached: its one-sided row is what does not hold.
    for (const m of mates) {
      if (!(m.limit || m.type === 'slot')) continue;
      const all = solver.mateResidual(m, pl, this.setup.scale, prev, true) ?? [];
      const eq = solver.mateResidual(m, pl, this.setup.scale, prev, false) ?? [];
      if (Math.abs(all[all.length - 1] ?? 0) > CONFLICT_TOL && all.length > eq.length) {
        return { time, kind: 'limit', mate: m.id, message: `${name(m.id)} reached its limit at ${time} s: the motion stops there.` };
      }
    }
    let worst: Id | undefined, w = 0;
    for (const [id, v] of residuals) if (v > w) { w = v; worst = id; }
    const which = worst && w > CONFLICT_TOL ? ` (${name(worst)} cannot hold)` : '';
    return { time, kind: 'locked', mate: worst && w > CONFLICT_TOL ? worst : undefined, message: `The mechanism locks up at ${time} s${which}: the motors ask for a motion the mates do not allow.` };
  }
}

const directionOf = (g: Geo): Vec3 | null => (g.kind === 'plane' ? normalize(g.n) : g.kind === 'axis' || g.kind === 'line' ? normalize(g.d) : null);
const pointOfGeo = (g: Geo): Vec3 | null => (g.kind === 'plane' ? g.o : g.kind === 'axis' || g.kind === 'line' || g.kind === 'point' ? g.p : g.kind === 'sphere' ? g.c : null);

/** Runs a whole study at once (tests; the app runs it in slices, see AssemblyMode). */
export function computeMotion(setup: MotionSetup): MotionResult {
  const run = new MotionRun(setup);
  while (run.step());
  return run.result;
}

// ---------- results ----------

/** Where a point of a component (its local coordinates) is in each frame. */
export function pointPath(res: MotionResult, body: Id, local: Vec3): Vec3[] {
  return res.frames.map((f) => applyPlacement(f.get(body) ?? { p: [0, 0, 0], q: [0, 0, 0, 1] }, local));
}

/**
 * A component's turn in each frame as a rotation vector (radians) added up
 * frame by frame: about a fixed axis it is the axis times the whole angle,
 * past a full turn.
 */
export function turnPath(res: MotionResult, body: Id): Vec3[] {
  const out: Vec3[] = [];
  let acc: Vec3 = [0, 0, 0];
  let prev: Quat | null = null;
  for (const f of res.frames) {
    const q = f.get(body)?.q ?? [0, 0, 0, 1];
    if (prev) acc = add(acc, quatRotVec(qMul(q, [-prev[0], -prev[1], -prev[2], prev[3]])));
    out.push(acc);
    prev = q;
  }
  return out;
}

/** What a mate measures in each frame (degrees unwrapped past ±180°), or null when it measures nothing. */
export function mateSeries(res: MotionResult, mate: SolverMate, L = 100): { values: number[]; kind: 'length' | 'angle' } | null {
  const first = mateMeasure(mate, res.frames[0], L);
  if (!first) return null;
  const values: number[] = [];
  let last = first.value, acc = first.value;
  for (const f of res.frames) {
    const v = mateMeasure(mate, f, L)?.value ?? last;
    if (first.kind === 'angle' && mate.type === 'hinge') {
      let d = v - last;
      d -= 360 * Math.round(d / 360);
      acc += d;
    } else acc = v;
    last = v;
    values.push(acc);
  }
  return { values, kind: first.kind };
}

/** First and second derivatives of samples at times t (central differences; one-sided at the ends). */
export function derivatives(t: number[], v: number[]): { d1: number[]; d2: number[] } {
  const n = v.length;
  const d1 = new Array<number>(n).fill(0), d2 = new Array<number>(n).fill(0);
  if (n < 2) return { d1, d2 };
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    d1[i] = (v[b] - v[a]) / (t[b] - t[a] || 1);
  }
  if (n < 3) return { d1, d2 };
  for (let i = 0; i < n; i++) {
    const j = Math.min(n - 2, Math.max(1, i));
    const h1 = t[j] - t[j - 1], h2 = t[j + 1] - t[j];
    // Second difference on uneven steps (the last frame of a study can be shorter).
    d2[i] = (2 * ((v[j + 1] - v[j]) / h2 - (v[j] - v[j - 1]) / h1)) / (h1 + h2);
  }
  return { d1, d2 };
}

/** The magnitude of each vector. */
export const magnitudes = (vs: Vec3[]): number[] => vs.map(len);

/** Components and magnitude of vectors differentiated: the velocity or acceleration of a path. */
export function vectorDerivatives(t: number[], vs: Vec3[]): { d1: Vec3[]; d2: Vec3[] } {
  const axes = [0, 1, 2].map((k) => derivatives(t, vs.map((v) => v[k])));
  return { d1: vs.map((_, i) => [axes[0].d1[i], axes[1].d1[i], axes[2].d1[i]]), d2: vs.map((_, i) => [axes[0].d2[i], axes[1].d2[i], axes[2].d2[i]]) };
}

/** CSV of named columns (the first is the time). */
export function resultsCsv(columns: { name: string; values: number[] }[]): string {
  const n = Math.max(0, ...columns.map((c) => c.values.length));
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = [columns.map((c) => cell(c.name)).join(',')];
  for (let i = 0; i < n; i++) rows.push(columns.map((c) => (Number.isFinite(c.values[i]) ? String(Math.round(c.values[i] * 1e9) / 1e9) : '')).join(','));
  return rows.join('\n');
}

/** The angle (degrees) a turn path turns about a direction. */
export const degreesAbout = (path: Vec3[], axis: Vec3): number[] => path.map((v) => (dot(v, normalize(axis)) * 180) / Math.PI);
