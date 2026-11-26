// Drawing views beyond the standard ones: the direction each view looks from (projected,
// section and auxiliary views from their parent), the scale it is drawn at, which axis it
// shares with its parent, its projection request, and the model edges it shows (for
// dimensions and centre marks), plus the 2D geometry they need: hatching and clipping.

import type { EdgeInfo, ProjectionRequest } from '../kernel/protocol';
import { type Vec3, cross, dot, normalize, scale, sub } from '../math/vec';
import type { DrawingDoc, DrawingSide, DrawingView, DrawingViewType, Id } from '../model/types';
import { parseSvgPath } from './pdf';

export type P2 = [number, number];

/** Direction toward the viewer, paper x axis and paper up axis of a view, in the model. */
export interface Orient {
  dir: Vec3;
  x: Vec3;
  up: Vec3;
}

const STD: Record<string, { dir: Vec3; x: Vec3 }> = {
  front: { dir: [0, 0, 1], x: [1, 0, 0] },
  back: { dir: [0, 0, -1], x: [-1, 0, 0] },
  top: { dir: [0, 1, 0], x: [1, 0, 0] },
  bottom: { dir: [0, -1, 0], x: [1, 0, 0] },
  right: { dir: [1, 0, 0], x: [0, 0, -1] },
  left: { dir: [-1, 0, 0], x: [0, 0, 1] },
  isometric: { dir: normalize([1, 1, 1]), x: normalize(cross([0, 1, 0], normalize([1, 1, 1]))) },
};

/** The source of flat pattern views (the sheet metal part's flat pattern). */
export const FLAT_SOURCE = 'flat';

export const SIDE_VECTORS: Record<DrawingSide, P2> = { right: [1, 0], left: [-1, 0], above: [0, -1], below: [0, 1] };

export interface ResolvedView {
  v: DrawingView;
  type: DrawingViewType;
  o: Orient;
  /** Model millimetres to sheet millimetres. */
  scale: number;
  parent?: ResolvedView;
  /** The sheet axis it shares with its parent: 'x' (placed above or below) or 'y' (left or right). */
  align?: 'x' | 'y';
  /** Section views: the part kept is where (p - section.p) . section.n >= 0. */
  section?: { p: Vec3; n: Vec3 };
  /** Detail views: the circle shown, in the view's coordinates. */
  clip?: { c: P2; r: number };
  /** Paper direction from the parent's line toward this view (section and auxiliary views). */
  toward?: P2;
  /** Views that share a key share their projection. */
  key: string;
  source: string;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const rv = (v: Vec3) => v.map((q) => r6(q) || 0);

/** A view's coordinates (model millimetres, x right, y down) of a model point. */
export const toView = (o: Orient, p: Vec3): P2 => [dot(p, o.x), -dot(p, o.up)];
/** A model point (on the plane through the origin facing the viewer) at view coordinates q. */
export const fromView = (o: Orient, q: P2): Vec3 => [o.x[0] * q[0] - o.up[0] * q[1], o.x[1] * q[0] - o.up[1] * q[1], o.x[2] * q[0] - o.up[2] * q[1]];

/**
 * The view placed beside a parent, in the direction n2 on paper (y down), as the projection
 * angle places it: in third angle a view sits on the side it is seen from, in first angle on
 * the opposite side. Placed above or below, the parent's view direction is the view's up (or
 * down); placed left or right, the parent's up stays up as nearly as the direction allows.
 */
export function besideOrient(p: Orient, n2: P2, first: boolean): Orient {
  const [nx, ny] = n2;
  const N = normalize([p.x[0] * nx - p.up[0] * ny, p.x[1] * nx - p.up[1] * ny, p.x[2] * nx - p.up[2] * ny]);
  const dir = first ? scale(N, -1) : N;
  let up: Vec3;
  if (Math.abs(ny) >= Math.abs(nx)) up = scale(p.dir, (first ? 1 : -1) * Math.sign(-ny));
  else up = normalize(sub(p.up, scale(dir, dot(p.up, dir))));
  return { dir: z(dir), up: z(up), x: z(normalize(cross(up, dir))) };
}

/** Without negative zeros (so equal directions compare and key equal). */
const z = (v: Vec3): Vec3 => [v[0] || 0, v[1] || 0, v[2] || 0];

export function standardOrient(kind: string): Orient {
  const s = STD[kind] ?? STD.front;
  return { dir: s.dir, x: s.x, up: cross(s.dir, s.x) };
}

/** Unit left normal of a line on paper (y down): the side its view lies on. */
export function lineNormal(l: [number, number, number, number]): P2 {
  const dx = l[2] - l[0], dy = l[3] - l[1];
  const n = Math.hypot(dx, dy) || 1;
  return [-dy / n, dx / n];
}

const EPS_AXIS = 1e-9;

/**
 * Every view's direction, scale and relation to its parent. Views whose parent is missing
 * (or that form a cycle) are left out.
 */
export function resolveViews(d: DrawingDoc): Map<Id, ResolvedView> {
  const out = new Map<Id, ResolvedView>();
  const byId = new Map(d.views.map((v) => [v.id, v]));
  const first = d.projection === 'first';
  const visit = (v: DrawingView, depth: number): ResolvedView | undefined => {
    const done = out.get(v.id);
    if (done) return done;
    if (depth > 32) return undefined;
    const type: DrawingViewType = v.type ?? 'model';
    const source = v.source ?? 'part';
    let r: ResolvedView | undefined;
    if (type === 'flat') {
      // The flat pattern, seen from its top face (its own x and y on paper).
      r = { v, type, o: standardOrient('front'), scale: v.scale ?? d.scale, key: '', source: FLAT_SOURCE };
    } else if (type === 'model' || !v.parent) {
      const o = standardOrient(v.kind);
      r = { v, type: 'model', o, scale: v.scale ?? d.scale, key: '', source };
    } else {
      const pv = byId.get(v.parent);
      const parent = pv && pv.id !== v.id ? visit(pv, depth + 1) : undefined;
      if (!parent) return undefined;
      if (type === 'detail') {
        const c = v.circle ?? [0, 0, 10];
        r = { v, type, o: parent.o, scale: v.scale ?? parent.scale * 2, parent, clip: { c: [c[0], c[1]], r: Math.abs(c[2]) }, section: parent.section, key: '', source: parent.source };
      } else if (type === 'projected') {
        const side = v.side ?? 'right';
        r = { v, type, o: besideOrient(parent.o, SIDE_VECTORS[side], first), scale: parent.scale, parent, align: side === 'left' || side === 'right' ? 'y' : 'x', key: '', source: parent.source };
      } else {
        // Section and auxiliary views: beside the parent's line, on its left normal's side.
        const l = v.line ?? [0, 0, 1, 0];
        const n2 = lineNormal(l);
        const o = besideOrient(parent.o, n2, first);
        const align = Math.abs(n2[0]) < EPS_AXIS ? 'x' : Math.abs(n2[1]) < EPS_AXIS ? 'y' : undefined;
        r = { v, type, o, scale: parent.scale, parent, align, toward: n2, key: '', source: parent.source };
        if (type === 'section') {
          // The plane holds the line and the parent's direction; what lies between it and the viewer goes.
          const p = fromView(parent.o, [l[0], l[1]]);
          r.section = { p: rv(p) as Vec3, n: rv(scale(o.dir, -1)) as Vec3 };
        }
      }
    }
    r.key = JSON.stringify([r.source, rv(r.o.dir), rv(r.o.x), r.section ?? null, v.tangent !== false]);
    out.set(v.id, r);
    return r;
  };
  for (const v of d.views) visit(v, 0);
  return out;
}

/** The projection request of a view (id: its key). */
export function projectionRequest(r: ResolvedView, hidden: boolean): ProjectionRequest {
  const q: ProjectionRequest = { id: r.key, dir: r.o.dir, x: r.o.x, hidden };
  if (r.v.tangent === false) q.smooth = false;
  if (r.section) q.section = r.section;
  return q;
}

/** The views that depend on a view (projected from it, its sections and details...), deepest last. */
export function dependents(d: DrawingDoc, id: Id): Id[] {
  const out: Id[] = [];
  const walk = (p: Id) => {
    for (const v of d.views) if (v.parent === p && !out.includes(v.id) && v.id !== id) { out.push(v.id); walk(v.id); }
  };
  walk(id);
  return out;
}

/** The standard view a view's direction matches, if any. */
export function standardKindOf(o: Orient): string | null {
  for (const [k, s] of Object.entries(STD)) {
    if (k === 'isometric') continue;
    if (Math.abs(dot(s.dir, o.dir) - 1) < 1e-9 && Math.abs(dot(s.x, o.x) - 1) < 1e-9) return k;
  }
  return null;
}

// ---------- model edges seen in a view ----------

/** A model edge as seen in a view (view coordinates). */
export type Prim =
  | { edge: string; kind: 'line'; a: P2; b: P2 }
  | { edge: string; kind: 'arc'; c: P2; r: number; a: P2; b: P2; m: P2; full: boolean }
  /** Seen end-on, or a curve: only its end points can be picked. */
  | { edge: string; kind: 'points'; a: P2; b: P2 };

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

/**
 * The named model edges as seen in a view: lines, circles and arcs facing the viewer, and
 * circles seen edge on (as the line across them). A section view sees only what it keeps.
 */
export function viewPrims(r: ResolvedView, edges: EdgeInfo[]): Prim[] {
  const o = r.o;
  const out: Prim[] = [];
  const keep = (p: Vec3) => !r.section || dot(sub(p, r.section.p), r.section.n) >= -1e-6 * (1 + Math.abs(dot(p, r.section.n)));
  for (const e of edges) {
    // Seams (where a closed face meets itself) are not edges on a drawing.
    if (e.faces.length === 1) continue;
    if (r.section && !(keep(e.a) && keep(e.b) && keep(e.mid))) continue;
    const a = toView(o, e.a), b = toView(o, e.b);
    if (e.type === 'line') {
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) out.push({ edge: e.name, kind: 'points', a, b });
      else out.push({ edge: e.name, kind: 'line', a, b });
      continue;
    }
    if (e.type === 'circle' && e.center && e.axis && e.radius) {
      const c = toView(o, e.center);
      const ad = Math.abs(dot(normalize(e.axis), o.dir));
      const full = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7 * (1 + e.radius) && e.length > e.radius;
      if (near(ad, 1, 1e-9)) {
        out.push({ edge: e.name, kind: 'arc', c, r: e.radius, a, b, m: toView(o, e.mid), full });
        continue;
      }
      if (near(ad, 0, 1e-9) && full) {
        // Edge on: the line across it.
        const across = normalize(cross(e.axis, o.dir));
        const u = toView(o, across);
        const k = e.radius;
        // toView of a direction includes no translation (it is linear).
        out.push({ edge: e.name, kind: 'line', a: [c[0] - u[0] * k, c[1] - u[1] * k], b: [c[0] + u[0] * k, c[1] + u[1] * k] });
        continue;
      }
    }
    out.push({ edge: e.name, kind: 'points', a, b });
  }
  return out;
}

/** Holes and bosses seen end on: one circle per centre (the largest), and arcs of more than half a turn. */
export function centerMarks(prims: Prim[]): { c: P2; r: number; edge: string }[] {
  const out: { c: P2; r: number; edge: string }[] = [];
  for (const p of prims) {
    if (p.kind !== 'arc') continue;
    if (!p.full && !arcOverHalf(p)) continue;
    const same = out.find((q) => Math.hypot(q.c[0] - p.c[0], q.c[1] - p.c[1]) < 1e-6 * (1 + p.r));
    if (same) { if (p.r > same.r) { same.r = p.r; same.edge = p.edge; } continue; }
    out.push({ c: p.c, r: p.r, edge: p.edge });
  }
  return out;
}

/** An arc of more than half a turn: its centre lies between its chord and its middle. */
export function arcOverHalf(p: { a: P2; b: P2; m: P2; c: P2 }): boolean {
  const mx = (p.a[0] + p.b[0]) / 2, my = (p.a[1] + p.b[1]) / 2;
  return (p.m[0] - mx) * (p.c[0] - mx) + (p.m[1] - my) * (p.c[1] - my) > 0;
}

/**
 * Axes of holes and bosses seen from the side: the line between the centres of full circles of
 * the same radius on one axis, which the view sees edge on.
 */
export function holeAxes(r: ResolvedView, edges: EdgeInfo[]): { a: P2; b: P2; r: number }[] {
  const o = r.o;
  const groups: { p: Vec3; d: Vec3; rad: number; ts: number[] }[] = [];
  const keep = (p: Vec3) => !r.section || dot(sub(p, r.section.p), r.section.n) >= -1e-6 * (1 + Math.abs(dot(p, r.section.n)));
  for (const e of edges) {
    if (e.type !== 'circle' || !e.center || !e.axis || !e.radius) continue;
    if (Math.hypot(e.a[0] - e.b[0], e.a[1] - e.b[1], e.a[2] - e.b[2]) > 1e-7 * (1 + e.radius)) continue;
    const d = normalize(e.axis);
    if (Math.abs(dot(d, o.dir)) > 1e-9) continue;
    if (!keep(e.center)) continue;
    const g = groups.find((q) => near(q.rad, e.radius!, 1e-6 * (1 + e.radius!)) && Math.abs(Math.abs(dot(q.d, d)) - 1) < 1e-9
      && Math.hypot(...cross(sub(e.center!, q.p), q.d)) < 1e-6 * (1 + e.radius!));
    if (g) g.ts.push(dot(sub(e.center, g.p), g.d));
    else groups.push({ p: e.center, d, rad: e.radius, ts: [0] });
  }
  const out: { a: P2; b: P2; r: number }[] = [];
  for (const g of groups) {
    if (g.ts.length < 2) continue;
    const t0 = Math.min(...g.ts), t1 = Math.max(...g.ts);
    if (t1 - t0 < 1e-9) continue;
    const at = (t: number): Vec3 => [g.p[0] + g.d[0] * t, g.p[1] + g.d[1] * t, g.p[2] + g.d[2] * t];
    out.push({ a: toView(o, at(t0)), b: toView(o, at(t1)), r: g.rad });
  }
  return out;
}

// ---------- 2D geometry ----------

/**
 * Hatch lines inside the regions bounded by the segments (even-odd), at `angle` degrees and
 * `spacing` apart, as segments [x1, y1, x2, y2]. The lines are spaced from the origin, so the
 * hatching of neighbouring regions lines up.
 */
export function hatch(polylines: number[][], angle: number, spacing: number): [number, number, number, number][] {
  const a = (angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  // Rotate so the hatch lines run along x: v = -x sin + y cos is constant along a line.
  const segs: [number, number, number, number][] = [];
  let v0 = Infinity, v1 = -Infinity;
  for (const pl of polylines) {
    for (let i = 0; i + 3 < pl.length; i += 2) {
      const x1 = pl[i], y1 = pl[i + 1], x2 = pl[i + 2], y2 = pl[i + 3];
      const u1 = x1 * ca + y1 * sa, w1 = -x1 * sa + y1 * ca, u2 = x2 * ca + y2 * sa, w2 = -x2 * sa + y2 * ca;
      segs.push([u1, w1, u2, w2]);
      v0 = Math.min(v0, w1, w2); v1 = Math.max(v1, w1, w2);
    }
  }
  const out: [number, number, number, number][] = [];
  if (!segs.length || !(spacing > 0)) return out;
  if ((v1 - v0) / spacing > 20000) return out;
  for (let k = Math.ceil(v0 / spacing); k * spacing <= v1; k++) {
    const w = k * spacing;
    const xs: number[] = [];
    for (const [u1, w1, u2, w2] of segs) {
      // Half-open in w, so a line through a vertex counts it once.
      if ((w1 <= w && w2 > w) || (w2 <= w && w1 > w)) xs.push(u1 + ((w - w1) * (u2 - u1)) / (w2 - w1));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] < 1e-9) continue;
      const [ua, ub] = [xs[i], xs[i + 1]];
      out.push([ua * ca - w * sa, ua * sa + w * ca, ub * ca - w * sa, ub * sa + w * ca]);
    }
  }
  return out;
}

/** SVG path data (lines, arcs, curves) as polylines, transformed by x * s + t. */
export function flattenPath(d: string, tx: number, ty: number, s: number, tol = 0.05): P2[][] {
  const out: P2[][] = [];
  let cur: P2[] = [];
  let start: P2 = [0, 0];
  const T = (p: [number, number]): P2 => [p[0] * s + tx, p[1] * s + ty];
  for (const g of parseSvgPath(d)) {
    if (g.op === 'M') {
      if (cur.length > 1) out.push(cur);
      start = T(g.p);
      cur = [start];
    } else if (g.op === 'L') cur.push(T(g.p));
    else if (g.op === 'C') {
      const p0 = cur[cur.length - 1] ?? start, c1 = T(g.c1), c2 = T(g.c2), p3 = T(g.p);
      const L = Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(p3[0] - c2[0], p3[1] - c2[1]);
      const n = Math.max(2, Math.min(64, Math.ceil(Math.sqrt(L / Math.max(tol, 1e-6)))));
      for (let i = 1; i <= n; i++) {
        const t = i / n, m = 1 - t;
        cur.push([
          m * m * m * p0[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t * t * t * p3[0],
          m * m * m * p0[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t * t * t * p3[1],
        ]);
      }
    } else if (g.op === 'Z') cur.push(start);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** The parts of a polyline inside a circle. */
export function clipToCircle(pl: P2[], c: P2, r: number): P2[][] {
  const out: P2[][] = [];
  let cur: P2[] = [];
  const inside = (p: P2) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 <= r * r;
  for (let i = 0; i + 1 < pl.length; i++) {
    const p = pl[i], q = pl[i + 1];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const fx = p[0] - c[0], fy = p[1] - c[1];
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
    let t0 = 0, t1 = 1;
    if (A < 1e-18) { if (!inside(p)) { if (cur.length > 1) out.push(cur); cur = []; } continue; }
    const disc = B * B - 4 * A * C;
    if (disc <= 0) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    const sq = Math.sqrt(disc);
    t0 = Math.max(0, (-B - sq) / (2 * A));
    t1 = Math.min(1, (-B + sq) / (2 * A));
    if (t0 >= t1) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    const a: P2 = [p[0] + dx * t0, p[1] + dy * t0], b: P2 = [p[0] + dx * t1, p[1] + dy * t1];
    if (t0 > 0 || !cur.length) { if (cur.length > 1) out.push(cur); cur = [a]; }
    cur.push(b);
    if (t1 < 1) { out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

export const polyPath = (pl: P2[]) => `M${pl.map((p) => `${+p[0].toFixed(4)} ${+p[1].toFixed(4)}`).join('L')}`;
