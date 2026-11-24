/* eslint-disable @typescript-eslint/no-explicit-any */
// Thin helpers over the OpenCascade WebAssembly bindings: topology
// enumeration, surface/curve descriptors, transforms, booleans and fast mesh
// extraction straight from the WebAssembly heap.

import * as R from 'replicad';
import type { Frame, Vec3 } from '../math/vec';
import { cross, dot, len, normalize, scale, sub } from '../math/vec';
import { planeFrame } from '../model/planes';

export type OC = any;
let oc: OC = null;

export function setOc(instance: OC) {
  oc = instance;
  R.setOC(instance);
}

export const getOc = (): OC => {
  if (!oc) throw new Error('Geometry kernel is not loaded');
  return oc;
};

const HASH_MAX = 2147483647;

export const pnt = (p: Vec3) => new oc.gp_Pnt(p[0], p[1], p[2]);
export const gdir = (d: Vec3) => new oc.gp_Dir(d[0], d[1], d[2]);
export const gvec = (d: Vec3) => new oc.gp_Vec(d[0], d[1], d[2]);
export const xyz = (p: any): Vec3 => [p.X(), p.Y(), p.Z()];

/**
 * A replicad wrapper owning an OpenCascade shape. The wrapper frees the
 * native handle when it is garbage collected, so kernel code always keeps
 * wrappers (never bare handles) for anything that outlives a function call.
 */
export type Sh = { wrapped: any };

/** Wraps a raw TopoDS_Shape so it is freed when no longer referenced. */
export function wrap(raw: any): Sh {
  return R.cast(raw) as unknown as Sh;
}

export function hashOf(shape: any): number {
  return oc.ReplicadShapeHasher.HashCode(shape, HASH_MAX);
}

export type TopoKind = 'face' | 'edge' | 'vertex' | 'solid' | 'shell' | 'wire';

const kindEnum = (k: TopoKind) => {
  const e = oc.TopAbs_ShapeEnum;
  return { face: e.TopAbs_FACE, edge: e.TopAbs_EDGE, vertex: e.TopAbs_VERTEX, solid: e.TopAbs_SOLID, shell: e.TopAbs_SHELL, wire: e.TopAbs_WIRE }[k];
};

const downcastFn = (k: TopoKind) => ({ face: 'Face', edge: 'Edge', vertex: 'Vertex', solid: 'Solid', shell: 'Shell', wire: 'Wire' }[k]);

/**
 * Unique sub-shapes of a kind, in exploration order. Deduplicates with a
 * hash table (IsSame within buckets) so large models stay linear.
 */
export function subShapes(shape: Sh, kind: TopoKind, avoid?: TopoKind): Sh[] {
  const out: Sh[] = [];
  const buckets = new Map<number, any[]>();
  const ex = new oc.TopExp_Explorer(shape.wrapped, kindEnum(kind), avoid ? kindEnum(avoid) : oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const cast = oc.TopoDS[downcastFn(kind)];
  try {
    while (ex.More()) {
      const cur = ex.Current();
      const h = hashOf(cur);
      let list = buckets.get(h);
      if (!list) buckets.set(h, (list = []));
      if (!list.some((s) => s.IsSame(cur))) {
        const w = wrap(cast(cur));
        list.push(w.wrapped);
        out.push(w);
      }
      cur.delete?.();
      ex.Next();
    }
  } finally {
    ex.delete();
  }
  return out;
}

/** Index lookup of sub-shapes by hash + IsSame. */
export class ShapeIndex {
  private buckets = new Map<number, { s: any; i: number }[]>();
  constructor(readonly shapes: Sh[]) {
    shapes.forEach((w, i) => {
      const h = hashOf(w.wrapped);
      let l = this.buckets.get(h);
      if (!l) this.buckets.set(h, (l = []));
      l.push({ s: w.wrapped, i });
    });
  }
  find(raw: any): number {
    const l = this.buckets.get(hashOf(raw));
    if (!l) return -1;
    if (l.length === 1) return l[0].i;
    for (const e of l) if (e.s.IsSame(raw)) return e.i;
    return -1;
  }
  findHash(h: number): number[] {
    return (this.buckets.get(h) ?? []).map((e) => e.i);
  }
}

// ---- Surface and curve descriptors ----

export type SurfType = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'revolution' | 'extrusion' | 'other';

export interface SurfDesc {
  type: SurfType;
  /** plane: point on plane / axis point / sphere centre */
  p: Vec3;
  /** plane normal (outward) / axis direction */
  d: Vec3;
  r: number;
  center: Vec3;
  area: number;
}

export function faceProps(face: any): { center: Vec3; area: number } {
  // ace is a raw TopoDS_Face here.
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.SurfaceProperties(face, props, 1e-7, true);
    const c = props.CentreOfMass();
    const center = xyz(c);
    c.delete();
    return { center, area: props.Mass() };
  } finally {
    props.delete();
  }
}

export function describeFace(w: Sh): SurfDesc {
  const face = w.wrapped;
  const ga = oc.GeomAbs_SurfaceType;
  const ad = new oc.BRepAdaptor_Surface(face, true);
  const { center, area } = faceProps(face);
  const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
  try {
    const t = ad.GetType();
    if (t === ga.GeomAbs_Plane) {
      const pl = ad.Plane();
      const ax = pl.Axis();
      const pos = pl.Position();
      const d0 = ax.Direction();
      let d: Vec3 = xyz(d0);
      // The surface normal is X × Y, which is opposite to the axis for a
      // left-handed plane (revolved and mirrored faces have those).
      if (reversed !== !pos.Direct()) d = scale(d, -1);
      d0.delete(); ax.delete(); pos.delete(); pl.delete();
      return { type: 'plane', p: center, d, r: 0, center, area };
    }
    if (t === ga.GeomAbs_Cylinder) {
      const cy = ad.Cylinder();
      const ax = cy.Axis();
      const loc = ax.Location(), dd = ax.Direction();
      const out: SurfDesc = { type: 'cylinder', p: xyz(loc), d: xyz(dd), r: cy.Radius(), center, area };
      loc.delete(); dd.delete(); ax.delete(); cy.delete();
      return canonicalAxis(out);
    }
    if (t === ga.GeomAbs_Sphere) {
      const sp = ad.Sphere();
      const loc = sp.Location();
      const out: SurfDesc = { type: 'sphere', p: xyz(loc), d: [0, 0, 1], r: sp.Radius(), center, area };
      loc.delete(); sp.delete();
      return out;
    }
    const type: SurfType =
      t === ga.GeomAbs_Cone ? 'cone' : t === ga.GeomAbs_Torus ? 'torus' : t === ga.GeomAbs_BSplineSurface || t === ga.GeomAbs_BezierSurface ? 'bspline' : t === ga.GeomAbs_SurfaceOfRevolution ? 'revolution' : t === ga.GeomAbs_SurfaceOfExtrusion ? 'extrusion' : 'other';
    return { type, p: center, d: faceNormalAtCenter(face, ad), r: 0, center, area };
  } finally {
    ad.delete();
  }
}

/**
 * The point at the middle of a face's parameter range. On a face swept from
 * a curve it lies on the face, over the middle of the curve (the centroid of
 * a curved face can lie nearer another curve of the profile).
 */
export function faceMidPoint(w: Sh): Vec3 {
  const ad = new oc.BRepAdaptor_Surface(w.wrapped, true);
  try {
    const p = ad.Value((ad.FirstUParameter() + ad.LastUParameter()) / 2, (ad.FirstVParameter() + ad.LastVParameter()) / 2);
    const out = xyz(p);
    p.delete();
    return out;
  } finally {
    ad.delete();
  }
}

/** Approximate outward normal at the middle of the face's parameter range. */
function faceNormalAtCenter(face: any, ad: any): Vec3 {
  try {
    const u = (ad.FirstUParameter() + ad.LastUParameter()) / 2;
    const v = (ad.FirstVParameter() + ad.LastVParameter()) / 2;
    const p = new oc.gp_Pnt();
    const n = new oc.gp_Vec();
    const gf = new oc.BRepGProp_Face(face, false);
    gf.Normal(u, v, p, n);
    const out = normalize(xyz(n));
    p.delete(); n.delete(); gf.delete();
    return out;
  } catch {
    return [0, 0, 1];
  }
}

/** Puts an axis into a canonical form so equal lines compare equal. */
function canonicalAxis(d: SurfDesc): SurfDesc {
  let dir = normalize(d.d);
  const k = Math.abs(dir[0]) > 1e-9 ? 0 : Math.abs(dir[1]) > 1e-9 ? 1 : 2;
  if (dir[k] < 0) dir = scale(dir, -1);
  // Closest point on the axis to the world origin.
  const p = sub(d.p, scale(dir, dot(d.p, dir)));
  return { ...d, d: dir, p };
}

/** True when two descriptors describe the same underlying surface. */
export function sameSurface(a: SurfDesc, b: SurfDesc, tol: number): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'plane': {
      const c = dot(a.d, b.d);
      if (Math.abs(c) < 1 - 1e-9) return false;
      return Math.abs(dot(sub(b.p, a.p), a.d)) < tol;
    }
    case 'cylinder':
      return Math.abs(a.r - b.r) < tol && Math.abs(Math.abs(dot(a.d, b.d)) - 1) < 1e-9 && len(sub(a.p, b.p)) < tol;
    case 'sphere':
      return Math.abs(a.r - b.r) < tol && len(sub(a.p, b.p)) < tol;
    default:
      // No exact descriptor: same surface type, close centre and normal.
      return len(sub(a.center, b.center)) < tol * 10 && dot(a.d, b.d) > 0.999;
  }
}

/**
 * The faces' own surfaces (null when a face is moved by a location), looked
 * up once per comparison pass. The handles keep their surfaces alive, so they
 * are freed together when the pass is done (cached on the faces, they kept
 * every compared spline surface in memory for the life of the worker).
 */
export class SurfaceCache {
  private handles = new Map<Sh, any>();

  get(face: Sh): any {
    let s = this.handles.get(face);
    if (s === undefined) {
      const loc = new oc.TopLoc_Location();
      try {
        s = oc.BRep_Tool.Surface(face.wrapped, loc);
        if (!loc.IsIdentity()) { s.delete(); s = null; }
      } catch {
        s = null;
      } finally {
        loc.delete();
      }
      this.handles.set(face, s);
    }
    return s;
  }

  dispose() {
    for (const s of this.handles.values()) s?.delete();
    this.handles.clear();
  }
}

/**
 * True when two faces lie on one surface object: a face trimmed by a boolean
 * keeps its surface. Spline, torus and cone faces have no exact descriptor,
 * so this is how a trimmed one is told apart from a new face.
 */
export function sharesSurface(a: Sh, b: Sh, cache: SurfaceCache): boolean {
  const sa = cache.get(a), sb = cache.get(b);
  return !!sa && !!sb && sa.isAliasOf(sb);
}

/** Sketch frame for a planar face: origin is the projected world origin (see planeFrame). */
export function planarFaceFrame(desc: SurfDesc, x?: Vec3): Frame {
  return planeFrame(desc.p, desc.d, x);
}

export interface EdgeDesc {
  type: 'line' | 'circle' | 'ellipse' | 'bspline' | 'other';
  a: Vec3;
  b: Vec3;
  mid: Vec3;
  length: number;
  dir?: Vec3;
  center?: Vec3;
  axis?: Vec3;
  radius?: number;
  closed: boolean;
}

export function describeEdge(w: Sh): EdgeDesc {
  const edge = w.wrapped;
  const gc = oc.GeomAbs_CurveType;
  const ad = new oc.BRepAdaptor_Curve(edge);
  try {
    const f = ad.FirstParameter(), l = ad.LastParameter();
    const pa = ad.Value(f), pb = ad.Value(l), pm = ad.Value((f + l) / 2);
    const a = xyz(pa), b = xyz(pb), mid = xyz(pm);
    pa.delete(); pb.delete(); pm.delete();
    const props = new oc.GProp_GProps();
    oc.BRepGProp.LinearProperties(edge, props, true, false);
    const length = props.Mass();
    props.delete();
    const t = ad.GetType();
    const closed = len(sub(a, b)) < 1e-7 && length > 1e-7;
    if (t === gc.GeomAbs_Line) {
      return { type: 'line', a, b, mid, length, dir: normalize(sub(b, a)), closed: false };
    }
    if (t === gc.GeomAbs_Circle) {
      const c = ad.Circle();
      const ax = c.Axis();
      const loc = ax.Location(), dd = ax.Direction();
      const out: EdgeDesc = { type: 'circle', a, b, mid, length, center: xyz(loc), axis: xyz(dd), radius: c.Radius(), closed };
      loc.delete(); dd.delete(); ax.delete(); c.delete();
      return out;
    }
    const type = t === gc.GeomAbs_Ellipse ? 'ellipse' : t === gc.GeomAbs_BSplineCurve || t === gc.GeomAbs_BezierCurve ? 'bspline' : 'other';
    return { type, a, b, mid, length, closed };
  } finally {
    ad.delete();
  }
}

export function vertexPoint(w: Sh): Vec3 {
  const p = oc.BRep_Tool.Pnt(w.wrapped);
  const out = xyz(p);
  p.delete();
  return out;
}

// ---- Hidden-line projection ----

type P2 = [number, number];
/** One projected edge as path commands from its start (fwd) and from its end (rev). */
interface PathPiece { a: P2; b: P2; fwd: string; rev: string }

const fmt = (v: number) => {
  const s = String(Math.round(v * 1e4) / 1e4);
  return s === '-0' ? '0' : s;
};
const ptText = (p: P2) => `${fmt(p[0])} ${fmt(p[1])}`;

/**
 * A projected edge (in the projection plane, z = 0) as SVG path pieces with y pointing down:
 * lines and arcs of circles and ellipses exactly, other curves as polylines within `tol`.
 * Grows `box` ([minX, minY, maxX, maxY]) by the edge's exact extent when given.
 */
function edgePiece(edge: any, tol: number, box: number[] | null): PathPiece | null {
  const gc = oc.GeomAbs_CurveType;
  const ad = new oc.BRepAdaptor_Curve(edge);
  const grow = (p: P2) => {
    if (!box) return;
    box[0] = Math.min(box[0], p[0]); box[1] = Math.min(box[1], p[1]);
    box[2] = Math.max(box[2], p[0]); box[3] = Math.max(box[3], p[1]);
  };
  const at = (u: number): P2 => {
    const p = ad.Value(u);
    const out: P2 = [p.X(), -p.Y()];
    p.delete();
    return out;
  };
  try {
    const f = ad.FirstParameter(), l = ad.LastParameter();
    if (!(l > f)) return null;
    const t = ad.GetType();
    if (t === gc.GeomAbs_Line) {
      const a = at(f), b = at(l);
      grow(a); grow(b);
      return { a, b, fwd: `L${ptText(b)}`, rev: `L${ptText(a)}` };
    }
    if (t === gc.GeomAbs_Circle || t === gc.GeomAbs_Ellipse) {
      const conic = t === gc.GeomAbs_Circle ? ad.Circle() : ad.Ellipse();
      const pos = conic.Position();
      const loc = pos.Location(), xd = pos.XDirection(), yd = pos.YDirection();
      const ra = t === gc.GeomAbs_Circle ? conic.Radius() : conic.MajorRadius();
      const rb = t === gc.GeomAbs_Circle ? ra : conic.MinorRadius();
      // On paper (y down): p(u) = c + ra cos(u) X + rb sin(u) Y.
      const c: P2 = [loc.X(), -loc.Y()], X: P2 = [xd.X(), -xd.Y()], Y: P2 = [yd.X(), -yd.Y()];
      loc.delete(); xd.delete(); yd.delete(); pos.delete(); conic.delete();
      const p = (u: number): P2 => [c[0] + ra * Math.cos(u) * X[0] + rb * Math.sin(u) * Y[0], c[1] + ra * Math.cos(u) * X[1] + rb * Math.sin(u) * Y[1]];
      // The extremes along x and y, where they fall within the arc.
      for (const u0 of [Math.atan2(rb * Y[0], ra * X[0]), Math.atan2(rb * Y[1], ra * X[1])]) {
        for (let u = u0 - 2 * Math.PI * Math.ceil((u0 - f) / (2 * Math.PI) + 1); u <= l; u += Math.PI) if (u >= f) grow(p(u));
      }
      const a = p(f), b = p(l);
      grow(a); grow(b);
      // From X toward Y is SVG's direction of positive angles (sweep flag 1) when X x Y > 0.
      const sweep = X[0] * Y[1] - X[1] * Y[0] > 0 ? 1 : 0;
      const rot = fmt((Math.atan2(X[1], X[0]) * 180) / Math.PI);
      const arc = (from: number, to: number, s: number) => {
        const large = Math.abs(to - from) > Math.PI ? 1 : 0;
        return `A${fmt(ra)} ${fmt(rb)} ${rot} ${large} ${s} ${ptText(p(to))}`;
      };
      if (l - f < 1.5 * Math.PI) return { a, b, fwd: arc(f, l, sweep), rev: arc(l, f, 1 - sweep) };
      // A whole circle or ellipse is two arcs (one arc cannot end where it starts).
      const m = (f + l) / 2;
      return { a, b, fwd: arc(f, m, sweep) + arc(m, l, sweep), rev: arc(l, m, 1 - sweep) + arc(m, f, 1 - sweep) };
    }
    const pts: P2[] = [];
    const us: number[] = [];
    const td = new oc.GCPnts_TangentialDeflection(ad, f, l, 0.1, tol, 2, 1e-9, 1e-7);
    try {
      for (let i = 1; i <= td.NbPoints(); i++) {
        const q = td.Value(i);
        pts.push([q.X(), -q.Y()]);
        us.push(td.Parameter(i));
        q.delete();
      }
    } finally {
      td.delete();
    }
    if (pts.length < 2) return null;
    pts.forEach(grow);
    if (box) {
      // The curve's extremes lie between the points drawn: find them (the overall dimensions
      // must not read short by the chord's sag).
      for (const [axis, sign] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
        let i = 0;
        pts.forEach((q, j) => { if (sign * q[axis] > sign * pts[i][axis]) i = j; });
        let lo = us[Math.max(0, i - 1)], hi = us[Math.min(us.length - 1, i + 1)];
        for (let k = 0; k < 60 && hi - lo > 1e-12; k++) {
          const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
          if (sign * at(m1)[axis] < sign * at(m2)[axis]) lo = m1;
          else hi = m2;
        }
        grow(at((lo + hi) / 2));
      }
    }
    return {
      a: pts[0], b: pts[pts.length - 1],
      fwd: pts.slice(1).map((q) => `L${ptText(q)}`).join(''),
      rev: pts.slice(0, -1).reverse().map((q) => `L${ptText(q)}`).join(''),
    };
  } finally {
    ad.delete();
  }
}

/** The edges of a compound as SVG paths, joining edges that run on from one another. */
function compoundPaths(comp: any, tol: number, box: number[] | null): string[] {
  const paths: string[] = [];
  if (comp.IsNull()) return paths;
  const ex = new oc.TopExp_Explorer(comp, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let path = '';
  let end: P2 | null = null;
  const near = (p: P2, q: P2) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
  try {
    for (; ex.More(); ex.Next()) {
      const cur = ex.Current();
      const e = oc.TopoDS.Edge(cur);
      let piece: PathPiece | null = null;
      try {
        piece = edgePiece(e, tol, box);
      } finally {
        e.delete();
        cur.delete();
      }
      if (!piece) continue;
      if (end && near(end, piece.a)) { path += piece.fwd; end = piece.b; }
      else if (end && near(end, piece.b)) { path += piece.rev; end = piece.a; }
      else {
        if (path) paths.push(path);
        path = `M${ptText(piece.a)}${piece.fwd}`;
        end = piece.b;
      }
    }
  } finally {
    ex.delete();
  }
  if (path) paths.push(path);
  return paths;
}

/**
 * The seams of closed faces (where a revolved face's profile was) that lie along the silhouette
 * seen from `dir`. The hidden-line algorithm draws no seam and finds no outline along one on a
 * torus (or another surface it outlines numerically): a ring seen from the side lost half its
 * outline. Each such seam comes back as fine line segments a hair outside the surface (on its own
 * surface the algorithm hides it all), to be drawn as lines of their own; null when there are none.
 */
function silhouetteSeams(shape: Sh, dir: Vec3, hair: number): any | null {
  const T = oc.TopAbs_ShapeEnum;
  const gs = oc.GeomAbs_SurfaceType;
  const seen: any[] = [];
  const builder = new oc.TopoDS_Builder();
  const out = new oc.TopoDS_Compound();
  builder.MakeCompound(out);
  let any = false;
  const fx = new oc.TopExp_Explorer(shape.wrapped, T.TopAbs_FACE, T.TopAbs_SHAPE);
  try {
    for (; fx.More(); fx.Next()) {
      const fc = fx.Current();
      const face = oc.TopoDS.Face(fc);
      // Planes, cylinders, cones and spheres are outlined exactly, also along their seams.
      const sa = new oc.BRepAdaptor_Surface(face, false);
      const st = sa.GetType();
      sa.delete();
      if ([gs.GeomAbs_Plane, gs.GeomAbs_Cylinder, gs.GeomAbs_Cone, gs.GeomAbs_Sphere].includes(st)) { face.delete(); fc.delete(); continue; }
      const ex = new oc.TopExp_Explorer(face, T.TopAbs_EDGE, T.TopAbs_SHAPE);
      const gf = new oc.BRepGProp_Face(face, false);
      const p = new oc.gp_Pnt(), nv = new oc.gp_Vec();
      try {
        for (; ex.More(); ex.Next()) {
          const ec = ex.Current();
          const edge = oc.TopoDS.Edge(ec);
          ec.delete();
          // A seam is in its face twice (once each way).
          if (!oc.BRep_Tool.IsClosed(edge, face) || seen.some((e) => e.IsSame(edge))) { edge.delete(); continue; }
          seen.push(edge);
          const c2 = new oc.BRepAdaptor_Curve2d(edge, face);
          const qs: Vec3[] = [], ns: Vec3[] = [];
          try {
            const f = c2.FirstParameter(), l = c2.LastParameter();
            for (let i = 0; i <= 128; i++) {
              const uv = c2.Value(f + ((l - f) * i) / 128);
              gf.Normal(uv.X(), uv.Y(), p, nv);
              uv.delete();
              const nrm = xyz(nv), m = len(nrm);
              // At a pole the normal has no length and says nothing.
              if (m > 1e-12 && Math.abs(dot(nrm, dir)) > 1e-6 * m) { qs.length = 0; break; }
              qs.push(xyz(p));
              ns.push(m > 1e-12 ? scale(nrm, 1 / m) : [0, 0, 0]);
            }
          } finally {
            c2.delete();
          }
          if (qs.length < 2) continue;
          // Out by the hair, and by as much again as the curve sags between the points, so the
          // segments between them stay outside the surface too.
          let sag = 0;
          for (let i = 1; i + 1 < qs.length; i++) {
            const a = qs[i - 1], b = qs[i + 1], d = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(qs[i], a), d) / Math.max(dot(d, d), 1e-30)));
            sag = Math.max(sag, dist3(qs[i], [a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]]));
          }
          const pts = qs.map((q, i) => [q[0] + (hair + sag) * ns[i][0], q[1] + (hair + sag) * ns[i][1], q[2] + (hair + sag) * ns[i][2]] as Vec3);
          const add = (e: any) => { builder.Add(out, e); e.delete(); any = true; };
          const ad = new oc.BRepAdaptor_Curve(edge);
          try {
            if (ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Circle) {
              // A circle (a revolved arc's seam, a ring's) stays one: the same circle grown or shrunk by the hair.
              const c = ad.Circle(), pos = c.Position(), loc = pos.Location();
              const r = dist3(add3(qs[64], scale(ns[64], hair)), xyz(loc));
              const circ = new oc.gp_Circ(pos, r);
              const mk = new oc.BRepBuilderAPI_MakeEdge(circ, ad.FirstParameter(), ad.LastParameter());
              add(mk.Edge());
              mk.delete(); circ.delete(); loc.delete(); pos.delete(); c.delete();
            } else {
              for (let i = 1; i < pts.length; i++) {
                if (dist3(pts[i - 1], pts[i]) < 1e-9) continue;
                const a = pnt(pts[i - 1]), b = pnt(pts[i]);
                const mk = new oc.BRepBuilderAPI_MakeEdge(a, b);
                add(mk.Edge());
                mk.delete(); a.delete(); b.delete();
              }
            }
          } finally {
            ad.delete();
          }
        }
      } finally {
        ex.delete(); gf.delete(); p.delete(); nv.delete(); face.delete(); fc.delete();
      }
    }
  } finally {
    fx.delete();
    for (const e of seen) e.delete();
    builder.delete();
  }
  if (any) return out;
  out.delete();
  return null;
}

const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * Visible and hidden lines of a shape seen from `dir` (toward the viewer) with `xAxis` across
 * the paper, as SVG path data in model units with y pointing down, and the visible lines' extent.
 * Native objects are freed here, not left to the garbage collector: the projections of a whole
 * part take megabytes that the geometry worker would otherwise keep for as long as it runs.
 */
export function projectShape(shape: Sh, dir: Vec3, xAxis: Vec3, tol: number, hair: number): { visible: string[]; hidden: string[]; bounds: [number, number, number, number] | null } {
  const origin = pnt([0, 0, 0]), n = gdir(dir), vx = gdir(xAxis);
  const ax = new oc.gp_Ax2(origin, n, vx);
  const projector = new oc.HLRAlgo_Projector(ax);
  const algo = new oc.HLRBRep_Algo();
  let toShape: any = null;
  let seams: any = null;
  try {
    algo.Add(shape.wrapped, 0);
    seams = silhouetteSeams(shape, dir, hair);
    if (seams) algo.Add(seams, 0);
    algo.Projector(projector);
    algo.Update();
    algo.Hide();
    toShape = new oc.HLRBRep_HLRToShape(algo);
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const lines = (names: string[], b: number[] | null, of?: any) => names.flatMap((name) => {
      const comp = of ? toShape[name](of) : toShape[name]();
      try {
        return compoundPaths(comp, tol, b);
      } finally {
        comp.delete();
      }
    });
    // Sharp edges, smooth (tangent) edges and silhouettes.
    const visible = lines(['VCompound', 'Rg1LineVCompound', 'OutLineVCompound'], box, shape.wrapped);
    const hidden = lines(['HCompound', 'Rg1LineHCompound', 'OutLineHCompound'], null, shape.wrapped);
    if (seams) {
      // The seams along the silhouette, drawn the hair outside it: their extent, less the hair, is the part's.
      const seamBox = [Infinity, Infinity, -Infinity, -Infinity];
      visible.push(...lines(['VCompound'], seamBox, seams));
      hidden.push(...lines(['HCompound'], null, seams));
      if (seamBox[0] <= seamBox[2]) {
        box[0] = Math.min(box[0], seamBox[0] + hair); box[1] = Math.min(box[1], seamBox[1] + hair);
        box[2] = Math.max(box[2], seamBox[2] - hair); box[3] = Math.max(box[3], seamBox[3] - hair);
      }
    }
    return { visible, hidden, bounds: box[0] <= box[2] ? [box[0], box[1], box[2], box[3]] : null };
  } finally {
    // The extraction keeps the algorithm alive after both are deleted (the bindings never let
    // go of its handle), and with it the hidden-line data of the whole part: dropping the shape
    // from it frees that.
    if (toShape) {
      for (let i = algo.NbShapes(); i >= 1; i--) algo.Remove(i);
      toShape.delete();
    }
    seams?.delete();
    algo.delete();
    projector.delete();
    ax.delete();
    origin.delete(); n.delete(); vx.delete();
  }
}

// ---- Transforms ----

export function transformShape(shape: Sh, trsf: any): Sh {
  const t = new oc.BRepBuilderAPI_Transform(shape.wrapped, trsf, true);
  try {
    return wrap(t.Shape());
  } finally {
    t.delete();
  }
}

export function translated(shape: Sh, v: Vec3): Sh {
  const tr = new oc.gp_Trsf();
  const gv = gvec(v);
  tr.SetTranslation(gv);
  try { return transformShape(shape, tr); } finally { gv.delete(); tr.delete(); }
}

// Value types (gp_Pnt, gp_Dir...) are not freed by the bindings: every
// temporary passed to a constructor is deleted explicitly.

export function rotated(shape: Sh, p: Vec3, d: Vec3, angleRad: number): Sh {
  const tr = new oc.gp_Trsf();
  const gp = pnt(p), gd = gdir(d);
  const ax = new oc.gp_Ax1(gp, gd);
  tr.SetRotation(ax, angleRad);
  try { return transformShape(shape, tr); } finally { ax.delete(); gp.delete(); gd.delete(); tr.delete(); }
}

export function mirrored(shape: Sh, p: Vec3, n: Vec3): Sh {
  const tr = new oc.gp_Trsf();
  const gp = pnt(p), gd = gdir(n);
  const ax = new oc.gp_Ax2(gp, gd);
  tr.SetMirror(ax);
  try { return transformShape(shape, tr); } finally { ax.delete(); gp.delete(); gd.delete(); tr.delete(); }
}

/** A plane through p with normal n (delete it after use). */
export function plane(p: Vec3, n: Vec3): any {
  const gp = pnt(p), gd = gdir(n);
  try { return new oc.gp_Pln(gp, gd); } finally { gp.delete(); gd.delete(); }
}

// ---- Booleans ----

function runBoolean(builder: any): Sh {
  try {
    builder.Build();
    builder.SimplifyResult(true, true, 1e-3);
    return wrap(builder.Shape());
  } finally {
    builder.delete();
  }
}

export function fuse(a: Sh, b: Sh): Sh {
  if (isCompound(a) || isCompound(b)) return fuseAll([a, b]);
  return runBoolean(new oc.BRepAlgoAPI_Fuse(a.wrapped, b.wrapped));
}

const isCompound = (s: Sh) => s.wrapped.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_COMPOUND;

/**
 * The shapes with every compound opened into its solids, free shells and
 * free faces. A boolean does not intersect the pieces of one compound with
 * each other, so overlapping holes or pattern copies passed as one compound
 * fused or cut wrongly: a hole drilled twice at a point cut nothing, and
 * overlapping copies left gaps or an invalid body.
 */
function pieces(shapes: Sh[]): Sh[] {
  return shapes.flatMap((s) => {
    if (!isCompound(s)) return [s];
    const out = [...subShapes(s, 'solid'), ...subShapes(s, 'shell', 'solid'), ...subShapes(s, 'face', 'shell')];
    return out.length ? out : [s];
  });
}

/**
 * One boolean of many shapes: fusing them one by one compares each new piece
 * with the whole result so far, about six times slower for a profile of many
 * regions (a plate split by many lines).
 */
export function fuseAll(shapes: Sh[]): Sh {
  if (shapes.length === 1 && !isCompound(shapes[0])) return shapes[0];
  shapes = pieces(shapes);
  if (shapes.length === 1) return shapes[0];
  const args = new oc.NCollection_List_TopoDS_Shape(), tools = new oc.NCollection_List_TopoDS_Shape();
  try {
    args.Append(shapes[0].wrapped);
    for (let i = 1; i < shapes.length; i++) tools.Append(shapes[i].wrapped);
    const builder = new oc.BRepAlgoAPI_Fuse();
    builder.SetArguments(args);
    builder.SetTools(tools);
    return runBoolean(builder);
  } finally {
    args.delete();
    tools.delete();
  }
}

export function cut(a: Sh, b: Sh): Sh {
  if (!isCompound(b)) return runBoolean(new oc.BRepAlgoAPI_Cut(a.wrapped, b.wrapped));
  // Each piece of a compound tool as a tool of its own (see pieces).
  const args = new oc.NCollection_List_TopoDS_Shape(), tools = new oc.NCollection_List_TopoDS_Shape();
  try {
    args.Append(a.wrapped);
    for (const t of pieces([b])) tools.Append(t.wrapped);
    const builder = new oc.BRepAlgoAPI_Cut();
    builder.SetArguments(args);
    builder.SetTools(tools);
    return runBoolean(builder);
  } finally {
    args.delete();
    tools.delete();
  }
}

export function common(a: Sh, b: Sh): Sh {
  return runBoolean(new oc.BRepAlgoAPI_Common(a.wrapped, b.wrapped));
}

/** A compound of the shapes (which stay usable: replicad's makeCompound deletes them). */
export function compound(shapes: Sh[]): Sh {
  const builder = new oc.TopoDS_Builder();
  const c = new oc.TopoDS_Compound();
  try {
    builder.MakeCompound(c);
    for (const s of shapes) builder.Add(c, s.wrapped);
    return wrap(c);
  } finally {
    builder.delete();
  }
}

export function isValid(shape: Sh): boolean {
  const an = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
  try { return an.IsValid(); } finally { an.delete(); }
}

export function isEmpty(shape: Sh | null): boolean {
  if (!shape || shape.wrapped.IsNull()) return true;
  return subShapes(shape, 'face').length === 0;
}

/** Signed volume of a shape (0 for shapes without solids, negative when inside out). */
export function volumeOf(shape: Sh): number {
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.VolumeProperties(shape.wrapped, props, true, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

export function bbox(shape: Sh): { min: Vec3; max: Vec3 } | null {
  const box = new oc.Bnd_Box();
  try {
    oc.BRepBndLib.AddOptimal(shape.wrapped, box, false, false);
    if (box.IsVoid()) return null;
    const a = box.CornerMin(), b = box.CornerMax();
    const out = { min: xyz(a), max: xyz(b) };
    a.delete(); b.delete();
    return out;
  } finally {
    box.delete();
  }
}

// ---- Meshing ----

export interface RawMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceGroups: Int32Array;
}

export function meshShape(shape: Sh, tolerance: number, angular: number): RawMesh {
  const raw = oc.ReplicadMeshExtractor.extract(shape.wrapped, tolerance, angular, false);
  try {
    const buf = oc.wasmMemory.buffer;
    const f32 = (ptr: number, n: number) => new Float32Array(buf, ptr >>> 0, n).slice();
    const u32 = (ptr: number, n: number) => new Uint32Array(buf, ptr >>> 0, n).slice();
    const i32 = (ptr: number, n: number) => new Int32Array(buf, ptr >>> 0, n).slice();
    return {
      positions: f32(raw.getVerticesPtr(), raw.getVerticesSize()),
      normals: f32(raw.getNormalsPtr(), raw.getNormalsSize()),
      indices: u32(raw.getTrianglesPtr(), raw.getTrianglesSize()),
      faceGroups: i32(raw.getFaceGroupsPtr(), raw.getFaceGroupsSize()),
    };
  } finally {
    raw.delete();
  }
}

export function meshEdgesOf(shape: Sh, tolerance: number, angular: number): { lines: Float32Array; groups: Int32Array } {
  const raw = oc.ReplicadEdgeMeshExtractor.extract(shape.wrapped, tolerance, angular);
  try {
    const buf = oc.wasmMemory.buffer;
    return {
      lines: new Float32Array(buf, raw.getLinesPtr() >>> 0, raw.getLinesSize()).slice(),
      groups: new Int32Array(buf, raw.getEdgeGroupsPtr() >>> 0, raw.getEdgeGroupsSize()).slice(),
    };
  } finally {
    raw.delete();
  }
}

export const unitCross = (a: Vec3, b: Vec3): Vec3 => normalize(cross(a, b));
