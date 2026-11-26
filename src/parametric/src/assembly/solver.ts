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

import type { Quat, Vec3 } from '../math/vec';
import { add, cross, dot, len, normalize, qMul, qNormalize, qRotate, scale, sub } from '../math/vec';
import type { Id } from '../model/types';
import type { MateType, Placement } from '../model/assembly';

/** Geometry of a mate entity, in the coordinates of its component (or the assembly for ground). */
export type Geo =
  | { kind: 'plane'; o: Vec3; n: Vec3 }
  /** Cylinder, cone or circular edge: a point on the axis, its direction and (cylinder, circle) radius. */
  | { kind: 'axis'; p: Vec3; d: Vec3; r: number; surface: 'cylinder' | 'cone' | 'circle' }
  | { kind: 'line'; p: Vec3; d: Vec3 }
  | { kind: 'point'; p: Vec3 }
  | { kind: 'sphere'; c: Vec3; r: number }
  /** A whole component (lock mates). */
  | { kind: 'body' };

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
  /** Lock: b's placement in a's frame. */
  rel?: Placement;
}

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
}

export interface SolveResult {
  placements: Map<Id, Placement>;
  /** All mates hold. */
  ok: boolean;
  /** Largest residual of each mate (normalised), after solving. */
  residuals: Map<Id, number>;
  iterations: number;
}

export type DefinitionStatus = 'under' | 'full' | 'over';

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
      return [dot(da, db) - (o.aligned ? c : -c)];
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
      if (isPointLike(a) && isPointLike(b)) return [(len(sub(pointOf(a)!, pointOf(b)!)) - D) / L];
      if (isAxisLike(a) && isAxisLike(b) && !isPointLike(a) && !isPointLike(b)) return [...match(dirOf(a)!, dirOf(b)!), (len(cross(sub(pointOf(b)!, pointOf(a)!), dirOf(a)!)) - D) / L];
      if (isAxisLike(a) && isPointLike(b)) return [(len(cross(sub(pointOf(b)!, pointOf(a)!), dirOf(a)!)) - D) / L];
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
    for (const m of mates) for (const e of [m.a, m.b]) if (e.body) involved.add(e.body);
    if (opts.drag) involved.add(opts.drag.body);
    const vars = [...involved].filter((id) => bodies.has(id) && !bodies.get(id)!.fixed);
    const sys: System = { vars, index: new Map(vars.map((id, i) => [id, i])), bodies, centers: new Map(vars.map((id) => [id, bodies.get(id)!.center ?? [0, 0, 0]])) };
    const placements = new Map([...bodies].map(([id, b]) => [id, b.placement]));
    const weights = vars.map((id) => Math.sqrt(Math.max(1e-6, opts.weight?.(id) ?? 1)));
    const n = vars.length * 6;
    const residuals = new Map<Id, number>();
    const evalMates = (pl: Map<Id, Placement>) => {
      residuals.clear();
      let worst = 0;
      for (const m of mates) {
        const r = this.mateResidual(m, pl, L);
        const v = r ? Math.max(0, ...r.map(Math.abs)) : Infinity;
        residuals.set(m.id, v);
        worst = Math.max(worst, v);
      }
      return worst;
    };
    if (!n) {
      const worst = evalMates(placements);
      return { placements, ok: worst < CONFLICT_TOL, residuals, iterations: 0 };
    }
    let x = new Array<number>(n).fill(0);
    const at = (xv: number[]): Map<Id, Placement> => {
      const out = new Map(placements);
      vars.forEach((id, i) => out.set(id, placementWith(bodies.get(id)!.placement, sys.centers.get(id)!, xv, i * 6, L)));
      return out;
    };
    const dragWeight = 0.05;
    const rows = (pl: Map<Id, Placement>, withDrag: boolean): number[] => {
      const out: number[] = [];
      for (const m of mates) out.push(...(this.mateResidual(m, pl, L) ?? []));
      if (withDrag && opts.drag) out.push(...dragResidual(opts.drag, pl, L).map((v) => v * dragWeight));
      return out;
    };
    const maxIter = opts.maxIter ?? 60;
    let iterations = 0;
    const run = (withDrag: boolean, iters: number) => {
      let lambda = 1e-6;
      let r = rows(at(x), withDrag);
      let cost = sumSq(r);
      let perturbations = 0;
      for (let it = 0; it < iters; it++) {
        iterations++;
        const mateCost = withDrag ? sumSq(rows(at(x), false)) : cost;
        if (!withDrag && Math.sqrt(mateCost) < TOL) break;
        const J = this.jacobian(x, sys, placements, mates, withDrag ? opts.drag ?? null : null, dragWeight, r.length, n, weights, L);
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
          step = d.map((v, i) => v / weights[Math.floor(i / 6)]);
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
    const worst = evalMates(final);
    return { placements: final, ok: worst < CONFLICT_TOL, residuals, iterations };
  }

  /**
   * Jacobian of the residual rows (mates, then the drag goal) by central
   * differences: each mate depends on the variables of its two components only.
   */
  private jacobian(x: number[], sys: System, base: Map<Id, Placement>, mates: SolverMate[], drag: DragGoal | null, dragWeight: number, m: number, n: number, weights: number[], L: number): number[][] {
    const J = Array.from({ length: m }, () => new Array<number>(n).fill(0));
    const h = 1e-6;
    const current = new Map(base);
    sys.vars.forEach((id, i) => current.set(id, placementWith(sys.bodies.get(id)!.placement, sys.centers.get(id)!, x, i * 6, L)));
    // One component moved at a time, in one map put back after each (a copy
    // of every placement per evaluation made large assemblies drag slowly).
    const work = new Map(current);
    const perturbed = (id: Id, j: number, d: number): Map<Id, Placement> => {
      const i = sys.index.get(id)!;
      const xv = x.slice(i * 6, i * 6 + 6);
      xv[j] += d;
      work.set(id, placementWith(sys.bodies.get(id)!.placement, sys.centers.get(id)!, xv, 0, L));
      return work;
    };
    const block = (row: number, bodies: (Id | null)[], f: (pl: Map<Id, Placement>) => number[]) => {
      for (const id of new Set(bodies)) {
        if (!id || !sys.index.has(id)) continue;
        const k = sys.index.get(id)! * 6;
        const w = weights[sys.index.get(id)!];
        for (let j = 0; j < 6; j++) {
          const rp = f(perturbed(id, j, h)), rm = f(perturbed(id, j, -h));
          for (let i = 0; i < rp.length; i++) J[row + i][k + j] = (rp[i] - rm[i]) / (2 * h) / w;
        }
        work.set(id, current.get(id)!);
      }
    };
    let row = 0;
    for (const mt of mates) {
      const f = (pl: Map<Id, Placement>) => this.mateResidual(mt, pl, L) ?? [];
      const len0 = f(current).length;
      block(row, [mt.a.body, mt.b.body], f);
      row += len0;
    }
    if (drag) block(row, [drag.body], (pl) => dragResidual(drag, pl, L).map((v) => v * dragWeight));
    return J;
  }

  /** A mate's residuals with the components where `pl` puts them; null when it cannot be formed. */
  mateResidual(m: SolverMate, pl: Map<Id, Placement>, L: number): number[] | null {
    const pa = m.a.body ? pl.get(m.a.body) ?? null : null;
    const pb = m.b.body ? pl.get(m.b.body) ?? null : null;
    if ((m.a.body && !pa) || (m.b.body && !pb)) return null;
    return equations(m.type, placeGeo(m.a.geo, pa), placeGeo(m.b.geo, pb), { aligned: m.aligned, value: m.value, flip: m.flip, scale: L, rel: m.rel }, pa, pb);
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
    const index = new Map(floating.map((b, i) => [b.id, i]));
    // Jacobian of the mates at the solution, all components free to move.
    const n = floating.length * 6;
    const J: number[][] = [];
    const pl = res.placements;
    const x0 = new Array<number>(n).fill(0);
    const at = (xv: number[]) => {
      const out = new Map(pl);
      floating.forEach((b, i) => out.set(b.id, placementWith(pl.get(b.id)!, b.center ?? [0, 0, 0], xv, i * 6, L)));
      return out;
    };
    for (const m of active) {
      const cols = [m.a.body, m.b.body].filter((id): id is Id => !!id && index.has(id));
      const base = this.mateResidual(m, pl, L);
      if (!base || !cols.length) continue;
      const block = base.map(() => new Array<number>(n).fill(0));
      for (const id of new Set(cols)) {
        const k = index.get(id)! * 6;
        for (let j = k; j < k + 6; j++) {
          const xp = x0.slice(), xm = x0.slice();
          xp[j] += 1e-6; xm[j] -= 1e-6;
          const rp = this.mateResidual(m, at(xp), L)!, rm = this.mateResidual(m, at(xm), L)!;
          for (let i = 0; i < base.length; i++) block[i][j] = (rp[i] - rm[i]) / 2e-6;
        }
      }
      J.push(...block);
    }
    // A component is fully defined when no motion the mates allow moves it:
    // every vector of the Jacobian's null space is zero on its six variables.
    // (One factorisation for all components: a rank per component took
    // seconds in an assembly of fifty.)
    const { rank: rankAll, basis } = nullSpace(J, n);
    const defined = new Set<Id>();
    for (const b of floating) {
      const k = index.get(b.id)! * 6;
      if (basis.every((v) => {
        let all = 0, own = 0;
        for (let j = 0; j < n; j++) all = Math.max(all, Math.abs(v[j]));
        for (let j = k; j < k + 6; j++) own = Math.max(own, Math.abs(v[j]));
        return own <= 1e-6 * all;
      })) defined.add(b.id);
    }
    const dof = n - rankAll;
    const status: DefinitionStatus = conflicts.size || invalid.size ? 'over' : dof === 0 ? 'full' : 'under';
    return { status, dof, defined, conflicts, invalid, placements: res.placements };
  }

  private validity(m: SolverMate): string | null {
    if (m.a.body && m.a.body === m.b.body) return 'Both entities are on the same component';
    if (!m.a.body && !m.b.body) return 'A mate needs at least one component';
    if (m.type === 'lock' && !m.rel) return 'The lock mate has no stored position';
    return m.type === 'lock' ? null : mateProblem(m.type, m.a.geo, m.b.geo);
  }
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
  for (let grew = true; grew;) {
    grew = false;
    for (const m of mates) {
      const a = m.a.body, b = m.b.body;
      if (a && b && floating.has(a) && floating.has(b) && linked.has(a) !== linked.has(b)) { linked.add(a); linked.add(b); grew = true; }
    }
  }
  return mates.filter((m) => (m.a.body && linked.has(m.a.body)) || (m.b.body && linked.has(m.b.body)));
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
