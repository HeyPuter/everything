// Rigid-body mate solver for assemblies.
//
// Every floating component has six degrees of freedom: a translation and a
// rotation about its own centre. Mates are equations between the faces,
// edges and axes of two components (or an assembly plane) placed in the
// assembly; each is a short vector of residuals that is zero when the mate
// holds. The solver runs damped least squares (Levenberg-Marquardt) with
// Tikhonov damping, so a component that the mates leave free stays where it
// is (minimum-norm steps), and reports which components are fully defined,
// the degrees of freedom left (from the rank of the Jacobian) and which mates
// conflict (cannot hold together with the mates before them).
//
// Dragging adds soft goals (the grabbed point follows the cursor, or the
// component turns toward an orientation) that the mates override: a lid on a
// hinge pin turns about the pin as its edge is dragged.
//
// Limits (distance and angle mates kept between two values, a hinge's angle
// range, a slot's ends) are one-sided residuals: zero inside the range, the
// overshoot outside it. They take no degree of freedom away (the rank
// analysis leaves them out) but stop a drag at the limit.
//
// Gear, rack and pinion and screw mates relate motions, not positions: how
// far a component turned or slid since the start of the solve (the
// placements it started from), read from the solver's own rotation
// variables, so a single solve can turn them any amount (a rack pulled far
// in one pointer move, or moved by a mate's new value). Every solve starts
// where the last one ended (a drag step, a motion study frame, the document
// after a commit), so the turns add up: a gear driven round and round keeps
// its ratio past ±180°.

import type { Quat, Vec2, Vec3 } from '../math/vec';
import { add, cross, dot, len, normalize, perpendicular, qMul, qNormalize, qRotate, scale, sub } from '../math/vec';
import type { Id } from '../model/types';
import { type MateType, type Placement, isMechanical } from '../model/assembly';

/** Geometry of a mate entity, in the coordinates of its component (or the assembly for ground). */
export type Geo =
  | { kind: 'plane'; o: Vec3; n: Vec3 }
  /** Cylinder, cone or circular edge: a point on the axis, its direction and (cylinder, circle) radius. */
  | { kind: 'axis'; p: Vec3; d: Vec3; r: number; surface: 'cylinder' | 'cone' | 'circle' }
  | { kind: 'line'; p: Vec3; d: Vec3 }
  | { kind: 'point'; p: Vec3 }
  | { kind: 'sphere'; c: Vec3; r: number }
  /** A whole component (lock mates). */
  | { kind: 'body' }
  /** A cam's profile: a closed curve swept along d, in its plane (o, u, v): see camProfile. */
  | CamProfile;

/**
 * A cam's profile in the cam's coordinates. Followers touch its convex
 * outline: a circle, or a polygon (arcs divided at every degree, with the
 * corners) whose arcs are kept too, so contact on them is exact. `concave`:
 * how deep the profile dips inside that outline (zero when it is convex).
 */
export interface CamProfile {
  kind: 'profile';
  o: Vec3; d: Vec3; u: Vec3; v: Vec3;
  circle: { c: Vec2; r: number } | null;
  /** Counter-clockwise convex polygon (when not a circle): the arcs divided, with the corners. */
  hull: Vec2[];
  /** The arcs themselves (counter-clockwise from a0 by span), so contact on them is exact. */
  arcs: { c: Vec2; r: number; a0: number; span: number }[];
  concave: number;
}

export interface SolverEntity {
  /** The component the geometry belongs to; null for the assembly itself (its planes). */
  body: Id | null;
  geo: Geo;
}

export interface SolverMate {
  id: Id;
  type: MateType;
  a: SolverEntity;
  b: SolverEntity;
  aligned: boolean;
  /** Distance in mm, angle in degrees. */
  value: number;
  flip: boolean;
  /** Lock: b's placement in a's frame. Hinge: where b was in a's frame at 0° (for its limits). */
  rel?: Placement;
  /** Second entities: a hinge's coincident faces, a width mate's second groove and tab faces, a slot's second end. */
  a2?: SolverEntity;
  b2?: SolverEntity;
  /** Hinge: alignment of the coincident faces. */
  aligned2?: boolean;
  /** Distance (mm) or angle (degrees) range; a hinge's turn range (degrees). */
  limit?: { min: number; max: number };
  /** Gear: b's pitch diameter or part of the ratio (value is a's). */
  value2?: number;
  /** Rack and pinion: value is the travel per turn (not the pitch diameter). Universal joint: the axes meet at a joint point. */
  by?: 'ratio' | 'revolution' | 'point';
  /** Gear, rack and pinion: the other way round; screw: left-hand. */
  reverse?: boolean;
}

/**
 * A motor's motion over one solve (a motion study frame), from where the
 * component starts: a turn (radians) about a direction in the assembly, or a
 * move (mm) of a point of it along one.
 */
export type Drive =
  | { kind: 'rotate'; body: Id; axis: Vec3; amount: number }
  | { kind: 'translate'; body: Id; local: Vec3; dir: Vec3; amount: number }
  /**
   * A motor on a hinge or slider: body turns about `axis`, or its point
   * `local` moves along `dir`, relative to `base` (both in base's coordinates).
   */
  | { kind: 'relTurn'; body: Id; base: Id | null; axis: Vec3; amount: number }
  | { kind: 'relSlide'; body: Id; base: Id | null; local: Vec3; dir: Vec3; amount: number };

const driveBodies = (d: Drive): Id[] => (d.kind === 'relTurn' || d.kind === 'relSlide') && d.base ? [d.body, d.base] : [d.body];

export interface SolverBody {
  id: Id;
  fixed: boolean;
  placement: Placement;
  /** The component's centre in its own coordinates: it turns about this point. */
  center?: Vec3;
}

export type DragGoal =
  | { kind: 'move'; body: Id; local: Vec3; target: Vec3 }
  | { kind: 'rotate'; body: Id; q: Quat };

export interface SolveOptions {
  /** Characteristic length (mm) the residuals are measured against: the assembly's size. */
  scale?: number;
  maxIter?: number;
  drag?: DragGoal | null;
  /** Relative resistance of a body to moving (higher moves less). */
  weight?: (id: Id) => number;
  /** Motors: hard goals, held like mates. */
  drives?: Drive[];
}

export interface SolveResult {
  placements: Map<Id, Placement>;
  /** All mates hold. */
  ok: boolean;
  /** Largest residual of each mate (normalised), after solving. */
  residuals: Map<Id, number>;
  iterations: number;
  /** Largest residual of the drives (normalised). */
  driveResidual?: number;
}

/** 'error': a mate cannot be formed (its face is gone, or the entities do not fit its type); none conflict. */
export type DefinitionStatus = 'under' | 'full' | 'over' | 'error';

export interface AnalysisResult {
  status: DefinitionStatus;
  /** Remaining degrees of freedom of the floating components. */
  dof: number;
  /** Floating components every degree of freedom of which the mates fix. */
  defined: Set<Id>;
  /** Mates that cannot hold together with the mates before them. */
  conflicts: Set<Id>;
  /** Mates whose entities cannot be mated with that mate type. */
  invalid: Map<Id, string>;
  placements: Map<Id, Placement>;
}

const TOL = 1e-9;
/** How much more a drag resists turning a component than sliding it (see solve). */
const DRAG_TURN_RESISTANCE = 10;
/** A mate whose residual stays above this (relative to the assembly size) does not hold. */
export const CONFLICT_TOL = 1e-6;

// ---------- placements ----------

export function applyPlacement(pl: Placement, p: Vec3): Vec3 {
  return add(qRotate(pl.q, p), pl.p);
}

export function rotVecQuat(w: Vec3): Quat {
  const a = len(w);
  if (a < 1e-12) return qNormalize([w[0] / 2, w[1] / 2, w[2] / 2, 1]);
  const s = Math.sin(a / 2) / a;
  return [w[0] * s, w[1] * s, w[2] * s, Math.cos(a / 2)];
}

const qConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** The angle (radians, 0 to π) orientation q is turned from q0. */
export const turnAngle = (q: Quat, q0: Quat): number => {
  const d = qMul(q, qConj(q0));
  return 2 * Math.atan2(Math.hypot(d[0], d[1], d[2]), Math.abs(d[3]));
};

/** How far (radians, in (-π, π]) orientation q is turned from q0 about the unit direction d (both in the same frame). */
export function turnAbout(q: Quat, q0: Quat, d: Vec3): number {
  const dq = qMul(q, qConj(q0));
  const s = dq[3] < 0 ? -1 : 1;
  return 2 * Math.atan2(s * (dq[0] * d[0] + dq[1] * d[1] + dq[2] * d[2]), s * dq[3]);
}

const IDENT: Placement = { p: [0, 0, 0], q: [0, 0, 0, 1] };

/** The components a mate's entities belong to (each once). */
export function mateBodies(m: SolverMate): Id[] {
  // Most mates have one entity on each side (the hot path of every drag step).
  if (!m.a2 && !m.b2) return m.a.body ? (m.b.body && m.b.body !== m.a.body ? [m.a.body, m.b.body] : [m.a.body]) : m.b.body ? [m.b.body] : [];
  const out: Id[] = [];
  for (const e of [m.a, m.b, m.a2, m.b2]) if (e?.body && !out.includes(e.body)) out.push(e.body);
  return out;
}

/** Rotation vector (axis times angle) of a quaternion. */
export function quatRotVec(q: Quat): Vec3 {
  const s = q[3] < 0 ? -1 : 1;
  const v: Vec3 = [q[0] * s, q[1] * s, q[2] * s];
  const sin = len(v);
  if (sin < 1e-12) return scale(v, 2);
  const angle = 2 * Math.atan2(sin, q[3] * s);
  return scale(v, angle / sin);
}

/** Placement of b in a's frame. */
export function relativePlacement(a: Placement, b: Placement): Placement {
  const qa = qConj(a.q);
  return { p: qRotate(qa, sub(b.p, a.p)), q: qNormalize(qMul(qa, b.q)) };
}

export function composePlacement(a: Placement, rel: Placement): Placement {
  return { p: add(qRotate(a.q, rel.p), a.p), q: qNormalize(qMul(a.q, rel.q)) };
}

/** The geometry placed in the assembly. */
export function placeGeo(g: Geo, pl: Placement | null): Geo {
  if (!pl) return g;
  const pt = (p: Vec3) => applyPlacement(pl, p);
  const dir = (d: Vec3) => qRotate(pl.q, d);
  switch (g.kind) {
    case 'plane': return { kind: 'plane', o: pt(g.o), n: dir(g.n) };
    case 'axis': return { ...g, p: pt(g.p), d: dir(g.d) };
    case 'line': return { kind: 'line', p: pt(g.p), d: dir(g.d) };
    case 'point': return { kind: 'point', p: pt(g.p) };
    case 'sphere': return { kind: 'sphere', c: pt(g.c), r: g.r };
    default: return g;
  }
}

// ---------- mate equations ----------

const dirOf = (g: Geo): Vec3 | null => (g.kind === 'plane' ? g.n : g.kind === 'axis' || g.kind === 'line' ? g.d : null);
const pointOf = (g: Geo): Vec3 | null => (g.kind === 'plane' ? g.o : g.kind === 'axis' || g.kind === 'line' ? g.p : g.kind === 'point' ? g.p : g.kind === 'sphere' ? g.c : null);
const isAxisLike = (g: Geo) => g.kind === 'axis' || g.kind === 'line';
const isPointLike = (g: Geo) => g.kind === 'point' || g.kind === 'sphere' || (g.kind === 'axis' && g.surface === 'circle');
const isCylinder = (g: Geo): g is Extract<Geo, { kind: 'axis' }> => g.kind === 'axis' && g.surface !== 'cone';

/**
 * Why two entities cannot take a mate type, or null when they can. Also
 * what the mate panel uses to offer only the types that fit.
 */
export function mateProblem(type: MateType, a: Geo, b: Geo): string | null {
  return equations(type, a, b, { aligned: true, value: 1, flip: false, scale: 1 }, null, null) ? null : `${a.kind === 'body' || b.kind === 'body' ? 'Whole components' : `${describeGeo(a)} and ${describeGeo(b)}`} cannot take a ${type} mate`;
}

export function describeGeo(g: Geo): string {
  switch (g.kind) {
    case 'plane': return 'a plane';
    case 'axis': return g.surface === 'circle' ? 'a circular edge' : g.surface === 'cone' ? 'a cone' : 'a cylinder';
    case 'line': return 'a straight edge';
    case 'point': return 'a point';
    case 'sphere': return 'a sphere';
    default: return 'a component';
  }
}

/** The mate types two entities can take, most likely first. */
export function fittingMates(a: Geo, b: Geo): MateType[] {
  const all: MateType[] = ['coincident', 'concentric', 'distance', 'parallel', 'perpendicular', 'angle', 'tangent', 'lock'];
  const fit = all.filter((t) => !mateProblem(t, a, b));
  // Two round entities are first of all concentric; a plane and a cylinder tangent.
  const first = (isCylinder(a) || a.kind === 'sphere') && (isCylinder(b) || b.kind === 'sphere') ? 'concentric'
    : (a.kind === 'plane' && (isCylinder(b) || b.kind === 'sphere')) || (b.kind === 'plane' && (isCylinder(a) || a.kind === 'sphere')) ? 'tangent' : null;
  return first && fit.includes(first) ? [first, ...fit.filter((t) => t !== first)] : fit;
}

interface EqOpts { aligned: boolean; value: number; flip: boolean; scale: number; rel?: Placement }

/**
 * Residuals of a mate between two placed entities (lengths divided by the
 * assembly scale), or null when the entities cannot take that mate.
 * `pa`, `pb`: the placements of the two components (for lock mates).
 */
function equations(type: MateType, a: Geo, b: Geo, o: EqOpts, pa: Placement | null, pb: Placement | null, swapped = false): number[] | null {
  const L = o.scale;
  const s = o.flip ? -1 : 1;
  const match = (da: Vec3, db: Vec3) => (o.aligned ? sub(da, db) : add(da, db));
  // The same mate with the entities the other way round (once).
  const sw = () => (swapped ? null : equations(type, b, a, o, pb, pa, true));
  const div = (v: Vec3): number[] => [v[0] / L, v[1] / L, v[2] / L];
  if (type === 'lock') {
    if (a.kind !== 'body' || b.kind !== 'body' || !o.rel) return null;
    const A = pa ?? { p: [0, 0, 0], q: [0, 0, 0, 1] }, B = pb ?? { p: [0, 0, 0], q: [0, 0, 0, 1] };
    const rel = relativePlacement(A, B);
    const qe = qMul(qConj(o.rel.q), rel.q);
    const w = quatRotVec(qe);
    return [...div(sub(rel.p, o.rel.p)), w[0], w[1], w[2]];
  }
  if (a.kind === 'body' || b.kind === 'body') return null;
  switch (type) {
    case 'coincident': {
      if (a.kind === 'plane' && b.kind === 'plane') return [...match(a.n, b.n), dot(sub(b.o, a.o), a.n) / L];
      if (b.kind === 'plane') return sw();
      if (a.kind === 'plane') {
        if (b.kind === 'axis' && b.surface === 'circle') return [...cross(a.n, b.d), dot(sub(b.p, a.o), a.n) / L];
        if (isAxisLike(b)) return [dot(dirOf(b)!, a.n), dot(sub(pointOf(b)!, a.o), a.n) / L];
        return [dot(sub(pointOf(b)!, a.o), a.n) / L];
      }
      if (a.kind === 'axis' && a.surface === 'circle' && b.kind === 'axis' && b.surface === 'circle') return [...match(a.d, b.d), ...div(sub(a.p, b.p))];
      if (isAxisLike(a) && isAxisLike(b)) return [...match(dirOf(a)!, dirOf(b)!), ...div(cross(sub(pointOf(b)!, pointOf(a)!), dirOf(a)!))];
      if (isPointLike(a) && isPointLike(b)) return div(sub(pointOf(a)!, pointOf(b)!));
      if (isAxisLike(a)) return div(cross(sub(pointOf(b)!, pointOf(a)!), dirOf(a)!));
      if (isAxisLike(b)) return sw();
      return null;
    }
    case 'concentric': {
      if (a.kind === 'axis' && b.kind === 'axis') return [...match(a.d, b.d), ...div(cross(sub(b.p, a.p), a.d))];
      if (a.kind === 'sphere' && b.kind === 'sphere') return div(sub(a.c, b.c));
      if (a.kind === 'axis' && (b.kind === 'sphere' || b.kind === 'point')) return div(cross(sub(pointOf(b)!, a.p), a.d));
      if (b.kind === 'axis' && (a.kind === 'sphere' || a.kind === 'point')) return sw();
      return null;
    }
    case 'parallel': {
      const da = dirOf(a), db = dirOf(b);
      if (!da || !db) return null;
      if ((a.kind === 'plane') !== (b.kind === 'plane')) return [dot(da, db)];
      return match(da, db);
    }
    case 'perpendicular': {
      const da = dirOf(a), db = dirOf(b);
      if (!da || !db) return null;
      if ((a.kind === 'plane') !== (b.kind === 'plane')) return cross(da, db);
      return [dot(da, db)];
    }
    case 'angle': {
      const da = dirOf(a), db = dirOf(b);
      if (!da || !db) return null;
      const c = Math.cos((o.value * Math.PI) / 180);
      const t = o.aligned ? c : -c;
      // At 0° or 180° the angle is a parallel condition: written as one so its
      // gradient does not vanish where it holds (the DOF count would be wrong).
      if (Math.abs(Math.abs(t) - 1) < 1e-12) return t > 0 ? sub(da, db) : add(da, db);
      return [dot(da, db) - t];
    }
    case 'distance': {
      const D = o.value;
      if (a.kind === 'plane' && b.kind === 'plane') return [...match(a.n, b.n), (dot(sub(b.o, a.o), a.n) - s * D) / L];
      if (b.kind === 'plane') return sw();
      if (a.kind === 'plane') {
        if (isAxisLike(b) && !(b.kind === 'axis' && b.surface === 'circle')) return [dot(dirOf(b)!, a.n), (dot(sub(pointOf(b)!, a.o), a.n) - s * D) / L];
        const p = pointOf(b);
        return p ? [(dot(sub(p, a.o), a.n) - s * D) / L] : null;
      }
      // A zero distance is a coincidence: written as one, as a length's gradient vanishes at zero.
      const zero = Math.abs(D) < 1e-12;
      if (isPointLike(a) && isPointLike(b)) return zero ? div(sub(pointOf(a)!, pointOf(b)!)) : [(len(sub(pointOf(a)!, pointOf(b)!)) - D) / L];
      if (isAxisLike(a) && isAxisLike(b) && !isPointLike(a) && !isPointLike(b)) {
        const off = cross(sub(pointOf(b)!, pointOf(a)!), dirOf(a)!);
        return [...match(dirOf(a)!, dirOf(b)!), ...(zero ? div(off) : [(len(off) - D) / L])];
      }
      if (isAxisLike(a) && isPointLike(b)) {
        const off = cross(sub(pointOf(b)!, pointOf(a)!), dirOf(a)!);
        return zero ? div(off) : [(len(off) - D) / L];
      }
      if (isAxisLike(b) && isPointLike(a)) return sw();
      return null;
    }
    case 'tangent': {
      if (a.kind === 'plane' && isCylinder(b) && b.surface === 'cylinder') return [dot(b.d, a.n), (dot(sub(b.p, a.o), a.n) - s * b.r) / L];
      if (a.kind === 'plane' && b.kind === 'sphere') return [(dot(sub(b.c, a.o), a.n) - s * b.r) / L];
      if (b.kind === 'plane') return sw();
      if (a.kind === 'axis' && a.surface === 'cylinder' && b.kind === 'axis' && b.surface === 'cylinder') return [...match(a.d, b.d), (len(cross(sub(b.p, a.p), a.d)) - (a.r + b.r)) / L];
      if (a.kind === 'sphere' && b.kind === 'sphere') return [(len(sub(a.c, b.c)) - (a.r + b.r)) / L];
      if (a.kind === 'axis' && a.surface === 'cylinder' && b.kind === 'sphere') return [(len(cross(sub(b.c, a.p), a.d)) - (a.r + b.r)) / L];
      if (b.kind === 'axis' && a.kind === 'sphere') return sw();
      return null;
    }
  }
  return null;
}

/**
 * The alignment, side and value a new mate takes from where its entities
 * are now (as other CAD systems do), so adding it moves things least.
 */
export function initialMateSettings(type: MateType, a: Geo, b: Geo): { aligned: boolean; flip: boolean; value: number } {
  const da = dirOf(a), db = dirOf(b);
  const aligned = da && db ? dot(da, db) >= 0 : true;
  let flip = false, value = 0;
  if (type === 'distance' || type === 'tangent') {
    const plane = a.kind === 'plane' ? a : b.kind === 'plane' ? b : null;
    const other = plane === a ? b : a;
    const p = pointOf(other);
    if (plane && p) {
      const d = dot(sub(p, plane.o), plane.n);
      flip = d < 0;
      value = Math.abs(d);
    } else {
      const pa = pointOf(a), pb = pointOf(b);
      if (pa && pb) value = da && isAxisLike(a) && isAxisLike(b) ? len(cross(sub(pb, pa), normalize(da))) : len(sub(pa, pb));
    }
  }
  if (type === 'angle' && da && db) {
    const c = Math.max(-1, Math.min(1, dot(da, db)));
    value = (Math.acos(Math.abs(c)) * 180) / Math.PI;
    return { aligned: c >= 0, flip, value };
  }
  return { aligned, flip, value };
}

// ---------- limits ----------

/**
 * A distance mate's conditions apart from the distance (parallel faces...)
 * and the distance it measures (signed for a plane: on the flipped side it
 * is the distance below), or null when the entities cannot take one.
 */
export function distanceParts(a: Geo, b: Geo, o: { aligned: boolean; flip: boolean; scale: number }, swapped = false): { eq: number[]; d: number } | null {
  const s = o.flip ? -1 : 1;
  const match = (da: Vec3, db: Vec3) => (o.aligned ? sub(da, db) : add(da, db));
  const sw = () => (swapped ? null : distanceParts(b, a, o, true));
  if (a.kind === 'body' || b.kind === 'body') return null;
  if (a.kind === 'plane' && b.kind === 'plane') return { eq: match(a.n, b.n), d: s * dot(sub(b.o, a.o), a.n) };
  if (b.kind === 'plane') return sw();
  if (a.kind === 'plane') {
    const p = pointOf(b);
    if (!p) return null;
    const eq = isAxisLike(b) && !(b.kind === 'axis' && b.surface === 'circle') ? [dot(dirOf(b)!, a.n)] : [];
    return { eq, d: s * dot(sub(p, a.o), a.n) };
  }
  if (isPointLike(a) && isPointLike(b)) return { eq: [], d: len(sub(pointOf(a)!, pointOf(b)!)) };
  if (isAxisLike(a) && isAxisLike(b) && !isPointLike(a) && !isPointLike(b)) return { eq: match(dirOf(a)!, dirOf(b)!), d: len(cross(sub(pointOf(b)!, pointOf(a)!), dirOf(a)!)) };
  if (isAxisLike(a) && isPointLike(b)) return { eq: [], d: len(cross(sub(pointOf(b)!, pointOf(a)!), dirOf(a)!)) };
  if (isAxisLike(b) && isPointLike(a)) return sw();
  return null;
}

/** The angle (degrees, 0 to 180) between two entities' directions, measured as an angle mate with that alignment does. */
export function angleOf(a: Geo, b: Geo, aligned: boolean): number | null {
  const da = dirOf(a), db = dirOf(b);
  if (!da || !db) return null;
  return (Math.acos(Math.max(-1, Math.min(1, (aligned ? 1 : -1) * dot(da, db)))) * 180) / Math.PI;
}

/** The overshoot of v past [min, max] (zero inside). */
const outside = (v: number, min: number, max: number) => (v > max ? v - max : v < min ? v - min : 0);

/**
 * The overshoot of a turn t (radians, in (-π, π]) past [min, max], read on
 * the circle: a hinge kept between 0° and 270° is inside at 190° (which
 * reads as -170°), and past the nearer end outside the range.
 */
function outsideTurn(t: number, min: number, max: number): number {
  const full = 2 * Math.PI;
  if (max - min >= full) return 0;
  const u = min + ((((t - min) % full) + full) % full);
  if (u <= max) return 0;
  const over = u - max, under = u - (min + full);
  return over <= -under ? over : under;
}

/** A distance or angle mate kept between limits: its other conditions, and the overshoot (when `ineq`). */
function limitEquations(type: 'distance' | 'angle', a: Geo, b: Geo, o: EqOpts, lim: { min: number; max: number }, ineq: boolean): number[] | null {
  if (type === 'angle') {
    const da = dirOf(a), db = dirOf(b);
    if (!da || !db || a.kind === 'body' || b.kind === 'body') return null;
    // On the cosine (smooth where the angle is 0° or 180°): cos falls as the angle grows.
    const c = (o.aligned ? 1 : -1) * dot(da, db);
    return ineq ? [outside(c, Math.cos((lim.max * Math.PI) / 180), Math.cos((lim.min * Math.PI) / 180))] : [];
  }
  const d = distanceParts(a, b, o);
  if (!d) return null;
  return [...d.eq, ...(ineq ? [outside(d.d, lim.min, lim.max) / o.scale] : [])];
}

// ---------- mechanical mates ----------

/** The entities of a mechanical mate placed in the assembly, with the placements of their components now and at the start of the solve. */
interface MechContext {
  m: SolverMate;
  ga: Geo; gb: Geo; ga2: Geo | null; gb2: Geo | null;
  pa: Placement; pb: Placement; ra: Placement; rb: Placement;
  /** Placement of an entity's component, now and at the start. */
  now: (e: SolverEntity) => Placement;
  start: (e: SolverEntity) => Placement;
  /** How far an entity's component turned about a direction (in the assembly) since the start, in radians. */
  turned: (e: SolverEntity, d: Vec3) => number;
  L: number;
  ineq: boolean;
}

/** A hinge's turn (radians) from where it was at 0° (rel), about a's axis. */
function hingeTurn(m: SolverMate, pa: Placement, pb: Placement): number | null {
  if (!m.rel || m.a.geo.kind !== 'axis') return null;
  const rel = relativePlacement(pa, pb);
  return turnAbout(rel.q, m.rel.q, normalize(m.a.geo.d));
}

/**
 * Rack and pinion: which way the rack moves as the pinion turns forward,
 * from where the rack is beside the pinion (its teeth move with the pinion's
 * near side).
 */
function rackSense(dp: Vec3, cp: Vec3, u: Vec3, pr: Vec3): number {
  const w = sub(pr, cp);
  const n = sub(sub(w, scale(dp, dot(w, dp))), scale(u, dot(w, u)));
  const s = dot(cross(dp, n), u);
  return s < 0 ? -1 : 1;
}

function mechanicalEquations(c: MechContext): number[] | null {
  const { m, ga, gb, ga2, gb2, L } = c;
  const o = { aligned: m.aligned, value: m.value, flip: m.flip, scale: L };
  switch (m.type) {
    case 'hinge': {
      if (!ga2 || !gb2) return null;
      const conc = equations('concentric', ga, gb, o, null, null), plane = equations('coincident', ga2, gb2, { ...o, aligned: !!m.aligned2 }, null, null);
      if (!conc || !plane || ga.kind !== 'axis' || gb.kind !== 'axis' || ga2.kind !== 'plane' || gb2.kind !== 'plane') return null;
      if (!m.limit) return [...conc, ...plane];
      const t = hingeTurn(m, c.pa, c.pb);
      if (t === null) return null;
      return [...conc, ...plane, ...(c.ineq ? [outsideTurn(t, (m.limit.min * Math.PI) / 180, (m.limit.max * Math.PI) / 180)] : [])];
    }
    case 'gear': {
      if (!isAxisLike(ga) || !isAxisLike(gb) || !m.a.body || !m.b.body) return null;
      const da = normalize(dirOf(ga)!), db0 = normalize(dirOf(gb)!);
      // Parallel axes turn about the same direction: external gears turn opposite ways.
      const db = dot(da, db0) < 0 ? scale(db0, -1) : db0;
      const ta = c.turned(m.a, da), tb = c.turned(m.b, db);
      const va = m.value, vb = m.value2 ?? 0;
      if (!(va > 0) || !(vb > 0)) return null;
      return [(va * ta + (m.reverse ? -1 : 1) * vb * tb) / Math.max(va, vb)];
    }
    case 'rackPinion': {
      // a: the pinion (an axis), b: the rack (a straight edge, along which it moves).
      if (!isAxisLike(ga) || gb.kind !== 'line' || m.b.geo.kind !== 'line' || !(m.value > 0)) return null;
      const dp = normalize(dirOf(ga)!), u = normalize(gb.d);
      const turn = m.a.body ? c.turned(m.a, dp) : 0;
      const local = m.b.geo.p;
      const moved = dot(sub(applyPlacement(c.pb, local), applyPlacement(c.rb, local)), u);
      const sense = rackSense(placeGeoDir(m.a.geo, c.ra), pointOf(placeGeo(m.a.geo, c.ra))!, normalize(qRotate(c.rb.q, m.b.geo.d)), applyPlacement(c.rb, local));
      const perRadian = m.by === 'revolution' ? m.value / (2 * Math.PI) : m.value / 2;
      return [(moved - (m.reverse ? -1 : 1) * sense * perRadian * turn) / L];
    }
    case 'screw': {
      const conc = equations('concentric', ga, gb, o, null, null);
      if (!conc || ga.kind !== 'axis' || gb.kind !== 'axis' || m.a.geo.kind !== 'axis' || m.b.geo.kind !== 'axis' || !m.value) return null;
      // b's turn and travel along a's axis, in a's frame (a nut on a screw that itself moves).
      const dl = normalize(m.a.geo.d);
      const rel = relativePlacement(c.pa, c.pb), rel0 = relativePlacement(c.ra, c.rb);
      const dw = normalize(qRotate(c.pa.q, dl));
      const turn = c.turned(m.b, dw) - c.turned(m.a, dw);
      const travel = dot(sub(applyPlacement(rel, m.b.geo.p), applyPlacement(rel0, m.b.geo.p)), dl);
      return [...conc, (travel - ((m.reverse ? -1 : 1) * m.value * turn) / (2 * Math.PI)) / L];
    }
    case 'width': {
      if (!ga2 || !gb2 || ga.kind !== 'plane' || gb.kind !== 'plane' || ga2.kind !== 'plane' || gb2.kind !== 'plane') return null;
      // The tab's mid plane on the groove's: parallel, and centred.
      const mid = (p: Vec3, q: Vec3) => scale(add(p, q), 0.5);
      return [...cross(ga.n, gb.n), dot(sub(mid(gb.o, gb2.o), mid(ga.o, ga2.o)), ga.n) / L];
    }
    case 'slider': {
      if (!m.rel) return null;
      const rel = relativePlacement(c.pa, c.pb);
      let rows: number[] | null, dir: Vec3 | null;
      if (!ga2 || !gb2) {
        // Axes or straight edges: on one line, and no turn about it from where it was added.
        if (!isAxisLike(ga) || !isAxisLike(gb) || !isAxisLike(m.a.geo)) return null;
        dir = normalize(dirOf(m.a.geo)!);
        const da = normalize(dirOf(ga)!), db = normalize(dirOf(gb)!);
        rows = [...(m.aligned ? sub(da, db) : add(da, db)), ...scale(cross(sub(pointOf(gb)!, pointOf(ga)!), da), 1 / L), turnAbout(rel.q, m.rel.q, dir)];
      } else {
        // Two pairs of faces flush: they slide along the line where the faces meet.
        const p1 = equations('coincident', ga, gb, o, null, null), p2 = equations('coincident', ga2, gb2, { ...o, aligned: !!m.aligned2 }, null, null);
        if (!p1 || !p2 || m.a.geo.kind !== 'plane' || m.a2?.geo.kind !== 'plane') return null;
        dir = normalize(cross(m.a.geo.n, m.a2.geo.n));
        rows = [...p1, ...p2];
      }
      if (!m.limit) return rows;
      return [...rows, ...(c.ineq ? [outside(sliderTravel(m, rel, dir), m.limit.min, m.limit.max) / L] : [])];
    }
    case 'cam': {
      const prof = m.a.geo;
      if (prof.kind !== 'profile') return null;
      // The follower in the cam's coordinates, then in its profile's plane.
      const qi: Quat = [-c.pa.q[0], -c.pa.q[1], -c.pa.q[2], c.pa.q[3]];
      const local = (p: Vec3) => qRotate(qi, sub(p, c.pa.p));
      const in2 = (p: Vec3): Vec2 => { const w = sub(local(p), prof.o); return [dot(w, prof.u), dot(w, prof.v)]; };
      if (gb.kind === 'point') return [profileDistance(prof, in2(gb.p)) / L];
      if (gb.kind === 'sphere') return [(profileDistance(prof, in2(gb.c)) - gb.r) / L];
      if (gb.kind === 'axis') return [(profileDistance(prof, in2(gb.p)) - gb.r) / L];
      if (gb.kind === 'plane') {
        // A flat face touches the cam where the cam reaches furthest toward it (the cam on its outer side).
        const n = qRotate(qi, scale(gb.n, m.flip ? -1 : 1));
        const n2: Vec2 = [dot(n, prof.u), dot(n, prof.v)];
        const nl = Math.hypot(n2[0], n2[1]);
        if (nl < 1e-9) return null;
        const u2: Vec2 = [n2[0] / nl, n2[1] / nl];
        const o2 = in2(gb.o);
        return [(-profileSupport(prof, [-u2[0], -u2[1]]) - (o2[0] * u2[0] + o2[1] * u2[1])) / L];
      }
      return null;
    }
    case 'universal': {
      if (!m.rel || !isAxisLike(ga) || !isAxisLike(gb) || !m.a.body || !m.b.body) return null;
      const y = yokes(m);
      if (!y) return null;
      // The cross piece holds the two yokes square to each other.
      const rows = [dot(qRotate(c.pa.q, y.a), qRotate(c.pb.q, y.b))];
      if (m.by !== 'point') return rows;
      // The axes meet at the joint point, `value` along a's axis.
      const j = applyPlacement(c.pa, add(pointOf(m.a.geo)!, scale(normalize(dirOf(m.a.geo)!), m.value)));
      return [...rows, ...scale(cross(sub(j, pointOf(gb)!), normalize(dirOf(gb)!)), 1 / L)];
    }
    case 'slot': {
      if (!ga2 || !isAxisLike(ga) || !isAxisLike(ga2)) return null;
      const da = normalize(dirOf(ga)!), p1 = pointOf(ga)!, w = sub(pointOf(ga2)!, p1);
      const along = sub(w, scale(da, dot(w, da)));
      const length = len(along);
      const pb = pointOf(gb);
      if (length < 1e-9 || !pb) return null;
      const u = scale(along, 1 / length), ns = cross(da, u);
      const off = sub(pb, p1);
      // An axis (a pin) stays parallel to the slot's ends; it, or a point, stays on the plane through them, between the ends.
      const par = gb.kind === 'axis' || gb.kind === 'line' ? cross(da, normalize(dirOf(gb)!)) : [];
      return [...par, dot(off, ns) / L, ...(c.ineq ? [outside(dot(off, u), 0, length) / L] : [])];
    }
  }
  return null;
}

const placeGeoDir = (g: Geo, pl: Placement): Vec3 => normalize(qRotate(pl.q, dirOf(g) ?? [0, 0, 1]));

/** A slider's travel (mm) from where it was added: b's entity along the slide, in a's coordinates. */
function sliderTravel(m: SolverMate, rel: Placement, dir: Vec3): number {
  const p = pointOf(m.b.geo) ?? [0, 0, 0];
  return dot(sub(applyPlacement(rel, p), applyPlacement(m.rel!, p)), dir);
}

/** The direction a slider slides, in a's coordinates. */
export function sliderDirection(m: SolverMate): Vec3 | null {
  if (m.a2?.geo.kind === 'plane' && m.a.geo.kind === 'plane') { const d = cross(m.a.geo.n, m.a2.geo.n); return len(d) > 1e-9 ? normalize(d) : null; }
  const d = dirOf(m.a.geo);
  return d ? normalize(d) : null;
}

/**
 * The yokes of a universal joint, each in its shaft's coordinates: a's in
 * the plane of the two axes where the joint was added, b's square to it and
 * to b's axis. Measured from there, b turns by atan(tan φ / cos β) as a
 * turns by φ (β the angle between the axes).
 */
function yokes(m: SolverMate): { a: Vec3; b: Vec3 } | null {
  const da = dirOf(m.a.geo), db = dirOf(m.b.geo);
  if (!da || !db || !m.rel) return null;
  const a = normalize(da);
  const bInA = normalize(qRotate(m.rel.q, db));
  const off = sub(bInA, scale(a, dot(bInA, a)));
  const ya = len(off) > 1e-9 ? normalize(off) : perpendicular(a);
  const yb = normalize(cross(bInA, ya));
  return { a: ya, b: qRotate([-m.rel.q[0], -m.rel.q[1], -m.rel.q[2], m.rel.q[3]], yb) };
}

// ---------- cam profiles ----------

/** A circular arc of a cam's profile: centre and radius, and (unless it is a whole circle) its ends and a point between them. */
export interface ProfileArc { c: Vec3; r: number; ends?: [Vec3, Vec3, Vec3] }

/**
 * A cam's profile from its round faces (arcs about axes along d) and the
 * corners of its other faces (points), all in the cam's coordinates. A
 * single whole circle stays a circle; otherwise the outline is the convex
 * hull of the arcs (divided at every degree) and the points, the arcs kept
 * for exact contact. Where the profile lies inside that outline it is
 * concave, and `concave` says by how much.
 */
export function camProfile(d0: Vec3, arcs: ProfileArc[], points: Vec3[]): CamProfile {
  const d = normalize(d0);
  const u = perpendicular(d), v = cross(d, u);
  const o = arcs[0]?.c ?? points[0] ?? [0, 0, 0];
  const in2 = (p: Vec3): Vec2 => { const w = sub(p, o); return [dot(w, u), dot(w, v)]; };
  const base = { kind: 'profile' as const, o, d, u, v };
  const whole = arcs.filter((a) => !a.ends);
  if (arcs.length === 1 && whole.length === 1) {
    const c = in2(whole[0].c), r = whole[0].r;
    // Corners of other faces on the circle (its caps' edges, say) change nothing.
    if (points.every((p) => Math.abs(Math.hypot(in2(p)[0] - c[0], in2(p)[1] - c[1]) - r) < 1e-6 * Math.max(1, r))) return { ...base, circle: { c, r }, hull: [], arcs: [], concave: 0 };
  }
  const pts: Vec2[] = points.map(in2);
  const exact: CamProfile['arcs'] = [];
  for (const a of arcs) {
    const c = in2(a.c);
    const ang = (p: Vec3) => { const q = in2(p); return Math.atan2(q[1] - c[1], q[0] - c[0]); };
    let a0 = 0, sweep = 2 * Math.PI;
    if (a.ends) {
      // From one end through the middle point to the other.
      a0 = ang(a.ends[0]);
      const am = ang(a.ends[2]), a1 = ang(a.ends[1]);
      const ccw = (x: number) => ((x - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      sweep = ccw(am) <= ccw(a1) ? ccw(a1) : ccw(a1) - 2 * Math.PI;
    }
    exact.push({ c, r: a.r, a0: sweep >= 0 ? a0 : a0 + sweep, span: Math.abs(sweep) });
    const n = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 180)));
    for (let k = 0; k <= n; k++) { const t = a0 + (sweep * k) / n; pts.push([c[0] + a.r * Math.cos(t), c[1] + a.r * Math.sin(t)]); }
  }
  const hull = convexHull(pts);
  let concave = 0;
  for (const p of pts) concave = Math.max(concave, -polygonDistance(hull, p));
  return { ...base, circle: null, hull, arcs: exact, concave };
}

/** Whether the direction of w lies on an arc (counter-clockwise from a0 by span). */
const onArc = (a: CamProfile['arcs'][number], w: Vec2) => (((Math.atan2(w[1], w[0]) - a.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) <= a.span + 1e-12;

/** Counter-clockwise convex hull (monotone chain). */
function convexHull(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const turn = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [], upper: Vec2[] = [];
  for (const x of p) { while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], x) <= 1e-12) lower.pop(); lower.push(x); }
  for (let i = p.length - 1; i >= 0; i--) { const x = p[i]; while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], x) <= 1e-12) upper.pop(); upper.push(x); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Signed distance from a point to a convex polygon (negative inside). */
function polygonDistance(h: Vec2[], x: Vec2): number {
  let inside = true, best = Infinity, depth = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey || 1;
    const wx = x[0] - a[0], wy = x[1] - a[1];
    const side = (ex * wy - ey * wx) / Math.sqrt(l2);
    if (side < 0) inside = false;
    depth = Math.min(depth, side);
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / l2));
    best = Math.min(best, Math.hypot(wx - t * ex, wy - t * ey));
  }
  return inside ? -depth : best;
}

/** Signed distance from a point in the profile's plane to its outline. */
export function profileDistance(p: CamProfile, x: Vec2): number {
  if (p.circle) return Math.hypot(x[0] - p.circle.c[0], x[1] - p.circle.c[1]) - p.circle.r;
  const poly = polygonDistance(p.hull, x);
  // The arcs a point faces give its exact distance; the polygon's chords lie a little inside them.
  let out = Infinity, inside = -Infinity;
  for (const a of p.arcs) {
    const w: Vec2 = [x[0] - a.c[0], x[1] - a.c[1]];
    if (!onArc(a, w)) continue;
    const d = Math.hypot(w[0], w[1]) - a.r;
    out = Math.min(out, d);
    inside = Math.max(inside, d);
  }
  // Outside (or between a chord and its arc): the nearest of the edges and arcs, none nearer than the outline.
  if (poly >= 0) return Math.min(poly, out);
  // Inside, near an arc (no deeper than the sag of its chords, 1° apart): the arc's.
  return inside >= poly - 4e-5 * Math.max(1, ...p.arcs.map((a) => a.r)) ? inside : poly;
}

/** How far the outline reaches along a unit direction (its support function). */
export function profileSupport(p: CamProfile, u: Vec2): number {
  if (p.circle) return p.circle.c[0] * u[0] + p.circle.c[1] * u[1] + p.circle.r;
  let best = -Infinity;
  for (const q of p.hull) best = Math.max(best, q[0] * u[0] + q[1] * u[1]);
  for (const a of p.arcs) if (onArc(a, u)) best = Math.max(best, a.c[0] * u[0] + a.c[1] * u[1] + a.r);
  return best;
}

/** Why the entities (and values) of a mechanical mate do not make one, or null when they do. */
export function mechanicalProblem(m: Pick<SolverMate, 'type' | 'a' | 'b' | 'a2' | 'b2' | 'value' | 'value2' | 'limit' | 'rel'>): string | null {
  const { a, b, a2, b2 } = m;
  const axis = (e?: SolverEntity) => !!e && (e.geo.kind === 'axis' || e.geo.kind === 'line');
  const round = (e?: SolverEntity) => !!e && e.geo.kind === 'axis';
  const plane = (e?: SolverEntity) => !!e && e.geo.kind === 'plane';
  const parallel = (x: SolverEntity, y: SolverEntity) => x.body === y.body && Math.abs(dot(normalize(dirOf(x.geo)!), normalize(dirOf(y.geo)!))) > 0.9999;
  switch (m.type) {
    case 'slider':
      if (!a.body && !b.body) return 'A slider needs a component';
      if (!m.rel) return 'The slider has no stored position';
      if (a2 || b2) {
        if (!plane(a) || !plane(a2) || !plane(b) || !plane(b2)) return 'A slider needs a straight edge or axis on each component, or two planar faces on each';
        if (a2!.body !== a.body || b2!.body !== b.body) return 'Each component\'s two faces must be faces of that component';
        if (Math.abs(dot(normalize(dirOf(a.geo)!), normalize(dirOf(a2!.geo)!))) > 0.999) return 'The two faces on each component must not be parallel (the slider moves along the line where they meet)';
      } else if (!axis(a) || !axis(b)) return 'A slider needs a straight edge or axis on each component, or two planar faces on each';
      return m.limit && !(m.limit.min <= m.limit.max) ? 'The smallest travel must not be more than the largest' : null;
    case 'cam': {
      if (a.geo.kind !== 'profile') return 'A cam mate needs the faces of the cam\'s profile and a follower';
      if (!a.body || a.body === b.body) return 'The cam and the follower must be different components';
      if (!['point', 'sphere', 'axis', 'plane'].includes(b.geo.kind)) return 'The follower must be a vertex, a round face or edge (a roller) or a planar face';
      const size = a.geo.circle ? a.geo.circle.r : Math.max(1, ...a.geo.hull.map((q) => Math.hypot(q[0], q[1])));
      if (a.geo.concave > 1e-6 * Math.max(1, size)) return `The cam's profile has a hollow ${Math.round(a.geo.concave * 1000) / 1000} mm deep: a follower cannot stay in contact there. Cam mates follow convex profiles (an eccentric, lobes and flats).`;
      return b.geo.kind === 'plane' && Math.abs(dot(normalize(b.geo.n), a.geo.d)) > 0.999 ? 'The flat follower face must face the cam across its axis, not along it' : null;
    }
    case 'universal':
      if (!axis(a) || !axis(b) || !a.body || !b.body) return 'A universal joint needs a round face or edge (or an axis) on each of two shafts';
      if (!m.rel) return 'The universal joint has no stored position';
      // Square to each other the yokes cannot both cross the shafts' plane: such a joint cannot turn.
      return Math.abs(dot(normalize(dirOf(a.geo)!), normalize(qRotate(m.rel.q, dirOf(b.geo)!)))) < 1e-3 ? 'The shafts of a universal joint must not be at 90° to each other (it cannot turn there)' : null;
    case 'hinge':
      if (!round(a) || !round(b) || !plane(a2) || !plane(b2)) return 'A hinge needs two round faces or edges (the pin and its hole) and two planar faces that touch';
      if (a2!.body !== a.body || b2!.body !== b.body) return 'Each planar face of a hinge must be on the component of the round entity selected with it';
      if (m.limit && !(m.limit.min <= m.limit.max)) return 'The smallest angle must not be more than the largest';
      return null;
    case 'gear':
      if (!axis(a) || !axis(b) || !a.body || !b.body) return 'A gear mate needs a round face or edge (or an axis) on each of two components';
      return m.value > 0 && (m.value2 ?? 0) > 0 ? null : 'The gear values must be more than zero';
    case 'rackPinion':
      if (!round(a) || b.geo.kind !== 'line' || !b.body) return 'A rack and pinion mate needs a straight edge of the rack and a round face or edge of the pinion';
      return m.value > 0 ? null : 'The pitch diameter (or travel per turn) must be more than zero';
    case 'screw':
      if (!round(a) || !round(b) || !a.body || !b.body) return 'A screw mate needs a round face or edge on each of two components';
      return m.value ? null : 'The pitch must not be zero';
    case 'width':
      if (!plane(a) || !plane(a2) || !plane(b) || !plane(b2)) return 'A width mate needs two planar faces of the groove and two of the tab';
      if (!parallel(a, a2!) || !parallel(b, b2!)) return 'The two groove faces (and the two tab faces) must be parallel faces of one component';
      return a.body === b.body ? 'The groove and the tab must be on different components' : null;
    case 'slot':
      if (!round(a) || !round(a2)) return 'A slot mate needs the two round ends of the slot and a pin (a round face or edge, an axis or a point)';
      if (!parallel(a, a2!)) return 'The two ends must be on the same component, and parallel';
      if (len(cross(sub(pointOf(a2!.geo)!, pointOf(a.geo)!), normalize(dirOf(a.geo)!))) < 1e-6) return 'Select the two ends of the slot (they are the same axis)';
      if (b.geo.kind === 'plane' || b.geo.kind === 'body') return 'The pin must be a round face or edge, a straight edge or a point';
      return a.body === b.body ? 'The pin and the slot must be on different components' : null;
  }
  return null;
}

/**
 * What a mate measures where the components are (a result of a motion
 * study): the distance or angle between its entities, a hinge's turn, a
 * pin's travel along its slot; null for the others.
 */
export function mateMeasure(m: SolverMate, pl: Map<Id, Placement>, L = 100): { value: number; kind: 'length' | 'angle' } | null {
  const at = (e?: SolverEntity) => (e?.body ? pl.get(e.body) ?? null : null);
  const ga = placeGeo(m.a.geo, at(m.a)), gb = placeGeo(m.b.geo, at(m.b));
  if (m.type === 'distance') { const d = distanceParts(ga, gb, { aligned: m.aligned, flip: m.flip, scale: L }); return d ? { value: d.d, kind: 'length' } : null; }
  if (m.type === 'angle') { const a = angleOf(ga, gb, m.aligned); return a === null ? null : { value: a, kind: 'angle' }; }
  if (m.type === 'hinge') {
    const pa = at(m.a) ?? IDENT, pb = at(m.b) ?? IDENT;
    const rel = m.rel ?? null;
    if (!rel || m.a.geo.kind !== 'axis') return null;
    return { value: (turnAbout(relativePlacement(pa, pb).q, rel.q, normalize(m.a.geo.d)) * 180) / Math.PI, kind: 'angle' };
  }
  if (m.type === 'slider' && m.rel) {
    const dir = sliderDirection(m);
    return dir ? { value: sliderTravel(m, relativePlacement(at(m.a) ?? IDENT, at(m.b) ?? IDENT), dir), kind: 'length' } : null;
  }
  if (m.type === 'slot' && m.a2) {
    const ga2 = placeGeo(m.a2.geo, at(m.a2));
    const da = dirOf(ga), p1 = pointOf(ga), p2 = pointOf(ga2), pb = pointOf(gb);
    if (!da || !p1 || !p2 || !pb) return null;
    const d = normalize(da), w = sub(p2, p1), along = sub(w, scale(d, dot(w, d)));
    return len(along) > 1e-9 ? { value: dot(sub(pb, p1), normalize(along)), kind: 'length' } : null;
  }
  return null;
}

// ---------- the solver ----------

interface System {
  vars: Id[];
  index: Map<Id, number>;
  bodies: Map<Id, SolverBody>;
  centers: Map<Id, Vec3>;
}

function placementWith(base: Placement, center: Vec3, x: number[], o: number, L: number): Placement {
  const w: Vec3 = [x[o + 3], x[o + 4], x[o + 5]];
  const dq = rotVecQuat(w);
  // Turn about the component's centre (in the assembly), then move.
  const c = applyPlacement(base, center);
  const p = add(add(qRotate(dq, sub(base.p, c)), c), [x[o] * L, x[o + 1] * L, x[o + 2] * L]);
  return { p, q: qNormalize(qMul(dq, base.q)) };
}

export class MateSolver {
  constructor(readonly bodies: SolverBody[], readonly mates: SolverMate[]) {}

  /** Placements with all mates (and the drag goal) satisfied as far as possible. */
  solve(opts: SolveOptions = {}, mates = this.mates, start?: Map<Id, Placement>): SolveResult {
    const L = opts.scale && opts.scale > 0 ? opts.scale : 100;
    const bodies = new Map(this.bodies.map((b) => [b.id, { ...b, placement: start?.get(b.id) ?? b.placement }]));
    const involved = new Set<Id>();
    for (const m of mates) for (const id of mateBodies(m)) involved.add(id);
    if (opts.drag) involved.add(opts.drag.body);
    const drives = opts.drives ?? [];
    for (const d of drives) for (const id of driveBodies(d)) involved.add(id);
    const vars = [...involved].filter((id) => bodies.has(id) && !bodies.get(id)!.fixed);
    const sys: System = { vars, index: new Map(vars.map((id, i) => [id, i])), bodies, centers: new Map(vars.map((id) => [id, bodies.get(id)!.center ?? [0, 0, 0]])) };
    const placements = new Map([...bodies].map(([id, b]) => [id, b.placement]));
    // Where the components start: what gear, rack and pinion and screw mates, and motors, measure motion from.
    const ref = placements;
    const weights = vars.map((id) => Math.sqrt(Math.max(1e-6, opts.weight?.(id) ?? 1)));
    const n = vars.length * 6;
    const residuals = new Map<Id, number>();
    // Gear, rack and pinion and screw mates read the components' turns from the variables (see mateResidual).
    const coupled = mates.some((m) => m.type === 'gear' || m.type === 'rackPinion' || m.type === 'screw');
    const turnsOf = coupled ? new WeakMap<Map<Id, Placement>, Map<Id, Vec3>>() : null;
    const evalMates = (pl: Map<Id, Placement>) => {
      residuals.clear();
      let worst = 0;
      for (const m of mates) {
        const r = this.mateResidual(m, pl, L, ref, true, turnsOf?.get(pl));
        const v = r ? Math.max(0, ...r.map(Math.abs)) : Infinity;
        residuals.set(m.id, v);
        worst = Math.max(worst, v);
      }
      return worst;
    };
    // A component no mate holds is carried by a move drag without turning, as if picked up.
    const drag = opts.drag;
    if (drag?.kind === 'move' && sys.index.has(drag.body) && !drives.length && !mates.some((m) => mateBodies(m).includes(drag.body))) {
      const pl = placements.get(drag.body)!;
      const moved = new Map(placements).set(drag.body, { p: add(pl.p, sub(drag.target, applyPlacement(pl, drag.local))), q: pl.q });
      return this.solve({ ...opts, drag: null }, mates, moved);
    }
    const driveWorst = (pl: Map<Id, Placement>) => Math.max(0, ...driveResidual(drives, pl, ref, L).map(Math.abs));
    if (!n) {
      const worst = evalMates(placements), dw = driveWorst(placements);
      return { placements, ok: worst < CONFLICT_TOL && dw < CONFLICT_TOL, residuals, iterations: 0, driveResidual: dw };
    }
    // While a move drag pulls, turning costs more than sliding: a component
    // its mates let slide follows the cursor without spinning, and one they
    // only let turn (a lid on a hinge) still turns.
    const varWeights = (withDrag: boolean) => vars.flatMap((_, i) => [0, 1, 2, 3, 4, 5].map((j) => weights[i] * (withDrag && drag?.kind === 'move' && j >= 3 ? DRAG_TURN_RESISTANCE : 1)));
    let x = new Array<number>(n).fill(0);
    const at = (xv: number[]): Map<Id, Placement> => {
      const out = new Map(placements);
      vars.forEach((id, i) => out.set(id, placementWith(bodies.get(id)!.placement, sys.centers.get(id)!, xv, i * 6, L)));
      turnsOf?.set(out, turnsAt(vars, xv));
      return out;
    };
    const dragWeight = 0.05;
    const rows = (pl: Map<Id, Placement>, withDrag: boolean): number[] => {
      const out: number[] = [];
      const turns = turnsOf?.get(pl);
      for (const m of mates) out.push(...(this.mateResidual(m, pl, L, ref, true, turns) ?? []));
      if (drives.length) out.push(...driveResidual(drives, pl, ref, L));
      if (withDrag && opts.drag) out.push(...dragResidual(opts.drag, pl, L).map((v) => v * dragWeight));
      return out;
    };
    const maxIter = opts.maxIter ?? 60;
    let iterations = 0;
    const run = (withDrag: boolean, iters: number) => {
      const vw = varWeights(withDrag);
      let lambda = 1e-6;
      let r = rows(at(x), withDrag);
      let cost = sumSq(r);
      let perturbations = 0;
      for (let it = 0; it < iters; it++) {
        iterations++;
        const mateCost = withDrag ? sumSq(rows(at(x), false)) : cost;
        if (!withDrag && Math.sqrt(mateCost) < TOL) break;
        const J = this.jacobian(x, sys, placements, mates, withDrag ? opts.drag ?? null : null, dragWeight, r.length, n, vw, L, drives, coupled);
        const g = new Array<number>(n).fill(0);
        const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
        for (let i = 0; i < r.length; i++) {
          const Ji = J[i];
          for (let p = 0; p < n; p++) {
            const v = Ji[p];
            if (!v) continue;
            g[p] += v * r[i];
            const Ap = A[p];
            for (let q = p; q < n; q++) Ap[q] += v * Ji[q];
          }
        }
        for (let p = 0; p < n; p++) for (let q = 0; q < p; q++) A[p][q] = A[q][p];
        let improved = false;
        let step: number[] = [];
        for (let tries = 0; tries < 12; tries++) {
          const M = A.map((row, p) => row.map((v, q) => (p === q ? v + lambda : v)));
          const d = choleskySolve(M, g.map((v) => -v));
          if (!d) { lambda *= 10; continue; }
          step = d.map((v, i) => v / vw[i]);
          const xn = x.map((v, i) => v + step[i]);
          const rn = rows(at(xn), withDrag);
          const cn = sumSq(rn);
          if (cn < cost) {
            x = xn; r = rn; cost = cn;
            lambda = Math.max(1e-12, lambda / 4);
            improved = true;
            break;
          }
          lambda *= 6;
        }
        const stepSize = Math.max(0, ...step.map(Math.abs));
        if (!improved || stepSize < 1e-13) {
          // Stuck where the gradient vanishes (a face turned exactly the
          // wrong way for its alignment): give the bodies a turn and go on.
          if (!withDrag && Math.sqrt(cost) > CONFLICT_TOL && perturbations < 3) {
            perturbations++;
            x = x.map((v, i) => (i % 6 >= 3 ? v + [0.7, -0.5, 0.3][i % 3] * (perturbations % 2 ? 1 : -1) : v));
            r = rows(at(x), withDrag);
            cost = sumSq(r);
            lambda = 1e-3;
            continue;
          }
          break;
        }
        if (withDrag && stepSize < 1e-9) break;
      }
    };
    if (opts.drag) {
      run(true, Math.min(maxIter, 30));
      // Then exactly onto the mates, moving as little as possible.
      run(false, maxIter);
    } else run(false, maxIter);
    const final = at(x);
    const worst = evalMates(final), dw = driveWorst(final);
    return { placements: final, ok: worst < CONFLICT_TOL && dw < CONFLICT_TOL, residuals, iterations, driveResidual: dw };
  }

  /**
   * Jacobian of the residual rows (mates, then the drag goal) by central
   * differences: each mate depends on the variables of its two components only.
   * Columns are divided by the variables' weights (`vw`, one per variable).
   */
  private jacobian(x: number[], sys: System, base: Map<Id, Placement>, mates: SolverMate[], drag: DragGoal | null, dragWeight: number, m: number, n: number, vw: number[], L: number, drives: Drive[] = [], coupled = false): number[][] {
    const J = Array.from({ length: m }, () => new Array<number>(n).fill(0));
    const h = 1e-6;
    const current = new Map(base);
    sys.vars.forEach((id, i) => current.set(id, placementWith(sys.bodies.get(id)!.placement, sys.centers.get(id)!, x, i * 6, L)));
    // One component moved at a time, in one map put back after each (a copy
    // of every placement per evaluation made large assemblies drag slowly).
    const work = new Map(current);
    const turns = coupled ? turnsAt(sys.vars, x) : undefined;
    const perturbed = (id: Id, j: number, d: number): Map<Id, Placement> => {
      const i = sys.index.get(id)!;
      const xv = x.slice(i * 6, i * 6 + 6);
      xv[j] += d;
      work.set(id, placementWith(sys.bodies.get(id)!.placement, sys.centers.get(id)!, xv, 0, L));
      turns?.set(id, [xv[3], xv[4], xv[5]]);
      return work;
    };
    const block = (row: number, bodies: (Id | null)[], f: (pl: Map<Id, Placement>) => number[]) => {
      for (const id of new Set(bodies)) {
        if (!id || !sys.index.has(id)) continue;
        const k = sys.index.get(id)! * 6;
        for (let j = 0; j < 6; j++) {
          const rp = f(perturbed(id, j, h)), rm = f(perturbed(id, j, -h));
          for (let i = 0; i < rp.length; i++) J[row + i][k + j] = (rp[i] - rm[i]) / (2 * h) / vw[k + j];
        }
        work.set(id, current.get(id)!);
        turns?.set(id, [x[k + 3], x[k + 4], x[k + 5]]);
      }
    };
    let row = 0;
    for (const mt of mates) {
      const f = (pl: Map<Id, Placement>) => this.mateResidual(mt, pl, L, base, true, turns) ?? [];
      const len0 = f(current).length;
      block(row, mateBodies(mt), f);
      row += len0;
    }
    for (const d of drives) { block(row, driveBodies(d), (pl) => driveResidual([d], pl, base, L)); row++; }
    if (drag) block(row, [drag.body], (pl) => dragResidual(drag, pl, L).map((v) => v * dragWeight));
    return J;
  }

  /**
   * A mate's residuals with the components where `pl` puts them; null when
   * it cannot be formed. `ref`: where the components started (what coupling
   * mates measure motion from). `ineq`: with the rows of limits (left out of
   * the rank analysis: a limit takes no freedom away). `turns`: how far each
   * moving component turned from `ref` (a rotation vector, which unlike the
   * orientation itself goes on past half a turn); without it the turns are
   * read from the orientations.
   */
  mateResidual(m: SolverMate, pl: Map<Id, Placement>, L: number, ref: Map<Id, Placement> = pl, ineq = true, turns?: Map<Id, Vec3>): number[] | null {
    const pa = m.a.body ? pl.get(m.a.body) ?? null : null;
    const pb = m.b.body ? pl.get(m.b.body) ?? null : null;
    if ((m.a.body && !pa) || (m.b.body && !pb)) return null;
    if (isMechanical(m.type)) return mechanicalResidual(m, pl, ref, pa, pb, L, ineq, turns);
    const o = { aligned: m.aligned, value: m.value, flip: m.flip, scale: L, rel: m.rel };
    if (m.limit && (m.type === 'distance' || m.type === 'angle')) return limitEquations(m.type, placeGeo(m.a.geo, pa), placeGeo(m.b.geo, pb), o, m.limit, ineq);
    return equations(m.type, placeGeo(m.a.geo, pa), placeGeo(m.b.geo, pb), o, pa, pb);
  }

  /**
   * Solves, then finds conflicting mates (each mate that cannot hold with
   * the ones before it is left out) and the definition of every component.
   */
  analyze(opts: SolveOptions = {}): AnalysisResult {
    const L = opts.scale && opts.scale > 0 ? opts.scale : 100;
    const invalid = new Map<Id, string>();
    const usable: SolverMate[] = [];
    for (const m of this.mates) {
      const problem = this.validity(m);
      if (problem) invalid.set(m.id, problem);
      else usable.push(m);
    }
    let res = this.solve(opts, usable);
    const conflicts = new Set<Id>();
    if (!res.ok) {
      // Add the mates one at a time; one that does not hold with those before it conflicts.
      const kept: SolverMate[] = [];
      let placements = new Map(this.bodies.map((b) => [b.id, b.placement]));
      for (const m of usable) {
        const r = this.solve(opts, [...kept, m], placements);
        if (r.ok) { kept.push(m); placements = r.placements; } else conflicts.add(m.id);
      }
      res = this.solve(opts, kept, placements);
    }
    const active = usable.filter((m) => !conflicts.has(m.id));
    const floating = this.bodies.filter((b) => !b.fixed);
    const pl = res.placements;
    // The Jacobian of the mates at the solution (all components free to move) is
    // block diagonal over groups of floating components linked by mates between
    // them: each group is analysed on its own, and a component no mate holds
    // simply keeps its six degrees of freedom (one large matrix took seconds and,
    // with hundreds of components, gigabytes).
    const parent = new Map(floating.map((b) => [b.id, b.id]));
    const root = (id: Id): Id => {
      let r = id;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(id, r);
      return r;
    };
    for (const m of active) {
      const ids = mateBodies(m).filter((id) => parent.has(id));
      for (let i = 1; i < ids.length; i++) parent.set(root(ids[i]), root(ids[0]));
    }
    const groups = new Map<Id, { bodies: SolverBody[]; mates: SolverMate[] }>();
    for (const b of floating) {
      const r = root(b.id);
      if (!groups.has(r)) groups.set(r, { bodies: [], mates: [] });
      groups.get(r)!.bodies.push(b);
    }
    for (const m of active) {
      const id = mateBodies(m).find((x) => parent.has(x));
      if (id) groups.get(root(id))!.mates.push(m);
    }
    let dof = 0;
    const defined = new Set<Id>();
    const work = new Map(pl);
    for (const g of groups.values()) {
      const n = g.bodies.length * 6;
      if (!g.mates.length) { dof += n; continue; }
      const index = new Map(g.bodies.map((b, i) => [b.id, i]));
      const J: number[][] = [];
      // Gear, rack and pinion and screw mates hold at the start of every solve whatever their
      // ratio, so one that contradicts the mates before it is found here: see contradicts.
      const coupled = g.mates.some(isCoupling) ? new Map(g.bodies.map((b) => [b.id, b.id])) : null;
      const top = (id: Id): Id => { let r = id; while (coupled!.get(r) !== r) r = coupled!.get(r)!; return r; };
      for (const m of g.mates) {
        const base = this.mateResidual(m, pl, L, pl, false);
        if (!base) continue;
        const block = base.map(() => new Array<number>(n).fill(0));
        for (const id of mateBodies(m)) {
          if (!id || !index.has(id)) continue;
          const i = index.get(id)!;
          const center = g.bodies[i].center ?? [0, 0, 0];
          for (let j = 0; j < 6; j++) {
            const x = [0, 0, 0, 0, 0, 0];
            x[j] = 1e-6;
            work.set(id, placementWith(pl.get(id)!, center, x, 0, L));
            const rp = this.mateResidual(m, work, L, pl, false)!;
            x[j] = -1e-6;
            work.set(id, placementWith(pl.get(id)!, center, x, 0, L));
            const rm = this.mateResidual(m, work, L, pl, false)!;
            for (let r = 0; r < base.length; r++) block[r][i * 6 + j] = (rp[r] - rm[r]) / 2e-6;
          }
          work.set(id, pl.get(id)!);
        }
        if (coupled) {
          const ids = mateBodies(m).filter((id) => index.has(id));
          // Only where the mates before it already link its components (a loop) can it contradict them.
          if (isCoupling(m) && ids.length > 1 && ids.every((id) => top(id) === top(ids[0])) && contradicts(J, block[block.length - 1], ids.map((id) => index.get(id)!), n)) {
            conflicts.add(m.id);
            continue;
          }
          for (const id of ids.slice(1)) coupled.set(top(id), top(ids[0]));
        }
        J.push(...block);
      }
      // A component is fully defined when no motion the mates allow moves it:
      // every vector of the Jacobian's null space is zero on its six variables.
      const { rank, basis } = nullSpace(J, n);
      dof += n - rank;
      g.bodies.forEach((b, i) => {
        const k = i * 6;
        if (basis.every((v) => {
          let all = 0, own = 0;
          for (let j = 0; j < n; j++) all = Math.max(all, Math.abs(v[j]));
          for (let j = k; j < k + 6; j++) own = Math.max(own, Math.abs(v[j]));
          return own <= 1e-6 * all;
        })) defined.add(b.id);
      });
    }
    const status: DefinitionStatus = conflicts.size ? 'over' : invalid.size ? 'error' : dof === 0 ? 'full' : 'under';
    return { status, dof, defined, conflicts, invalid, placements: res.placements };
  }

  private validity(m: SolverMate): string | null {
    if (m.a.body && m.a.body === m.b.body) return 'Both entities are on the same component';
    if (!mateBodies(m).length) return 'A mate needs at least one component';
    if (m.type === 'lock' && !m.rel) return 'The lock mate has no stored position';
    if (m.limit) {
      if (!(m.limit.min <= m.limit.max)) return 'The smallest value must not be more than the largest';
      if (m.type === 'angle' && (m.limit.min < 0 || m.limit.max > 180)) return 'Angle limits are between 0° and 180°';
      if (m.type === 'hinge' && !m.rel) return 'The hinge has no stored position to measure its angle from';
    }
    if (isMechanical(m.type)) return mechanicalProblem(m) ?? (m.type === 'rackPinion' ? this.rackProblem(m) : null);
    return m.type === 'lock' ? null : mateProblem(m.type, m.a.geo, m.b.geo);
  }

  /** A rack along its pinion's axis (where the components are) is no rack and pinion: it would move as a screw. */
  private rackProblem(m: SolverMate): string | null {
    const at = (e: SolverEntity) => (e.body ? this.bodies.find((b) => b.id === e.body)?.placement ?? null : null);
    const dp = dirOf(placeGeo(m.a.geo, at(m.a))), u = dirOf(placeGeo(m.b.geo, at(m.b)));
    return dp && u && Math.abs(dot(normalize(dp), normalize(u))) > 0.999 ? 'The rack must run across the pinion\'s axis, not along it' : null;
  }
}

/**
 * A mechanical mate's residuals (see mateResidual). On its own: the closures
 * here would make every call of mateResidual allocate, plain mates too.
 */
function mechanicalResidual(m: SolverMate, pl: Map<Id, Placement>, ref: Map<Id, Placement>, pa: Placement | null, pb: Placement | null, L: number, ineq: boolean, turns?: Map<Id, Vec3>): number[] | null {
  const now = (e: SolverEntity) => (e.body ? pl.get(e.body) ?? IDENT : IDENT);
  const start = (e: SolverEntity) => (e.body ? ref.get(e.body) ?? now(e) : IDENT);
  for (const e of [m.a2, m.b2]) if (e?.body && !pl.get(e.body)) return null;
  const turned = (e: SolverEntity, d: Vec3) => {
    if (!e.body) return 0;
    if (!turns) return turnAbout(now(e).q, start(e).q, d);
    const w = turns.get(e.body);
    return w ? dot(w, d) : 0;
  };
  return mechanicalEquations({
    m, ga: placeGeo(m.a.geo, pa), gb: placeGeo(m.b.geo, pb), ga2: m.a2 ? placeGeo(m.a2.geo, m.a2.body ? now(m.a2) : null) : null, gb2: m.b2 ? placeGeo(m.b2.geo, m.b2.body ? now(m.b2) : null) : null,
    pa: now(m.a), pb: now(m.b), ra: start(m.a), rb: start(m.b), now, start, turned, L, ineq,
  });
}

/**
 * The mates that can move a component: those of the floating components
 * linked to it through mates between floating components. Mates of other
 * components hold already and do not change while it is dragged, so a drag
 * solves only these (fast in a large assembly).
 */
export function matesMoving(body: Id, bodies: SolverBody[], mates: SolverMate[]): SolverMate[] {
  const floating = new Set(bodies.filter((b) => !b.fixed).map((b) => b.id));
  const linked = new Set([body]);
  // The floating components of each mate, found once (this runs on every drag step).
  const each = mates.map((m) => mateBodies(m).filter((id) => floating.has(id)));
  for (let grew = true; grew;) {
    grew = false;
    for (const ids of each) {
      if (ids.length > 1 && ids.some((id) => linked.has(id)) && ids.some((id) => !linked.has(id))) { for (const id of ids) linked.add(id); grew = true; }
    }
  }
  return mates.filter((m) => mateBodies(m).some((id) => linked.has(id)));
}

const isCoupling = (m: SolverMate) => m.type === 'gear' || m.type === 'rackPinion' || m.type === 'screw';

/**
 * Whether a coupling mate (its row `c` of the Jacobian) contradicts the mates
 * before it (rows J, n variables): they let its components (`bodies`, by
 * index) move, related another way, and with it they cannot move at all (two
 * gear mates with different ratios between the same gears: they hold only
 * while nothing turns).
 */
function contradicts(J: number[][], c: number[], bodies: number[], n: number): boolean {
  const { basis } = nullSpace(J, n);
  if (!basis.length) return false;
  let vmax = 0, cmax = 0;
  for (const v of basis) for (const x of v) vmax = Math.max(vmax, Math.abs(x));
  for (const x of c) cmax = Math.max(cmax, Math.abs(x));
  // What the mate asks of each motion the others allow.
  const g = basis.map((v) => v.reduce((s, x, j) => s + x * c[j], 0));
  const gg = g.reduce((s, x) => s + x * x, 0);
  if (Math.sqrt(gg) <= 1e-7 * cmax * vmax) return false;
  let moved = false;
  for (const b of bodies) {
    for (let j = b * 6; j < b * 6 + 6; j++) {
      const row = basis.map((v) => v[j]);
      const rmax = Math.max(...row.map(Math.abs));
      if (rmax <= 1e-6 * vmax) continue;
      moved = true;
      // With the mate, this variable can still change unless it changes only along g.
      const k = row.reduce((s, x, i) => s + x * g[i], 0) / gg;
      if (row.some((x, i) => Math.abs(x - k * g[i]) > 1e-6 * rmax)) return false;
    }
  }
  return moved;
}

/** How far each drive is from its motion: radians for turns, lengths over L for moves. */
function driveResidual(drives: Drive[], pl: Map<Id, Placement>, ref: Map<Id, Placement>, L: number): number[] {
  return drives.map((d) => {
    const p = pl.get(d.body), p0 = ref.get(d.body);
    if (!p || !p0) return 0;
    if (d.kind === 'rotate') return turnAbout(p.q, p0.q, d.axis) - d.amount;
    if (d.kind === 'translate') return (dot(sub(applyPlacement(p, d.local), applyPlacement(p0, d.local)), d.dir) - d.amount) / L;
    const b = d.base ? pl.get(d.base) ?? IDENT : IDENT, b0 = d.base ? ref.get(d.base) ?? IDENT : IDENT;
    const rel = relativePlacement(b, p), rel0 = relativePlacement(b0, p0);
    if (d.kind === 'relTurn') return turnAbout(rel.q, rel0.q, d.axis) - d.amount;
    return (dot(sub(applyPlacement(rel, d.local), applyPlacement(rel0, d.local)), d.dir) - d.amount) / L;
  });
}

function dragResidual(goal: DragGoal, pl: Map<Id, Placement>, L: number): number[] {
  const p = pl.get(goal.body);
  if (!p) return [];
  if (goal.kind === 'move') {
    const w = applyPlacement(p, goal.local);
    return [(w[0] - goal.target[0]) / L, (w[1] - goal.target[1]) / L, (w[2] - goal.target[2]) / L];
  }
  return quatRotVec(qMul(qConj(goal.q), p.q));
}

const sumSq = (r: number[]) => r.reduce((s, v) => s + v * v, 0);

/** The rotation vectors of the variables (each component's turn from where the solve started). */
const turnsAt = (vars: Id[], x: number[]): Map<Id, Vec3> => new Map(vars.map((id, i) => [id, [x[i * 6 + 3], x[i * 6 + 4], x[i * 6 + 5]] as Vec3]));

/** Solves the symmetric positive definite system A x = b (null when it is not positive definite). */
function choleskySolve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const Lm = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= Lm[i][k] * Lm[j][k];
      if (i === j) {
        if (!(s > 0)) return null;
        Lm[i][i] = Math.sqrt(s);
      } else Lm[i][j] = s / Lm[j][j];
    }
  }
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= Lm[i][k] * y[k];
    y[i] = s / Lm[i][i];
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= Lm[k][i] * x[k];
    x[i] = s / Lm[i][i];
  }
  return x;
}

/** Numerical rank of an m×n matrix (Householder QR with column pivoting). */
export function matrixRank(rowsIn: number[][], n: number, tol = 1e-7): number {
  return pivotedQR(rowsIn, n, tol).rank;
}

/** Rank and a basis of the null space of an m×n matrix (from its pivoted QR factorisation). */
export function nullSpace(rowsIn: number[][], n: number, tol = 1e-7): { rank: number; basis: number[][] } {
  const { A, cols, rank } = pivotedQR(rowsIn, n, tol);
  const basis: number[][] = [];
  // R = [R11 R12] in pivot order: each free column f gives z with z_f = 1 and R11 z_pivots = -R12_f.
  for (let f = rank; f < n; f++) {
    const z = new Array<number>(n).fill(0);
    z[cols[f]] = 1;
    for (let i = rank - 1; i >= 0; i--) {
      let s = A[i][cols[f]];
      for (let c = i + 1; c < rank; c++) s += A[i][cols[c]] * z[cols[c]];
      z[cols[i]] = -s / A[i][cols[i]];
    }
    basis.push(z);
  }
  return { rank, basis };
}

function pivotedQR(rowsIn: number[][], n: number, tol: number): { A: number[][]; cols: number[]; rank: number } {
  const m = rowsIn.length;
  const cols = [...Array(n).keys()];
  if (!m || !n) return { A: [], cols, rank: 0 };
  const A = rowsIn.map((r) => r.slice());
  const norms = new Array<number>(n).fill(0).map((_, j) => Math.sqrt(A.reduce((s, r) => s + r[j] * r[j], 0)));
  const scaleRef = Math.max(1, ...norms);
  let rank = 0;
  for (let k = 0; k < Math.min(m, n); k++) {
    // Pivot: the remaining column with the largest norm below row k.
    let best = -1, bestNorm = 0;
    for (let c = k; c < n; c++) {
      let s = 0;
      for (let i = k; i < m; i++) s += A[i][cols[c]] ** 2;
      if (s > bestNorm) { bestNorm = s; best = c; }
    }
    if (best < 0 || Math.sqrt(bestNorm) <= tol * scaleRef) break;
    [cols[k], cols[best]] = [cols[best], cols[k]];
    const j = cols[k];
    // Householder reflection zeroing column j below row k.
    const alpha = -Math.sign(A[k][j] || 1) * Math.sqrt(bestNorm);
    const v = new Array<number>(m).fill(0);
    for (let i = k; i < m; i++) v[i] = A[i][j];
    v[k] -= alpha;
    const vn = v.reduce((s, x) => s + x * x, 0);
    if (vn > 0) {
      for (let c = k; c < n; c++) {
        const jc = cols[c];
        let s = 0;
        for (let i = k; i < m; i++) s += v[i] * A[i][jc];
        const f = (2 * s) / vn;
        for (let i = k; i < m; i++) A[i][jc] -= f * v[i];
      }
    }
    rank++;
  }
  return { A, cols, rank };
}
