// Geometric constraint solver for 2D sketches.
//
// Unknowns are point coordinates and circle radii. Each relation or driving
// dimension contributes one or more scalar residual equations. The system is
// split into independent clusters and each cluster is solved with a damped,
// minimum-norm Gauss-Newton iteration (dx = -J^T (J J^T + lambda I)^-1 r), which
// moves geometry as little as possible while satisfying the constraints.
// Jacobians are computed by central differences over each equation's few
// variables, which keeps every constraint definition to a single residual
// function. A rank analysis of the Jacobian reports degrees of freedom, which
// entities are fully defined and which constraints are redundant or conflict.

import type { Id, SkConstraint, SkDimension, SkEntity, SkRelation } from '../model/types';
import { isDimension } from '../model/types';
import { type Vec2, wrapAngle } from '../math/vec';
import { ORIGIN_ID, bezierPoint, splineBeziers } from './geom';

export type SketchStatus = 'under' | 'full' | 'over';

export type Drag =
  | { kind: 'points'; ids: Id[]; targets: Vec2[] }
  | { kind: 'radius'; id: Id; r: number };

export interface SolveOptions {
  /** Resolved value of a driving dimension (mm or degrees). */
  value: (d: SkDimension) => number;
  drag?: Drag;
  analyze?: boolean;
  maxIterations?: number;
}

export interface SolveResult {
  converged: boolean;
  residual: number;
  status: SketchStatus;
  dof: number;
  /** Entities that still have freedom (drawn in the under-defined colour). */
  freeEntities: Set<Id>;
  /** Constraints that are redundant or cannot be satisfied. */
  badConstraints: Set<Id>;
  /** Constraints that could not be satisfied (subset of badConstraints). */
  conflicting: Set<Id>;
}

interface Eq {
  vars: number[];
  f: (x: Float64Array) => number;
  cid: Id | null;
}

const TOL = 1e-9;

type PtAcc = (x: Float64Array) => Vec2;
type RAcc = (x: Float64Array) => number;

export class SketchSystem {
  x: Float64Array;
  fixed: Uint8Array;
  private pointVar = new Map<Id, number>();
  private radiusVar = new Map<Id, number>();
  private entity = new Map<Id, SkEntity>();
  private eqs: Eq[] = [];
  private nVars = 0;
  /** Variables owned by each entity (for definition status). */
  private entityVars = new Map<Id, number[]>();

  constructor(private entities: SkEntity[], private constraints: SkConstraint[], private opts: SolveOptions) {
    // Origin point is two fixed variables at zero.
    let n = 2;
    for (const e of entities) {
      this.entity.set(e.id, e);
      if (e.t === 'point') { this.pointVar.set(e.id, n); n += 2; }
      else if (e.t === 'circle') { this.radiusVar.set(e.id, n); n += 1; }
    }
    this.nVars = n;
    this.x = new Float64Array(n);
    this.fixed = new Uint8Array(n);
    this.fixed[0] = this.fixed[1] = 1;
    this.pointVar.set(ORIGIN_ID, 0);
    for (const e of entities) {
      if (e.t === 'point') {
        const i = this.pointVar.get(e.id)!;
        this.x[i] = e.x;
        this.x[i + 1] = e.y;
      } else if (e.t === 'circle') this.x[this.radiusVar.get(e.id)!] = e.r;
    }
    for (const e of entities) this.entityVars.set(e.id, this.varsOfEntity(e));
    // Geometry projected from the model is where the model puts it.
    for (const e of entities) if (e.ext) for (const v of this.entityVars.get(e.id)!) this.fixed[v] = 1;
    this.buildEquations();
  }

  private varsOfEntity(e: SkEntity): number[] {
    const pv = (id: Id) => { const i = this.pointVar.get(id); return i === undefined ? [] : [i, i + 1]; };
    switch (e.t) {
      case 'point': return pv(e.id);
      case 'line': return [...pv(e.a), ...pv(e.b)];
      case 'circle': return [...pv(e.c), this.radiusVar.get(e.id)!];
      case 'arc': return [...pv(e.c), ...pv(e.a), ...pv(e.b)];
      case 'spline': return e.pts.flatMap(pv);
    }
  }

  // ---- accessors producing residual building blocks ----

  private P(id: Id): { v: number[]; get: PtAcc } | null {
    const i = this.pointVar.get(id);
    if (i === undefined) return null;
    return { v: [i, i + 1], get: (x) => [x[i], x[i + 1]] };
  }

  private kind(id: Id): SkEntity['t'] | 'origin' | undefined {
    return id === ORIGIN_ID ? 'origin' : this.entity.get(id)?.t;
  }

  private isPointLike(id: Id) {
    const k = this.kind(id);
    return k === 'point' || k === 'origin';
  }

  private line(id: Id): { v: number[]; a: PtAcc; b: PtAcc } | null {
    const e = this.entity.get(id);
    if (!e || e.t !== 'line') return null;
    const a = this.P(e.a), b = this.P(e.b);
    if (!a || !b) return null;
    return { v: [...a.v, ...b.v], a: a.get, b: b.get };
  }

  /** Circle or arc: centre accessor and radius accessor. */
  private circ(id: Id): { v: number[]; c: PtAcc; r: RAcc } | null {
    const e = this.entity.get(id);
    if (!e) return null;
    if (e.t === 'circle') {
      const c = this.P(e.c);
      const ri = this.radiusVar.get(e.id)!;
      if (!c) return null;
      return { v: [...c.v, ri], c: c.get, r: (x) => x[ri] };
    }
    if (e.t === 'arc') {
      const c = this.P(e.c), a = this.P(e.a);
      if (!c || !a) return null;
      return { v: [...c.v, ...a.v], c: c.get, r: (x) => { const p = c.get(x), q = a.get(x); return Math.hypot(q[0] - p[0], q[1] - p[1]); } };
    }
    return null;
  }

  private add(vars: number[], f: (x: Float64Array) => number, cid: Id | null) {
    this.eqs.push({ vars: [...new Set(vars)], f, cid });
  }

  private buildEquations() {
    // Internal: arc end points stay on the arc's circle.
    const mirrored = this.mirroredArcs();
    for (const e of this.entities) {
      if (e.t !== 'arc' || mirrored.has(e.id)) continue;
      const c = this.P(e.c), a = this.P(e.a), b = this.P(e.b);
      if (!c || !a || !b) continue;
      this.add([...c.v, ...a.v, ...b.v], (x) => {
        const cc = c.get(x), aa = a.get(x), bb = b.get(x);
        return Math.hypot(bb[0] - cc[0], bb[1] - cc[1]) - Math.hypot(aa[0] - cc[0], aa[1] - cc[1]);
      }, null);
    }
    for (const c of this.constraints) {
      if (isDimension(c)) {
        if (!c.driven) this.buildDimension(c);
      } else this.buildRelation(c);
    }
  }

  /**
   * Arcs whose centre and end points are mirror images (symmetric relations
   * about one line, as Mirror Entities makes them) of an earlier arc's. Their
   * end points stay on their circle because the source arc's do, so that
   * equation would only make every mirrored arc redundant (over defined).
   */
  private mirroredArcs(): Set<Id> {
    const out = new Set<Id>();
    const partners = new Map<string, Set<Id>>();
    const key = (axis: Id, p: Id) => `${axis}\n${p}`;
    const pair = (axis: Id, p: Id, q: Id) => {
      const k = key(axis, p);
      const set = partners.get(k);
      if (set) set.add(q); else partners.set(k, new Set([q]));
    };
    const axes = new Set<Id>();
    const onAxis = new Set<string>();
    for (const c of this.constraints) {
      if (isDimension(c) || c.refs.length < 2) continue;
      if (c.type === 'symmetric' && c.refs.length === 3) {
        const [p, q, axis] = c.refs;
        if (!this.isPointLike(p) || !this.isPointLike(q) || !this.line(axis)) continue;
        pair(axis, p, q);
        pair(axis, q, p);
        axes.add(axis);
      } else if (c.type === 'coincident' && c.refs.length === 2) {
        onAxis.add(key(c.refs[1], c.refs[0]));
        onAxis.add(key(c.refs[0], c.refs[1]));
      }
    }
    if (!axes.size) return out;
    // A point held on the axis is its own mirror image.
    const mirrors = (axis: Id, p: Id, q: Id) => {
      if (partners.get(key(axis, p))?.has(q)) return true;
      if (p !== q) return false;
      const l = this.entity.get(axis) as Extract<SkEntity, { t: 'line' }>;
      return p === l.a || p === l.b || onAxis.has(key(axis, p));
    };
    const arcs = this.entities.filter((e): e is Extract<SkEntity, { t: 'arc' }> => e.t === 'arc');
    for (let j = 1; j < arcs.length; j++) {
      const f = arcs[j];
      search: for (const axis of axes) {
        for (let i = 0; i < j; i++) {
          const e = arcs[i];
          if (mirrors(axis, e.c, f.c) && mirrors(axis, e.a, f.b) && mirrors(axis, e.b, f.a)) { out.add(f.id); break search; }
        }
      }
    }
    return out;
  }

  private pointOnCurve(pid: Id, cid: Id, owner: Id) {
    const p = this.P(pid);
    if (!p) return;
    const k = this.kind(cid);
    if (k === 'line') {
      const l = this.line(cid)!;
      this.add([...p.v, ...l.v], (x) => signedDist(p.get(x), l.a(x), l.b(x)), owner);
    } else if (k === 'circle' || k === 'arc') {
      const c = this.circ(cid)!;
      this.add([...p.v, ...c.v], (x) => { const pp = p.get(x), cc = c.c(x); return Math.hypot(pp[0] - cc[0], pp[1] - cc[1]) - c.r(x); }, owner);
    } else if (k === 'spline') {
      const e = this.entity.get(cid) as Extract<SkEntity, { t: 'spline' }>;
      const ps = e.pts.map((id) => this.P(id));
      if (ps.length < 2 || ps.some((q) => !q)) return;
      const pa = ps as { v: number[]; get: PtAcc }[];
      this.add([...p.v, ...pa.flatMap((q) => q.v)], (x) => splineSignedDist(p.get(x), pa.map((q) => q.get(x))), owner);
    }
  }

  private coincidentPoints(a: Id, b: Id, owner: Id) {
    const p = this.P(a), q = this.P(b);
    if (!p || !q) return;
    this.add([...p.v, ...q.v], (x) => p.get(x)[0] - q.get(x)[0], owner);
    this.add([...p.v, ...q.v], (x) => p.get(x)[1] - q.get(x)[1], owner);
  }

  private buildRelation(c: SkRelation) {
    const [r0, r1, r2] = c.refs;
    const id = c.id;
    switch (c.type) {
      case 'coincident': {
        if (this.isPointLike(r0) && this.isPointLike(r1)) this.coincidentPoints(r0, r1, id);
        else if (this.isPointLike(r0)) this.pointOnCurve(r0, r1, id);
        else if (this.isPointLike(r1)) this.pointOnCurve(r1, r0, id);
        break;
      }
      case 'horizontal':
      case 'vertical': {
        const axis = c.type === 'horizontal' ? 1 : 0;
        type PA = { v: number[]; get: PtAcc } | null;
        let a: PA = null;
        let b: PA = null;
        if (c.refs.length === 1) {
          const l = this.entity.get(r0);
          if (l?.t === 'line') { a = this.P(l.a); b = this.P(l.b); }
        } else { a = this.P(r0); b = this.P(r1); }
        if (a && b) {
          const A = a, B = b;
          this.add([...A.v, ...B.v], (x) => A.get(x)[axis] - B.get(x)[axis], id);
        }
        break;
      }
      case 'parallel':
      case 'perpendicular': {
        for (let i = 1; i < c.refs.length; i++) {
          const l1 = this.line(c.refs[0]), l2 = this.line(c.refs[i]);
          if (!l1 || !l2) continue;
          const par = c.type === 'parallel';
          this.add([...l1.v, ...l2.v], (x) => {
            const d1 = dir(l1.a(x), l1.b(x)), d2 = dir(l2.a(x), l2.b(x));
            const n = Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1]) || 1e-12;
            return (par ? d1[0] * d2[1] - d1[1] * d2[0] : d1[0] * d2[0] + d1[1] * d2[1]) / n;
          }, id);
        }
        break;
      }
      case 'collinear': {
        for (let i = 1; i < c.refs.length; i++) {
          const l2 = this.entity.get(c.refs[i]);
          if (l2?.t !== 'line') continue;
          this.pointOnCurve(l2.a, r0, id);
          this.pointOnCurve(l2.b, r0, id);
        }
        break;
      }
      case 'equal': {
        for (let i = 1; i < c.refs.length; i++) {
          const a = c.refs[0], b = c.refs[i];
          const la = this.line(a), lb = this.line(b);
          if (la && lb) {
            this.add([...la.v, ...lb.v], (x) => len(la.a(x), la.b(x)) - len(lb.a(x), lb.b(x)), id);
            continue;
          }
          const ca = this.circ(a), cb = this.circ(b);
          if (ca && cb) this.add([...ca.v, ...cb.v], (x) => ca.r(x) - cb.r(x), id);
        }
        break;
      }
      case 'concentric': {
        const ca = this.circ(r0), cb = this.circ(r1);
        const ea = this.entity.get(r0), eb = this.entity.get(r1);
        const centerOf = (e: SkEntity | undefined, rid: Id) =>
          e && (e.t === 'circle' || e.t === 'arc') ? e.c : this.isPointLike(rid) ? rid : null;
        const pa = ca ? centerOf(ea, r0) : centerOf(undefined, r0);
        const pb = cb ? centerOf(eb, r1) : centerOf(undefined, r1);
        if (pa && pb) this.coincidentPoints(pa, pb, id);
        break;
      }
      case 'tangent': {
        let lineId: Id | null = null;
        const circs: Id[] = [];
        for (const r of c.refs) {
          const k = this.kind(r);
          if (k === 'line') lineId = r;
          else if (k === 'circle' || k === 'arc') circs.push(r);
        }
        // When the curves share an end point, "distance to centre equals the
        // radius" has a zero gradient at the solution. Requiring the radius at
        // the shared point to be perpendicular to the line (or the two centres
        // to be collinear with it) is equivalent and well conditioned.
        const shared = this.sharedEndPoint(c.refs);
        if (lineId && circs.length >= 1) {
          const l = this.line(lineId)!, cc = this.circ(circs[0])!;
          const p = shared ? this.P(shared) : null;
          if (p) {
            this.add([...l.v, ...cc.v, ...p.v], (x) => {
              const d = dir(l.a(x), l.b(x));
              const pp = p.get(x), ce = cc.c(x);
              const rx = pp[0] - ce[0], ry = pp[1] - ce[1];
              return (rx * d[0] + ry * d[1]) / ((Math.hypot(d[0], d[1]) * Math.hypot(rx, ry)) || 1e-12);
            }, id);
          } else this.add([...l.v, ...cc.v], (x) => Math.abs(signedDist(cc.c(x), l.a(x), l.b(x))) - cc.r(x), id);
        } else if (circs.length === 2 && shared) {
          const a = this.circ(circs[0])!, b = this.circ(circs[1])!;
          const p = this.P(shared)!;
          this.add([...a.v, ...b.v, ...p.v], (x) => {
            const pp = p.get(x), c1 = a.c(x), c2 = b.c(x);
            const u: Vec2 = [pp[0] - c1[0], pp[1] - c1[1]], w: Vec2 = [pp[0] - c2[0], pp[1] - c2[1]];
            return (u[0] * w[1] - u[1] * w[0]) / ((Math.hypot(u[0], u[1]) * Math.hypot(w[0], w[1])) || 1e-12);
          }, id);
        } else if (circs.length === 2) {
          const a = this.circ(circs[0])!, b = this.circ(circs[1])!;
          const internal = !!c.internal;
          this.add([...a.v, ...b.v], (x) => {
            const d = len(a.c(x), b.c(x));
            return internal ? d - Math.abs(a.r(x) - b.r(x)) : d - (a.r(x) + b.r(x));
          }, id);
        }
        break;
      }
      case 'midpoint': {
        const pid = this.isPointLike(r0) ? r0 : r1;
        const lid = pid === r0 ? r1 : r0;
        const p = this.P(pid), l = this.line(lid);
        if (!p || !l) break;
        this.add([...p.v, ...l.v], (x) => p.get(x)[0] - (l.a(x)[0] + l.b(x)[0]) / 2, id);
        this.add([...p.v, ...l.v], (x) => p.get(x)[1] - (l.a(x)[1] + l.b(x)[1]) / 2, id);
        break;
      }
      case 'symmetric': {
        // refs: point/entity a, point/entity b, symmetry line (last).
        const lid = c.refs[c.refs.length - 1];
        const l = this.line(lid);
        if (!l) break;
        const pairs: [Id, Id][] = [];
        const ea = this.entity.get(r0), eb = this.entity.get(r1);
        if (this.isPointLike(r0) && this.isPointLike(r1)) pairs.push([r0, r1]);
        else if (ea?.t === 'line' && eb?.t === 'line') {
          // Each end pairs with the end nearer its mirror image: two lines
          // drawn in the same direction pair crosswise, and pairing them
          // start-to-start would fold both lines onto the axis.
          const at = (id: Id) => this.P(id)?.get(this.x) ?? [NaN, NaN] as Vec2;
          const la = l.a(this.x), lb = l.b(this.x);
          // The two residuals of a symmetric point pair, as below.
          const miss = (p: Id, q: Id) => {
            const a = at(p), b = at(q), d = dir(la, lb);
            return Math.abs(signedDist([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], la, lb))
              + Math.abs((b[0] - a[0]) * d[0] + (b[1] - a[1]) * d[1]) / (len(la, lb) || 1e-12);
          };
          if (miss(ea.a, eb.b) + miss(ea.b, eb.a) < miss(ea.a, eb.a) + miss(ea.b, eb.b)) pairs.push([ea.a, eb.b], [ea.b, eb.a]);
          else pairs.push([ea.a, eb.a], [ea.b, eb.b]);
        }
        else if ((ea?.t === 'circle' || ea?.t === 'arc') && (eb?.t === 'circle' || eb?.t === 'arc')) {
          pairs.push([ea.c, eb.c]);
          const ca = this.circ(r0)!, cb = this.circ(r1)!;
          this.add([...ca.v, ...cb.v], (x) => ca.r(x) - cb.r(x), id);
        }
        void r2;
        for (const [ia, ib] of pairs) {
          const p = this.P(ia), q = this.P(ib);
          if (!p || !q) continue;
          this.add([...p.v, ...q.v, ...l.v], (x) => {
            const a = p.get(x), b = q.get(x);
            return signedDist([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], l.a(x), l.b(x));
          }, id);
          this.add([...p.v, ...q.v, ...l.v], (x) => {
            const a = p.get(x), b = q.get(x), d = dir(l.a(x), l.b(x));
            return ((b[0] - a[0]) * d[0] + (b[1] - a[1]) * d[1]) / (Math.hypot(d[0], d[1]) || 1e-12);
          }, id);
        }
        break;
      }
      case 'fix': {
        for (const r of c.refs) {
          const e = this.entity.get(r);
          if (!e) continue;
          for (const v of this.varsOfEntity(e)) this.fixed[v] = 1;
        }
        break;
      }
    }
  }

  private buildDimension(d: SkDimension) {
    const val = () => this.opts.value(d);
    const id = d.id;
    const refs = d.refs;
    const kinds = refs.map((r) => this.kind(r));
    switch (d.type) {
      case 'radius':
      case 'diameter': {
        const c = this.circ(refs[0]);
        if (!c) return;
        const k = d.type === 'diameter' ? 2 : 1;
        this.add(c.v, (x) => k * c.r(x) - val(), id);
        return;
      }
      case 'angle': {
        const l1 = this.line(refs[0]);
        if (!l1) return;
        const l2 = refs[1] ? this.line(refs[1]) : null;
        const sector = d.sector ?? 0;
        const s1 = sector & 1 ? -1 : 1, s2 = sector & 2 ? -1 : 1;
        this.add([...l1.v, ...(l2?.v ?? [])], (x) => {
          const a = dir(l1.a(x), l1.b(x));
          const b: Vec2 = l2 ? dir(l2.a(x), l2.b(x)) : [1, 0];
          const ang = Math.atan2(s1 * a[0] * s2 * b[1] - s1 * a[1] * s2 * b[0], s1 * a[0] * s2 * b[0] + s1 * a[1] * s2 * b[1]);
          return wrapAngle(Math.abs(ang) - (val() * Math.PI) / 180);
        }, id);
        return;
      }
      case 'hdistance':
      case 'vdistance': {
        const axis = d.type === 'hdistance' ? 0 : 1;
        const pts = this.dimPoints(refs);
        if (!pts) return;
        const [p, q] = pts;
        this.add([...p.v, ...q.v], (x) => Math.abs(q.get(x)[axis] - p.get(x)[axis]) - val(), id);
        return;
      }
      case 'distance': {
        // point-point, line length, point-line, parallel line-line, centre distances.
        if (refs.length === 1 && kinds[0] === 'line') {
          const l = this.line(refs[0])!;
          this.add(l.v, (x) => len(l.a(x), l.b(x)) - val(), id);
          return;
        }
        const li = kinds.indexOf('line');
        if (refs.length === 2 && li >= 0) {
          const other = refs[1 - li];
          const l = this.line(refs[li])!;
          const ok = this.kind(other);
          if (ok === 'line') {
            const l2 = this.line(other)!;
            this.add([...l.v, ...l2.v], (x) => {
              const a = l2.a(x), b = l2.b(x);
              return Math.abs(signedDist([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], l.a(x), l.b(x))) - val();
            }, id);
            return;
          }
          const pt = this.centerOrPoint(other);
          if (!pt) return;
          this.add([...l.v, ...pt.v], (x) => Math.abs(signedDist(pt.get(x), l.a(x), l.b(x))) - val(), id);
          return;
        }
        const pts = this.dimPoints(refs);
        if (!pts) return;
        const [p, q] = pts;
        this.add([...p.v, ...q.v], (x) => len(p.get(x), q.get(x)) - val(), id);
        return;
      }
    }
  }

  /** End point shared by two curves (lines and arcs), if any. */
  private sharedEndPoint(refs: Id[]): Id | null {
    const ends = (id: Id): Id[] => {
      const e = this.entity.get(id);
      return e && (e.t === 'line' || e.t === 'arc') ? [e.a, e.b] : [];
    };
    if (refs.length < 2) return null;
    const a = ends(refs[0]), b = ends(refs[1]);
    return a.find((p) => b.includes(p)) ?? null;
  }

  private centerOrPoint(id: Id): { v: number[]; get: PtAcc } | null {
    const e = this.entity.get(id);
    if (e && (e.t === 'circle' || e.t === 'arc')) return this.P(e.c);
    return this.P(id);
  }

  private dimPoints(refs: Id[]): [{ v: number[]; get: PtAcc }, { v: number[]; get: PtAcc }] | null {
    if (refs.length === 1) {
      const e = this.entity.get(refs[0]);
      if (e?.t === 'line') {
        const a = this.P(e.a), b = this.P(e.b);
        return a && b ? [a, b] : null;
      }
      return null;
    }
    const a = this.centerOrPoint(refs[0]), b = this.centerOrPoint(refs[1]);
    return a && b ? [a, b] : null;
  }

  // ---- numerical core ----

  private residuals(eqs: Eq[], r: Float64Array): number {
    let s = 0;
    for (let i = 0; i < eqs.length; i++) {
      const v = eqs[i].f(this.x);
      r[i] = Number.isFinite(v) ? v : 1e6;
      s += r[i] * r[i];
    }
    return Math.sqrt(s);
  }

  /** Sparse Jacobian rows over the free variables of a cluster. */
  private jacobian(eqs: Eq[], local: Map<number, number>): { cols: Int32Array[]; vals: Float64Array[] } {
    const x = this.x;
    const cols: Int32Array[] = [];
    const vals: Float64Array[] = [];
    for (const eq of eqs) {
      const free = eq.vars.filter((v) => !this.fixed[v] && local.has(v));
      const c = new Int32Array(free.length);
      const val = new Float64Array(free.length);
      for (let k = 0; k < free.length; k++) {
        const v = free[k];
        const x0 = x[v];
        const h = 1e-7 * Math.max(1, Math.abs(x0));
        x[v] = x0 + h;
        const fp = eq.f(x);
        x[v] = x0 - h;
        const fm = eq.f(x);
        x[v] = x0;
        c[k] = local.get(v)!;
        const g = (fp - fm) / (2 * h);
        val[k] = Number.isFinite(g) ? g : 0;
      }
      cols.push(c);
      vals.push(val);
    }
    return { cols, vals };
  }

  private solveCluster(eqs: Eq[], vars: number[], maxIter: number): boolean {
    const m = eqs.length;
    const n = vars.length;
    const local = new Map<number, number>();
    vars.forEach((v, i) => local.set(v, i));
    const r = new Float64Array(m);
    const rTry = new Float64Array(m);
    let norm = this.residuals(eqs, r);
    if (norm < TOL) return true;
    if (n === 0) return false;
    let lambda = 1e-10;
    const A = new Float64Array(m * m);
    const y = new Float64Array(m);
    const dx = new Float64Array(n);
    const saved = new Float64Array(n);
    for (let iter = 0; iter < maxIter; iter++) {
      const { cols, vals } = this.jacobian(eqs, local);
      // A = J J^T, built column-wise to exploit sparsity.
      A.fill(0);
      const byCol: { row: number; v: number }[][] = Array.from({ length: n }, () => []);
      for (let i = 0; i < m; i++) for (let k = 0; k < cols[i].length; k++) byCol[cols[i][k]].push({ row: i, v: vals[i][k] });
      for (const list of byCol) {
        for (let a = 0; a < list.length; a++) {
          const ra = list[a];
          for (let b = a; b < list.length; b++) {
            const rb = list[b];
            const p = ra.v * rb.v;
            A[ra.row * m + rb.row] += p;
            if (ra.row !== rb.row) A[rb.row * m + ra.row] += p;
          }
        }
      }
      let trace = 0;
      for (let i = 0; i < m; i++) trace += A[i * m + i];
      const mu = lambda * Math.max(trace / m, 1e-12);
      for (let i = 0; i < m; i++) A[i * m + i] += mu;
      y.set(r);
      if (!cholSolve(A, y, m)) { lambda *= 100; if (lambda > 1e6) return false; continue; }
      dx.fill(0);
      for (let i = 0; i < m; i++) {
        const yi = y[i];
        if (!yi) continue;
        const c = cols[i], v = vals[i];
        for (let k = 0; k < c.length; k++) dx[c[k]] -= v[k] * yi;
      }
      for (let k = 0; k < n; k++) saved[k] = this.x[vars[k]];
      // Backtracking line search on the residual norm.
      let alpha = 1;
      let improved = false;
      for (let ls = 0; ls < 12; ls++) {
        for (let k = 0; k < n; k++) this.x[vars[k]] = saved[k] + alpha * dx[k];
        const nn = this.residuals(eqs, rTry);
        if (nn < norm || nn < TOL) {
          norm = nn;
          r.set(rTry);
          improved = true;
          break;
        }
        alpha *= 0.5;
      }
      if (!improved) {
        for (let k = 0; k < n; k++) this.x[vars[k]] = saved[k];
        lambda *= 100;
        if (lambda > 1e6) return norm < TOL;
        continue;
      }
      lambda = Math.max(1e-12, lambda / 10);
      if (norm < TOL) return true;
    }
    return norm < TOL * 100;
  }

  /** Splits equations into clusters connected through free variables. */
  private clusters(): { eqs: Eq[]; vars: number[] }[] {
    const parent = new Int32Array(this.nVars).map((_, i) => i);
    const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (const eq of this.eqs) {
      const free = eq.vars.filter((v) => !this.fixed[v]);
      for (let i = 1; i < free.length; i++) {
        const a = find(free[0]), b = find(free[i]);
        if (a !== b) parent[a] = b;
      }
    }
    const groups = new Map<number, { eqs: Eq[]; vars: Set<number> }>();
    const orphan: Eq[] = [];
    for (const eq of this.eqs) {
      const free = eq.vars.filter((v) => !this.fixed[v]);
      if (!free.length) { orphan.push(eq); continue; }
      const root = find(free[0]);
      let g = groups.get(root);
      if (!g) groups.set(root, (g = { eqs: [], vars: new Set() }));
      g.eqs.push(eq);
      for (const v of free) g.vars.add(v);
    }
    const out = [...groups.values()].map((g) => ({ eqs: g.eqs, vars: [...g.vars] }));
    if (orphan.length) out.push({ eqs: orphan, vars: [] });
    return out;
  }

  private solveAll(maxIter: number): boolean {
    let ok = true;
    for (const c of this.clusters()) if (!this.solveCluster(c.eqs, c.vars, maxIter)) ok = false;
    return ok;
  }

  run(): SolveResult {
    const maxIter = this.opts.maxIterations ?? 60;
    const drag = this.opts.drag;
    const initial = this.x.slice();
    let converged: boolean;
    let folded: Id[] = [];
    if (drag) {
      const backup = this.x.slice();
      const fixedBackup = this.fixed.slice();
      const dragVars: number[] = [];
      if (drag.kind === 'points') {
        drag.ids.forEach((id, k) => {
          const i = this.pointVar.get(id);
          if (i === undefined || id === ORIGIN_ID) return;
          this.x[i] = drag.targets[k][0];
          this.x[i + 1] = drag.targets[k][1];
          dragVars.push(i, i + 1);
        });
      } else {
        const i = this.radiusVar.get(drag.id);
        if (i !== undefined) { this.x[i] = drag.r; dragVars.push(i); }
      }
      const userFixed = dragVars.some((v) => fixedBackup[v]);
      if (userFixed) {
        this.x.set(backup);
        converged = this.solveAll(maxIter);
      } else {
        for (const v of dragVars) this.fixed[v] = 1;
        converged = this.solveAll(maxIter);
        this.fixed.set(fixedBackup);
        if (!converged) {
          // Cannot reach the target exactly: project back onto the constraints
          // starting from the dragged position.
          converged = this.solveAll(maxIter);
          if (!converged) { this.x.set(backup); converged = this.solveAll(maxIter); }
        }
      }
    } else {
      converged = this.solveAll(maxIter);
      // A big change (a dimension well below its old value) can jump to a
      // solution where a fillet or tangent arc folds back over its line. Walk
      // there in small steps from the old shape instead; if the shape still
      // folds, the values cannot be met without inverting it: keep the old
      // shape and report the conflict rather than inverted geometry.
      if (this.newCusps(initial).length) {
        // An arc whose radius nothing sets shrinks through zero and flips:
        // first try keeping such radii (they are free, so any value solves).
        let cusps: Id[] = [];
        for (const attempt of [() => this.solveKeepingRadii(maxIter), () => this.solveByContinuation(maxIter)]) {
          this.x.set(initial);
          converged = attempt();
          cusps = this.newCusps(initial);
          if (converged && !cusps.length) break;
        }
        if (cusps.length) {
          this.x.set(initial);
          converged = false;
          folded = cusps;
        }
      }
    }
    // Overflow (e.g. from an absurd dimension value) must never reach the
    // document as NaN coordinates: keep the geometry as it was instead.
    if (!this.x.every(Number.isFinite)) {
      this.x.set(initial);
      converged = false;
    }

    const r = new Float64Array(this.eqs.length);
    const residual = this.residuals(this.eqs, r);
    const conflicting = new Set<Id>();
    for (let i = 0; i < this.eqs.length; i++) if (Math.abs(r[i]) > 1e-6 && this.eqs[i].cid) conflicting.add(this.eqs[i].cid!);
    for (const id of folded) conflicting.add(id);

    const res: SolveResult = {
      converged,
      residual,
      status: 'under',
      dof: 0,
      freeEntities: new Set(),
      badConstraints: new Set(conflicting),
      conflicting,
    };
    if (this.opts.analyze !== false) this.analyze(res);
    if (conflicting.size) res.status = 'over';
    return res;
  }

  /**
   * Solves from the current values towards the real system through blended
   * systems f(x) - (1 - t) f(x0) for t from 0 to 1 (each solved from the last),
   * which follows the solution branch of the starting shape.
   */
  private solveByContinuation(maxIter: number): boolean {
    const eqs = this.eqs;
    const r0 = new Float64Array(eqs.length);
    this.residuals(eqs, r0);
    const steps = 16;
    try {
      for (let k = 1; k < steps; k++) {
        const w = 1 - k / steps;
        this.eqs = eqs.map((e, i) => (r0[i] ? { ...e, f: (x: Float64Array) => e.f(x) - w * r0[i] } : e));
        this.solveAll(maxIter);
      }
    } finally {
      this.eqs = eqs;
    }
    return this.solveAll(maxIter);
  }

  /** Solves with the radius of every arc in an end-point tangency held. */
  private solveKeepingRadii(maxIter: number): boolean {
    const eqs = this.eqs;
    const held = new Set<Id>();
    for (const c of this.constraints) {
      if (c.type !== 'tangent' || !this.sharedEndPoint(c.refs)) continue;
      for (const r of c.refs) if (this.kind(r) === 'arc') held.add(r);
    }
    this.eqs = [...eqs];
    try {
      for (const id of held) {
        const cc = this.circ(id);
        if (!cc) continue;
        const r0 = cc.r(this.x);
        this.add(cc.v, (x) => cc.r(x) - r0, null);
      }
      if (!this.solveAll(maxIter)) return false;
    } finally {
      this.eqs = eqs;
    }
    return this.solveAll(maxIter);
  }

  /**
   * Tangent relations between curves sharing an end point (a fillet, a
   * tangent arc) that leave the point smoothly in the shape \`before\` but
   * double back on each other (a cusp) in the current one.
   */
  private newCusps(before: Float64Array): Id[] {
    const out: Id[] = [];
    const leaving = (x: Float64Array, id: Id, p: Id): Vec2 | null => {
      const e = this.entity.get(id);
      const at = this.P(p)!.get(x);
      if (e?.t === 'line') {
        const q = this.P(e.a === p ? e.b : e.a)?.get(x);
        return q ? [q[0] - at[0], q[1] - at[1]] : null;
      }
      if (e?.t !== 'arc') return null;
      const c = this.P(e.c)?.get(x);
      if (!c) return null;
      // Arcs run counter-clockwise from a to b.
      const s = e.a === p ? 1 : -1;
      return [-(at[1] - c[1]) * s, (at[0] - c[0]) * s];
    };
    const cosAt = (x: Float64Array, refs: Id[], p: Id): number | null => {
      const u = leaving(x, refs[0], p), w = leaving(x, refs[1], p);
      if (!u || !w) return null;
      const l = Math.hypot(u[0], u[1]) * Math.hypot(w[0], w[1]);
      return l > 1e-18 ? (u[0] * w[0] + u[1] * w[1]) / l : null;
    };
    for (const c of this.constraints) {
      if (c.type !== 'tangent' || c.refs.length !== 2) continue;
      const p = this.sharedEndPoint(c.refs);
      if (!p || !this.P(p)) continue;
      const was = cosAt(before, c.refs, p), now = cosAt(this.x, c.refs, p);
      if (was !== null && now !== null && was < 0 && now > 0.5) out.push(c.id);
    }
    return out;
  }

  /** Rank analysis: redundant constraints, free variables and entity status. */
  private analyze(res: SolveResult) {
    const freeVars: number[] = [];
    for (let v = 0; v < this.nVars; v++) if (!this.fixed[v]) freeVars.push(v);
    const local = new Map<number, number>();
    freeVars.forEach((v, i) => local.set(v, i));
    const n = freeVars.length;
    const { cols, vals } = this.jacobian(this.eqs, local);
    // Incremental row reduction: a row that reduces to zero is redundant and
    // is blamed on the later constraint.
    const basis: { row: Float64Array; pivot: number }[] = [];
    const undetermined = new Uint8Array(n);
    for (let i = 0; i < this.eqs.length; i++) {
      const row = new Float64Array(n);
      for (let k = 0; k < cols[i].length; k++) row[cols[i][k]] += vals[i][k];
      let scale = 0;
      for (let k = 0; k < n; k++) scale = Math.max(scale, Math.abs(row[k]));
      if (scale < 1e-12) {
        if (this.eqs[i].cid) res.badConstraints.add(this.eqs[i].cid!);
        continue;
      }
      for (const b of basis) {
        const f = row[b.pivot];
        if (f !== 0) {
          const br = b.row;
          for (let k = 0; k < n; k++) row[k] -= f * br[k];
        }
      }
      let piv = -1, best = 0;
      for (let k = 0; k < n; k++) { const a = Math.abs(row[k]); if (a > best) { best = a; piv = k; } }
      if (best < 1e-8 * scale) {
        if (this.eqs[i].cid) res.badConstraints.add(this.eqs[i].cid!);
        continue;
      }
      const inv = 1 / row[piv];
      for (let k = 0; k < n; k++) row[k] *= inv;
      // Keep the basis fully reduced so the pivot column is zero elsewhere.
      for (const b of basis) {
        const f = b.row[piv];
        if (f !== 0) for (let k = 0; k < n; k++) b.row[k] -= f * row[k];
      }
      basis.push({ row, pivot: piv });
    }
    const isPivot = new Uint8Array(n);
    for (const b of basis) isPivot[b.pivot] = 1;
    for (let k = 0; k < n; k++) if (!isPivot[k]) undetermined[k] = 1;
    for (const b of basis) {
      for (let k = 0; k < n; k++) {
        if (!isPivot[k] && Math.abs(b.row[k]) > 1e-7) { undetermined[b.pivot] = 1; break; }
      }
    }
    res.dof = n - basis.length;
    for (const [id, vs] of this.entityVars) {
      if (vs.some((v) => !this.fixed[v] && undetermined[local.get(v)!])) res.freeEntities.add(id);
    }
    res.status = res.badConstraints.size ? 'over' : res.dof === 0 ? 'full' : 'under';
  }

  /** Writes solved coordinates back into the entity objects. */
  writeBack() {
    for (const e of this.entities) {
      if (e.t === 'point') {
        const i = this.pointVar.get(e.id)!;
        e.x = this.x[i];
        e.y = this.x[i + 1];
      } else if (e.t === 'circle') e.r = Math.abs(this.x[this.radiusVar.get(e.id)!]);
    }
  }
}

function dir(a: Vec2, b: Vec2): Vec2 {
  return [b[0] - a[0], b[1] - a[1]];
}

function len(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Signed distance from p to the infinite line through a and b. */
function signedDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1e-12;
  return (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / l;
}

/**
 * Signed distance from p to a spline through pts: the distance along the
 * normal at the closest point. Past an open end it is the distance to the end
 * tangent, so the residual stays smooth there (like a line's infinite
 * extension).
 */
export function splineSignedDist(p: Vec2, pts: Vec2[]): number {
  const bz = splineBeziers(pts);
  if (!bz.length) return 0;
  // Coarse search for the closest segment and parameter.
  let bi = 0, bt = 0, bd = Infinity;
  const N = 16;
  for (let i = 0; i < bz.length; i++) {
    for (let j = 0; j <= N; j++) {
      const q = bezierPoint(bz[i], j / N);
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      if (d < bd) { bd = d; bi = i; bt = j / N; }
    }
  }
  // Newton refinement of (B(t) - p) . B'(t) = 0 within that segment.
  const b = bz[bi];
  let t = bt;
  for (let it = 0; it < 30; it++) {
    const q = bezierPoint(b, t), d1 = bezD1(b, t), d2 = bezD2(b, t);
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const g = ex * d1[0] + ey * d1[1];
    const h = d1[0] * d1[0] + d1[1] * d1[1] + ex * d2[0] + ey * d2[1];
    if (!(h > 0)) break;
    const nt = Math.min(1, Math.max(0, t - g / h));
    const done = Math.abs(nt - t) < 1e-15;
    t = nt;
    if (done) break;
  }
  const q = bezierPoint(b, t), d1 = bezD1(b, t);
  const l = Math.hypot(d1[0], d1[1]);
  if (l < 1e-12) return Math.hypot(p[0] - q[0], p[1] - q[1]);
  return (d1[0] * (p[1] - q[1]) - d1[1] * (p[0] - q[0])) / l;
}

function bezD1(b: Vec2[], t: number): Vec2 {
  const u = 1 - t;
  const a = 3 * u * u, c = 6 * u * t, d = 3 * t * t;
  return [
    a * (b[1][0] - b[0][0]) + c * (b[2][0] - b[1][0]) + d * (b[3][0] - b[2][0]),
    a * (b[1][1] - b[0][1]) + c * (b[2][1] - b[1][1]) + d * (b[3][1] - b[2][1]),
  ];
}

function bezD2(b: Vec2[], t: number): Vec2 {
  const u = 1 - t;
  return [
    6 * u * (b[2][0] - 2 * b[1][0] + b[0][0]) + 6 * t * (b[3][0] - 2 * b[2][0] + b[1][0]),
    6 * u * (b[2][1] - 2 * b[1][1] + b[0][1]) + 6 * t * (b[3][1] - 2 * b[2][1] + b[1][1]),
  ];
}

/**
 * In-place Cholesky solve of a symmetric positive definite system.
 *
 * Entries of a row left of its first non-zero stay zero in the factor (no
 * fill-in outside the envelope), so skipping them gives exactly the dense
 * result while costing far less for the near-banded systems of chained
 * sketch geometry.
 */
function cholSolve(A: Float64Array, b: Float64Array, n: number): boolean {
  const first = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let k = 0;
    while (k < i && A[i * n + k] === 0) k++;
    first[i] = k;
  }
  for (let j = 0; j < n; j++) {
    let s = A[j * n + j];
    for (let k = first[j]; k < j; k++) s -= A[j * n + k] * A[j * n + k];
    if (s <= 1e-300) return false;
    const d = Math.sqrt(s);
    A[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      if (first[i] > j) continue;
      let t = A[i * n + j];
      for (let k = Math.max(first[i], first[j]); k < j; k++) t -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = t / d;
    }
  }
  for (let i = 0; i < n; i++) {
    let t = b[i];
    for (let k = first[i]; k < i; k++) t -= A[i * n + k] * b[k];
    b[i] = t / A[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let t = b[i];
    for (let k = i + 1; k < n; k++) if (first[k] <= i) t -= A[k * n + i] * b[k];
    b[i] = t / A[i * n + i];
  }
  return true;
}

/** Convenience: solve a sketch in place and return the analysis. */
export function solveSketch(entities: SkEntity[], constraints: SkConstraint[], opts: SolveOptions): SolveResult {
  const sys = new SketchSystem(entities, constraints, opts);
  const res = sys.run();
  sys.writeBack();
  return res;
}
