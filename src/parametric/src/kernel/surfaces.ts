/* eslint-disable @typescript-eslint/no-explicit-any */
// Surface modeling: surface bodies kept apart from the solid body, and the
// features that make, change and use them (extruded, revolved, swept,
// lofted, planar, offset and filled surfaces; trim, extend and knit;
// thicken, cut with surface, delete face).
//
// A part without surface features never reaches this file: the solid path
// of ModelBuilder is unchanged. Surface bodies are listed in the build state
// by the feature that last made them; their faces are named like the
// solid's ("f7:side:l2", after the feature and sketch entity that made the
// surface) and their edges after the faces they bound, so later features
// and sketches reference them by name.

import * as R from 'replicad';
import type { Frame, Vec2, Vec3 } from '../math/vec';
import { add, cross, dist, dot, len, normalize, scale, sub, toWorld } from '../math/vec';
import { type SurfaceFeature, bodyFeatureOf } from '../model/surfaces';
import type {
  AxisRef, DeleteFaceFeature, EdgeRef, FaceRef, Feature, Id, PlaneRef, SketchFeature, SurfaceCutFeature, SurfaceExtendFeature,
  SurfaceExtrudeFeature, SurfaceFillFeature, SurfaceKnitFeature, SurfaceLoftFeature, SurfaceOffsetFeature, SurfacePlanarFeature,
  SurfaceRevolveFeature, SurfaceSweepFeature, SurfaceTrimFeature, ThickenFeature,
} from '../model/types';
import { SketchIndex, pointIdsOf, splineBeziers } from '../sketch/geom';
import type { Region } from '../sketch/profiles';
import {
  type EdgeDesc, type Sh, type SurfDesc, ShapeIndex, SurfaceCache, bbox, compound, describeEdge, describeFace, faceMidPoint, getOc,
  gvec, isEmpty, isValid, meshEdgesOf, meshShape, planarFaceFrame, pnt, rotated, sameSurface, sharesSurface, subShapes, translated,
  vertexPoint, volumeOf, wrap, xyz,
} from './occ';
import type { EdgeInfo, FaceInfo, MeshData } from './protocol';

export interface SurfFace {
  shape: Sh;
  name: string;
  desc: SurfDesc;
  feature: Id;
}

export interface SurfEdge {
  shape: Sh;
  name: string;
  desc: EdgeDesc;
  faces: number[];
}

/** A surface body: an open (or closed, not yet solid) sheet of faces. */
export interface SurfaceBody {
  /** The feature that last made it ("f7"), or "f7.2" for the second body one feature made. */
  id: Id;
  shape: Sh;
  faces: SurfFace[];
}

/** The parts of the builder's state this file reads and writes. */
export interface SurfState {
  body: Sh | null;
  faces: SurfFace[];
  edges: SurfEdge[] | null;
  frames: Map<Id, Frame>;
  sketches: Map<Id, SketchFeature>;
  surfaces: SurfaceBody[];
}

/** What the surface features use of ModelBuilder (its sketch, reference and boolean machinery). */
export interface SurfaceHost {
  fail(message: string): Error;
  missing(id: Id | null | undefined, what: string): Error;
  warn(message: string): void;
  num(f: Feature, path: string): number;
  sketchRegions(id: Id, st: SurfState): { regions: Region[]; frame: Frame; sketch: SketchFeature };
  regionFace(r: Region, fr: Frame): any;
  resolvePlane(ref: PlaneRef | null, st: SurfState): Frame;
  resolveAxis(ref: AxisRef, st: SurfState): { p: Vec3; d: Vec3 };
  resolveFace(ref: FaceRef, st: SurfState): number;
  resolveEdge(ref: EdgeRef, st: SurfState): number;
  edgesOf(st: SurfState): SurfEdge[];
  applyTool(featId: Id, st: SurfState, tool: Sh, faces: SurfFace[], cut: boolean, noGain?: string): void;
  nameFaces(featId: Id, body: Sh, st: SurfState, tool: SurfFace[]): SurfFace[];
}

const bodyFeature = bodyFeatureOf;

const SWEEP_FAILED = 'The swept surface could not be created. The profile should start at the path and be roughly perpendicular to it.';
const MAX_KNIT_FACES = 5000;
const MAX_FILL_EDGES = 32;

// ---------- small OpenCascade helpers ----------

function progress<T>(fn: (p: any) => T): T {
  const p = new (getOc().Message_ProgressRange)();
  try { return fn(p); } finally { p.delete(); }
}

/** Sews shapes along edges closer than tol. */
function sew(shapes: Sh[], tol: number): { shape: Sh; free: number } {
  const oc = getOc();
  const s = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
  try {
    for (const x of shapes) s.Add(x.wrapped);
    progress((p) => s.Perform(p));
    const out = s.SewedShape();
    if (out.IsNull()) throw new Error('sewing failed');
    return { shape: wrap(out), free: s.NbFreeEdges() };
  } finally {
    s.delete();
  }
}

/** A shell (or a single face) of faces that already share their edges. */
function shellOf(faces: Sh[]): Sh {
  if (faces.length === 1) return faces[0];
  const oc = getOc();
  const b = new oc.TopoDS_Builder();
  const sh = new oc.TopoDS_Shell();
  try {
    b.MakeShell(sh);
    for (const f of faces) b.Add(sh, f.wrapped);
    return wrap(sh);
  } finally {
    b.delete();
  }
}

function areaOf(s: Sh): number {
  const oc = getOc();
  const p = new oc.GProp_GProps();
  try { oc.BRepGProp.SurfaceProperties(s.wrapped, p, 1e-7, true); return p.Mass(); } finally { p.delete(); }
}

function sizeOf(s: Sh): number {
  const b = bbox(s);
  return b ? dist(b.min, b.max) : 1;
}

function vertexAt(p: Vec3): Sh {
  const oc = getOc();
  const g = pnt(p);
  const mv = new oc.BRepBuilderAPI_MakeVertex(g);
  try { return wrap(mv.Vertex()); } finally { mv.delete(); g.delete(); }
}

/** Distance between two shapes and the nearest points. */
function nearest(a: Sh, b: Sh): { d: number; p1: Vec3; p2: Vec3 } | null {
  const oc = getOc();
  const ext = new oc.BRepExtrema_DistShapeShape();
  try {
    ext.LoadS1(a.wrapped);
    ext.LoadS2(b.wrapped);
    progress((p) => ext.Perform(p));
    if (!ext.IsDone() || ext.NbSolution() < 1) return null;
    const p1 = ext.PointOnShape1(1), p2 = ext.PointOnShape2(1);
    const out = { d: ext.Value(), p1: xyz(p1), p2: xyz(p2) };
    p1.delete(); p2.delete();
    return out;
  } catch {
    return null;
  } finally {
    ext.delete();
  }
}

/** Unit normal of a face (as oriented in its shape) at the point of it nearest p. */
function normalAt(face: Sh, p: Vec3): Vec3 | null {
  const oc = getOc();
  let surf: any = null, proj: any = null, gf: any = null;
  const g = pnt(p), q = new oc.gp_Pnt(), n = new oc.gp_Vec();
  try {
    surf = oc.BRep_Tool.Surface(face.wrapped);
    proj = new oc.GeomAPI_ProjectPointOnSurf(g, surf, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
    if (!proj.NbPoints()) return null;
    const uv = proj.LowerDistanceParameters(0, 0);
    gf = new oc.BRepGProp_Face(face.wrapped, false);
    gf.Normal(uv.U, uv.V, q, n);
    const v = xyz(n);
    return len(v) > 1e-12 ? normalize(v) : null;
  } catch {
    return null;
  } finally {
    proj?.delete(); gf?.delete(); surf?.delete?.(); g.delete(); q.delete(); n.delete();
  }
}

/** A large planar face on a frame, reaching `reach` from its origin. */
function bigPlane(fr: Frame, reach: number): Sh {
  const oc = getOc();
  const o = pnt(fr.o), d = new oc.gp_Dir(fr.n[0], fr.n[1], fr.n[2]);
  const pl = new oc.gp_Pln(o, d);
  const mf = new oc.BRepBuilderAPI_MakeFace(pl, -reach, reach, -reach, reach);
  try { return wrap(mf.Face()); } finally { mf.delete(); pl.delete(); o.delete(); d.delete(); }
}

/** Faces of a shape with names: those on the surface of a source face take its name, the rest from fallback. */
function inherit(shape: Sh, sources: SurfFace[], tol: number, fallback: (k: number, desc: SurfDesc) => { name: string; feature: Id }): SurfFace[] {
  const cache = new SurfaceCache();
  let k = 0;
  try {
    return subShapes(shape, 'face').map((f) => {
      const desc = describeFace(f);
      let best: SurfFace | null = null, bd = Infinity;
      for (const s of sources) {
        if (s.desc.type !== desc.type) continue;
        if (!sharesSurface(f, s.shape, cache) && !(EXACT.has(desc.type) && sameSurface(desc, s.desc, tol))) continue;
        const d = dist(desc.center, s.desc.center);
        if (d < bd) { bd = d; best = s; }
      }
      if (best) return { shape: f, desc, name: best.name, feature: best.feature };
      return { shape: f, desc, ...fallback(k++, desc) };
    });
  } finally {
    cache.dispose();
  }
}

const EXACT = new Set(['plane', 'cylinder', 'sphere']);

function cmpVec(a: Vec3, b: Vec3): number {
  for (let i = 0; i < 3; i++) {
    const d = Math.round(a[i] * 1e6) - Math.round(b[i] * 1e6);
    if (d) return d;
  }
  return 0;
}

const bodyEdgeCache = new WeakMap<SurfaceBody, SurfEdge[]>();

/** Edges of a surface body, named by the faces they bound (a boundary edge by its one face). */
export function bodyEdges(b: SurfaceBody): SurfEdge[] {
  const cached = bodyEdgeCache.get(b);
  if (cached) return cached;
  const edges = subShapes(b.shape, 'edge');
  const index = new ShapeIndex(edges);
  const adj: number[][] = edges.map(() => []);
  b.faces.forEach((f, fi) => {
    for (const e of subShapes(f.shape, 'edge')) {
      const j = index.find(e.wrapped);
      if (j >= 0 && !adj[j].includes(fi)) adj[j].push(fi);
    }
  });
  const named: SurfEdge[] = edges.map((shape, i) => {
    const names = [...new Set(adj[i].map((fi) => b.faces[fi].name))].sort();
    return { shape, desc: describeEdge(shape), faces: adj[i], name: names.join('|') || `${b.id}:free` };
  });
  const groups = new Map<string, number[]>();
  named.forEach((e, i) => { const g = groups.get(e.name); if (g) g.push(i); else groups.set(e.name, [i]); });
  for (const [, ids] of groups) {
    if (ids.length < 2) continue;
    ids.sort((x, y) => cmpVec(named[x].desc.mid, named[y].desc.mid));
    ids.forEach((id, k) => { named[id].name += `#${k}`; });
  }
  bodyEdgeCache.set(b, named);
  return named;
}

// ---------- sketch curves ----------

interface Piece { edges: any[]; a?: Vec2; b?: Vec2; src: Id }

/** The sketch's curves (not construction geometry) as 3D edges, with their end points. */
function curvePieces(sk: SketchFeature, fr: Frame): Piece[] {
  const ix = new SketchIndex(sk.entities);
  const out: Piece[] = [];
  for (const e of sk.entities) {
    if (e.construction) continue;
    const w = (id: string) => toWorld(fr, ix.pt(id));
    if (e.t === 'line') {
      const a = ix.pt(e.a), b = ix.pt(e.b);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) continue;
      out.push({ edges: [R.makeLine(w(e.a), w(e.b))], a, b, src: e.id });
    } else if (e.t === 'arc') {
      const c = ix.pt(e.c), a = ix.pt(e.a), b = ix.pt(e.b);
      const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
      const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
      let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
      if (a1 <= a0) a1 += 2 * Math.PI;
      const am = (a0 + a1) / 2;
      out.push({ edges: [R.makeThreePointArc(w(e.a), toWorld(fr, [c[0] + r * Math.cos(am), c[1] + r * Math.sin(am)]), w(e.b))], a, b, src: e.id });
    } else if (e.t === 'spline') {
      const pts = e.pts.map((p) => ix.pt(p));
      if (pts.length < 2) continue;
      out.push({ edges: splineBeziers(pts).map((bz) => R.makeBezierCurve(bz.map((p) => toWorld(fr, p)))), a: pts[0], b: pts[pts.length - 1], src: e.id });
    } else if (e.t === 'circle') {
      if (e.r > 0) out.push({ edges: [R.makeCircle(e.r, toWorld(fr, ix.pt(e.c)), fr.n)], src: e.id });
    }
  }
  return out;
}

/** Connected chains of pieces, each in order end to end (closed curves alone). */
function chains(pieces: Piece[]): { pieces: Piece[]; closed: boolean }[] {
  let size = 0;
  for (const p of pieces) for (const q of [p.a, p.b]) if (q) size = Math.max(size, Math.abs(q[0]), Math.abs(q[1]));
  const tol = 1e-6 * (1 + size);
  const same = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
  const rest = [...pieces];
  const out: { pieces: Piece[]; closed: boolean }[] = [];
  while (rest.length) {
    const first = rest.shift()!;
    if (!first.a || !first.b) { out.push({ pieces: [first], closed: true }); continue; }
    const chain = [first];
    let head = first.a, tail = first.b;
    for (;;) {
      const i = rest.findIndex((p) => !!p.a && !!p.b && (same(p.a, tail) || same(p.b, tail) || same(p.a, head) || same(p.b, head)));
      if (i < 0 || same(head, tail)) break;
      const [p] = rest.splice(i, 1);
      if (same(p.a!, tail)) { chain.push(p); tail = p.b!; }
      else if (same(p.b!, tail)) { chain.push(p); tail = p.a!; }
      else if (same(p.a!, head)) { chain.unshift(p); head = p.b!; }
      else { chain.unshift(p); head = p.a!; }
    }
    out.push({ pieces: chain, closed: same(head, tail) });
  }
  return out;
}

// ---------- the surface features ----------

export class SurfaceKit {
  constructor(private h: SurfaceHost) {}

  /** Builds a surface feature into the state. Returns what its preview shows. */
  apply(f: SurfaceFeature, st: SurfState): 'surface' | 'body' {
    switch (f.type) {
      case 'surfaceExtrude': this.extrude(f, st); return 'surface';
      case 'surfaceRevolve': this.revolve(f, st); return 'surface';
      case 'surfaceSweep': this.sweep(f, st); return 'surface';
      case 'surfaceLoft': this.loft(f, st); return 'surface';
      case 'surfacePlanar': this.planar(f, st); return 'surface';
      case 'surfaceOffset': this.offset(f, st); return 'surface';
      case 'surfaceFill': this.fill(f, st); return 'surface';
      case 'surfaceTrim': this.trim(f, st); return 'surface';
      case 'surfaceExtend': this.extend(f, st); return 'surface';
      case 'surfaceKnit': return this.knit(f, st);
      case 'thicken': this.thicken(f, st); return 'body';
      case 'surfaceCut': this.cutWith(f, st); return 'body';
      case 'deleteFace': return this.deleteFace(f, st);
    }
  }

  /** The shape a surface feature's preview shows: the bodies it made. */
  previewShape(st: SurfState, id: Id): Sh | null {
    const mine = st.surfaces.filter((b) => bodyFeature(b.id) === id);
    if (!mine.length) return null;
    return mine.length === 1 ? mine[0].shape : compound(mine.map((b) => b.shape));
  }

  // ---- references ----

  /** A surface face of that name (nearest the reference's place when several have it). */
  findFace(ref: FaceRef, st: SurfState): { body: SurfaceBody; face: SurfFace } | null {
    let best: { body: SurfaceBody; face: SurfFace } | null = null, bd = Infinity;
    for (const body of st.surfaces) {
      for (const face of body.faces) {
        if (face.name !== ref.name) continue;
        const d = dist(face.desc.center, ref.sig.c);
        if (d < bd) { bd = d; best = { body, face }; }
      }
    }
    return best;
  }

  /** A surface edge of that name, or a piece of it (nearest the reference's place). */
  findEdge(ref: EdgeRef, st: SurfState): { body: SurfaceBody; edge: SurfEdge } | null {
    const base = ref.name.replace(/#\d+$/, '');
    let best: { body: SurfaceBody; edge: SurfEdge } | null = null, bd = Infinity;
    let exact = false;
    for (const body of st.surfaces) {
      for (const edge of bodyEdges(body)) {
        const isExact = edge.name === ref.name;
        if (!isExact && edge.name.replace(/#\d+$/, '') !== base) continue;
        if (exact && !isExact) continue;
        const d = dist(edge.desc.mid, ref.sig.m);
        if ((isExact && !exact) || d < bd) { bd = d; best = { body, edge }; exact = exact || isExact; }
      }
    }
    return best;
  }

  /** A face of a surface body or of the solid. */
  anyFace(ref: FaceRef, st: SurfState): { shape: Sh; desc: SurfDesc; body: SurfaceBody | null } {
    const s = this.findFace(ref, st);
    if (s) return { shape: s.face.shape, desc: s.face.desc, body: s.body };
    if (!st.faces.some((f) => f.name === ref.name) && st.surfaces.length) {
      // Gone by name (trimmed away, renamed): the nearest surface face of that kind nearby.
      let best: { body: SurfaceBody; face: SurfFace } | null = null, bd = Infinity;
      for (const body of st.surfaces) {
        const lim = sizeOf(body.shape) * 0.05;
        for (const face of body.faces) {
          if (face.desc.type !== ref.sig.type) continue;
          const d = dist(face.desc.center, ref.sig.c);
          if (d < lim && d < bd) { bd = d; best = { body, face }; }
        }
      }
      if (best) return { shape: best.face.shape, desc: best.face.desc, body: best.body };
    }
    const f = st.faces[this.h.resolveFace(ref, st)];
    return { shape: f.shape, desc: f.desc, body: null };
  }

  /** An edge of a surface body or of the solid, with the faces it bounds. */
  anyEdge(ref: EdgeRef, st: SurfState): { shape: Sh; desc: EdgeDesc; faces: Sh[]; body: SurfaceBody | null } {
    const s = this.findEdge(ref, st);
    if (s) return { shape: s.edge.shape, desc: s.edge.desc, faces: s.edge.faces.map((i) => s.body.faces[i].shape), body: s.body };
    const e = this.h.edgesOf(st)[this.h.resolveEdge(ref, st)];
    return { shape: e.shape, desc: e.desc, faces: e.faces.map((i) => st.faces[i].shape), body: null };
  }

  /** The surface body a face reference is on. */
  private bodyOf(ref: FaceRef, st: SurfState, what: string): SurfaceBody {
    const s = this.findFace(ref, st);
    if (s) return s.body;
    const any = st.surfaces.length ? this.anyFace(ref, st) : null;
    if (any?.body) return any.body;
    if (st.faces.some((f) => f.name === ref.name)) throw this.h.fail(`The selected face is a face of the solid. Select ${what}.`);
    throw this.h.fail(`A selected surface no longer exists. Edit the feature and select ${what} again.`);
  }

  /** Distinct surface bodies of the selected faces, in selection order. */
  private bodiesOf(refs: FaceRef[], st: SurfState, what: string): SurfaceBody[] {
    const out: SurfaceBody[] = [];
    for (const r of refs) {
      const b = this.bodyOf(r, st, what);
      if (!out.includes(b)) out.push(b);
    }
    return out;
  }

  /** Plane frame of a planar surface face (sketches and planes on surfaces). */
  surfacePlane(ref: FaceRef, st: SurfState, x?: Vec3): Frame | null {
    const s = this.findFace(ref, st);
    if (!s) return null;
    if (s.face.desc.type !== 'plane') throw this.h.fail('The selected face is not planar');
    return planarFaceFrame(s.face.desc, x);
  }

  /** An axis from a surface edge or face, or null when the reference is not on a surface. */
  surfaceAxis(ref: AxisRef, st: SurfState): { p: Vec3; d: Vec3 } | null {
    if (ref.kind === 'edge') {
      const s = this.findEdge(ref.edge, st);
      if (!s) return null;
      const e = s.edge.desc;
      if (e.type === 'line') return { p: e.a, d: e.dir! };
      if (e.type === 'circle') return { p: e.center!, d: normalize(e.axis!) };
      throw this.h.fail('The selected edge is not straight or circular');
    }
    if (ref.kind === 'face') {
      const s = this.findFace(ref.face, st);
      if (!s) return null;
      const f = s.face.desc;
      if (f.type === 'plane') return { p: f.center, d: f.d };
      if (f.type === 'cylinder' || f.type === 'sphere') return { p: f.p, d: f.d };
      throw this.h.fail('Select a planar or cylindrical face');
    }
    return null;
  }

  /** A surface edge for a sketch's projected geometry, or null. */
  surfaceEdgeDesc(ref: EdgeRef, st: SurfState): EdgeDesc | null {
    return this.findEdge(ref, st)?.edge.desc ?? null;
  }

  // ---- adding and replacing bodies ----

  private addBody(st: SurfState, id: Id, shape: Sh, faces: SurfFace[], replace: SurfaceBody[] = []) {
    if (isEmpty(shape)) throw this.h.fail('The surface has no faces');
    st.surfaces = [...st.surfaces.filter((b) => !replace.includes(b)), { id, shape, faces }];
  }

  private named(featId: Id, shape: Sh, name: (k: number, desc: SurfDesc, face: Sh) => string): SurfFace[] {
    return subShapes(shape, 'face').map((f, k) => {
      const desc = describeFace(f);
      return { shape: f, desc, name: `${featId}:${name(k, desc, f)}`, feature: featId };
    });
  }

  /** Faces sewn into one shell where they meet, keeping their names. */
  private sewNamed(featId: Id, faces: SurfFace[]): { shape: Sh; faces: SurfFace[] } {
    if (faces.length === 1) return { shape: faces[0].shape, faces };
    const all = compound(faces.map((f) => f.shape));
    const tol = Math.max(1e-6, sizeOf(all) * 1e-7);
    const { shape } = sew(faces.map((f) => f.shape), tol);
    return { shape, faces: inherit(shape, faces, tol, (k) => ({ name: `${featId}:n${k}`, feature: featId })) };
  }

  // ---- extruded, revolved, swept, lofted, planar ----

  private sketchOf(id: Id | null | undefined, st: SurfState, what: string): { sketch: SketchFeature; frame: Frame } {
    const sketch = id ? st.sketches.get(id) : undefined;
    const frame = id ? st.frames.get(id) : undefined;
    if (!sketch || !frame) throw this.h.missing(id, what);
    return { sketch, frame };
  }

  private extrude(f: SurfaceExtrudeFeature, st: SurfState) {
    const { sketch, frame } = this.sketchOf(f.sketch, st, 'profile sketch');
    const pieces = curvePieces(sketch, frame);
    if (!pieces.length) throw this.h.fail('The sketch has no curves to extrude');
    const d1 = this.h.num(f, 'depth');
    if (!(d1 > 0)) throw this.h.fail('Depth must be greater than zero');
    const dir = scale(frame.n, f.flip ? -1 : 1);
    let start = 0, total = d1;
    if (f.end === 'midPlane') start = -d1 / 2;
    else if (f.dir2) {
      const d2 = this.h.num(f, 'dir2.depth');
      if (!(d2 > 0)) throw this.h.fail('Direction 2 depth must be greater than zero');
      start = -d2; total = d1 + d2;
    }
    const oc = getOc();
    const faces: SurfFace[] = [];
    for (const p of pieces) {
      for (const e of p.edges) {
        const v = gvec(scale(dir, total));
        const mk = new oc.BRepPrimAPI_MakePrism(e.wrapped, v, false, true);
        let face: Sh;
        try { face = wrap(mk.Shape()); } finally { mk.delete(); v.delete(); }
        if (start) face = translated(face, scale(dir, start));
        for (const s of subShapes(face, 'face')) faces.push({ shape: s, desc: describeFace(s), name: `${f.id}:side:${p.src}`, feature: f.id });
      }
    }
    const { shape, faces: named } = this.sewNamed(f.id, faces);
    this.addBody(st, f.id, shape, named);
  }

  /** The axis of a revolve: the reference, or the sketch's free-standing centerline. */
  private revolveAxis(f: SurfaceRevolveFeature, sketch: SketchFeature, frame: Frame, st: SurfState): { p: Vec3; d: Vec3; line?: Id } {
    if (f.axis) return this.h.resolveAxis(f.axis, st);
    const ix = new SketchIndex(sketch.entities);
    const lines = sketch.entities.filter((e) => e.t === 'line' && e.construction);
    const onProfile = new Set(sketch.entities.flatMap((e) => (e.t !== 'point' && !e.construction ? pointIdsOf(e) : [])));
    const cl = lines.find((l) => l.t === 'line' && !l.ext && !onProfile.has(l.a) && !onProfile.has(l.b)) ?? lines[0];
    if (!cl || cl.t !== 'line') throw this.h.fail('Select an axis of revolution (or add a centerline to the sketch)');
    const a = toWorld(frame, ix.pt(cl.a)), b = toWorld(frame, ix.pt(cl.b));
    return { p: a, d: normalize(sub(b, a)), line: cl.id };
  }

  private revolve(f: SurfaceRevolveFeature, st: SurfState) {
    const { sketch, frame } = this.sketchOf(f.sketch, st, 'profile sketch');
    const axis = this.revolveAxis(f, sketch, frame, st);
    const pieces = curvePieces(sketch, frame);
    const angle = this.h.num(f, 'angle');
    if (!(angle > 0)) throw this.h.fail('Angle must be greater than zero');
    if (angle > 360 + 1e-9) throw this.h.fail('The angle cannot be more than 360 degrees');
    const d = scale(axis.d, f.flip ? -1 : 1);
    const onAxis = (p: Vec3) => len(sub(sub(p, axis.p), scale(d, dot(sub(p, axis.p), d)))) < 1e-7 * (1 + len(p));
    const oc = getOc();
    const faces: SurfFace[] = [];
    for (const p of pieces) {
      for (const e of p.edges) {
        const ed = describeEdge(e as Sh);
        // A curve on the axis sweeps nothing.
        if (onAxis(ed.a) && onAxis(ed.b) && onAxis(ed.mid)) continue;
        const ax = new oc.gp_Ax1(pnt(axis.p), new oc.gp_Dir(d[0], d[1], d[2]));
        const mk = new oc.BRepPrimAPI_MakeRevol(e.wrapped, ax, (Math.min(angle, 360) * Math.PI) / 180, true);
        let face: Sh;
        try { face = wrap(mk.Shape()); } catch { throw this.h.fail('The revolved surface could not be created'); } finally { mk.delete(); ax.delete(); }
        if (f.end === 'midPlane' && angle < 360) face = rotated(face, axis.p, d, (-angle * Math.PI) / 360);
        for (const s of subShapes(face, 'face')) faces.push({ shape: s, desc: describeFace(s), name: `${f.id}:side:${p.src}`, feature: f.id });
      }
    }
    if (!faces.length) throw this.h.fail('The sketch has no curves to revolve (other than the axis)');
    const { shape, faces: named } = this.sewNamed(f.id, faces);
    this.addBody(st, f.id, shape, named);
  }

  /** One wire through a sketch's curves; `extra` when it has more than one chain. */
  private sketchWire(id: Id | null, st: SurfState, what: string): { wire: any; closed: boolean; frame: Frame; extra: boolean } {
    const { sketch, frame } = this.sketchOf(id, st, what);
    const cs = chains(curvePieces(sketch, frame));
    if (!cs.length) throw this.h.fail(`The ${what} (${sketch.name}) has no curves`);
    const c = cs[0];
    try {
      return { wire: R.assembleWire(c.pieces.flatMap((p) => p.edges)), closed: c.closed, frame, extra: cs.length > 1 };
    } catch {
      throw this.h.fail(`The curves of the ${what} (${sketch.name}) do not join into one chain`);
    }
  }

  private sweep(f: SurfaceSweepFeature, st: SurfState) {
    if (!f.profile || !f.path) throw this.h.fail('Select a profile and a path');
    if (f.profile === f.path) throw this.h.fail('The profile and the path are the same sketch. Draw the path in a sketch of its own.');
    const prof = this.sketchWire(f.profile, st, 'profile sketch');
    const path = this.sketchWire(f.path, st, 'path sketch');
    if (prof.extra || path.extra) this.h.warn('Only the first chain of curves of each sketch was used; the others were ignored');
    let shape: Sh;
    try {
      shape = R.genericSweep(prof.wire, path.wire, { frenet: true }) as unknown as Sh;
    } catch {
      throw this.h.fail(SWEEP_FAILED);
    }
    if (isEmpty(shape) || !(areaOf(shape) > 0)) throw this.h.fail(SWEEP_FAILED);
    this.addBody(st, f.id, shape, this.named(f.id, shape, (k) => `s${k}`));
  }

  private loft(f: SurfaceLoftFeature, st: SurfState) {
    if (f.profiles.length < 2) throw this.h.fail('Select at least two profiles');
    const profs = f.profiles.map((id) => this.sketchWire(id, st, 'profile sketch'));
    if (profs.some((p) => p.closed) && profs.some((p) => !p.closed)) throw this.h.fail('The profiles must be all open or all closed');
    for (let i = 1; i < profs.length; i++) {
      const a = profs[i - 1].frame, b = profs[i].frame;
      const size = Math.max(1, len(a.o), len(b.o));
      if (Math.abs(dot(a.n, b.n)) > 1 - 1e-9 && Math.abs(dot(sub(b.o, a.o), a.n)) < 1e-9 * size) {
        throw this.h.fail('Two of the profiles lie in the same plane. Sketch each profile on its own plane.');
      }
    }
    if (profs.some((p) => p.extra)) this.h.warn('Only the first chain of curves of each profile was used; the others were ignored');
    const oc = getOc();
    const ts = new oc.BRepOffsetAPI_ThruSections(false, f.ruled, 1e-6);
    let shape: Sh;
    try {
      for (const p of profs) ts.AddWire(p.wire.wrapped);
      progress((p) => ts.Build(p));
      if (!ts.IsDone()) throw new Error('loft');
      shape = wrap(ts.Shape());
    } catch {
      throw this.h.fail('The lofted surface could not be created from these profiles');
    } finally {
      ts.delete();
    }
    if (isEmpty(shape) || !(areaOf(shape) > 0)) throw this.h.fail('The lofted surface could not be created from these profiles');
    this.addBody(st, f.id, shape, this.named(f.id, shape, (k) => `l${k}`));
  }

  private planar(f: SurfacePlanarFeature, st: SurfState) {
    if (f.sketch) {
      const { regions, frame } = this.h.sketchRegions(f.sketch, st);
      const faces: SurfFace[] = [];
      regions.forEach((r, k) => {
        for (const s of subShapes(wrap(this.h.regionFace(r, frame).wrapped), 'face')) faces.push({ shape: s, desc: describeFace(s), name: `${f.id}:p${k}`, feature: f.id });
      });
      const { shape, faces: named } = this.sewNamed(f.id, faces);
      this.addBody(st, f.id, shape, named);
      return;
    }
    if (!f.edges.length) throw this.h.fail('Select a sketch with a closed profile, or a closed loop of edges');
    const edges = f.edges.map((r) => this.anyEdge(r, st).shape);
    if (!closesLoop(edges)) throw this.h.fail('The selected edges must form one closed loop lying in a plane');
    const oc = getOc();
    let face: Sh;
    try {
      const wire = R.assembleWire(edges as any);
      const mf = new oc.BRepBuilderAPI_MakeFace(wire.wrapped, true);
      try {
        if (!mf.IsDone()) throw new Error('face');
        face = wrap(mf.Face());
      } finally {
        mf.delete();
      }
    } catch {
      throw this.h.fail('The selected edges must form one closed loop lying in a plane');
    }
    if (!(areaOf(face) > 0)) throw this.h.fail('The selected edges must form one closed loop lying in a plane');
    this.addBody(st, f.id, face, this.named(f.id, face, (k) => `p${k}`));
  }

  // ---- offset and fill ----

  private offset(f: SurfaceOffsetFeature, st: SurfState) {
    if (!f.faces.length) throw this.h.fail('Select faces to offset');
    const src = f.faces.map((r) => this.anyFace(r, st).shape);
    const d = this.h.num(f, 'distance') * (f.flip ? -1 : 1);
    const oc = getOc();
    let shape: Sh;
    if (Math.abs(d) < 1e-12) {
      // A copy: new faces of the same geometry, sewn where they meet.
      shape = src.length === 1 ? copyShape(src[0]) : sew(src.map(copyShape), Math.max(1e-6, sizeOf(compound(src)) * 1e-7)).shape;
    } else {
      const base = src.length === 1 ? src[0] : sew(src, Math.max(1e-6, sizeOf(compound(src)) * 1e-7)).shape;
      const run = (simple: boolean): Sh | null => {
        const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
        try {
          if (simple) mk.PerformBySimple(base.wrapped, d);
          else progress((p) => mk.PerformByJoin(base.wrapped, d, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false, p));
          if (!mk.IsDone()) return null;
          const s = wrap(mk.Shape());
          return isEmpty(s) || !offsetHolds(s, base, Math.abs(d)) ? null : s;
        } catch {
          return null;
        } finally {
          mk.delete();
        }
      };
      const out = run(false) ?? run(true);
      if (!out) throw this.h.fail('The faces could not be offset by this distance. Try a smaller distance.');
      shape = out;
    }
    this.addBody(st, f.id, shape, this.named(f.id, shape, (k) => `o${k}`));
  }

  private fill(f: SurfaceFillFeature, st: SurfState) {
    if (f.edges.length < 1) throw this.h.fail('Select the edges around the opening to fill');
    if (f.edges.length > MAX_FILL_EDGES) throw this.h.fail(`Select at most ${MAX_FILL_EDGES} edges to fill`);
    const edges = f.edges.map((r) => this.anyEdge(r, st).shape);
    // The boundary must close: an open set of edges is filled with made-up edges.
    if (!closesLoop(edges)) throw this.h.fail('The selected edges must form one closed boundary');
    const oc = getOc();
    const mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
    let shape: Sh;
    try {
      for (const e of edges) mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
      progress((p) => mk.Build(p));
      if (!mk.IsDone()) throw new Error('fill');
      shape = wrap(mk.Shape());
    } catch {
      throw this.h.fail('The opening could not be filled. Check that the edges form one closed boundary.');
    } finally {
      mk.delete();
    }
    if (isEmpty(shape) || !(areaOf(shape) > 0)) throw this.h.fail('The opening could not be filled');
    this.addBody(st, f.id, shape, this.named(f.id, shape, (k) => `fill${k}`));
  }

  // ---- trim and extend ----

  /** The trim tool as a shape spanning the targets, and its normal at a point. */
  private trimTool(f: SurfaceTrimFeature, st: SurfState, targets: SurfaceBody[]): { shape: Sh; normal: (p: Vec3) => Vec3 | null } {
    const t = f.tool;
    if (!t) throw this.h.fail('Select a trim tool: a plane, a sketch or a surface');
    const box = bbox(compound(targets.map((b) => b.shape)));
    const center: Vec3 = box ? scale(add(box.min, box.max), 0.5) : [0, 0, 0];
    const size = box ? dist(box.min, box.max) : 100;
    if (t.kind === 'plane') {
      const fr = this.h.resolvePlane(t.plane, st);
      const shape = bigPlane(fr, 2 * size + dist(fr.o, center) + 1);
      return { shape, normal: () => fr.n };
    }
    if (t.kind === 'sketch') {
      const { sketch, frame } = this.sketchOf(t.sketch, st, 'trim sketch');
      const pieces = curvePieces(sketch, frame);
      if (!pieces.length) throw this.h.fail('The trim sketch has no curves');
      const reach = 2 * size + Math.abs(dot(sub(center, frame.o), frame.n)) + 1;
      const oc = getOc();
      const faces: Sh[] = [];
      for (const p of pieces) {
        for (const e of p.edges) {
          const v = gvec(scale(frame.n, 2 * reach));
          const mk = new oc.BRepPrimAPI_MakePrism(e.wrapped, v, false, true);
          try { faces.push(translated(wrap(mk.Shape()), scale(frame.n, -reach))); } finally { mk.delete(); v.delete(); }
        }
      }
      const shape = faces.length === 1 ? faces[0] : compound(faces);
      return { shape, normal: (p) => { const face = nearestFace(shape, p); return face ? normalAt(face, p) : null; } };
    }
    const tool = this.bodyOf(t.face, st, 'a surface as the trim tool');
    if (targets.includes(tool)) throw this.h.fail('The trim tool cannot be one of the surfaces to trim');
    return { shape: tool.shape, normal: (p) => { const face = nearestFace(tool.shape, p); return face ? normalAt(face, p) : null; } };
  }

  private trim(f: SurfaceTrimFeature, st: SurfState) {
    if (!f.faces.length) throw this.h.fail('Select the surfaces to trim');
    const targets = this.bodiesOf(f.faces, st, 'a surface to trim');
    const tool = this.trimTool(f, st, targets);
    const results: { shape: Sh; faces: SurfFace[]; from: SurfaceBody }[] = [];
    let crossed = false;
    for (const body of targets) {
      const tol = Math.max(1e-6, sizeOf(body.shape) * 1e-6);
      const split = splitShape(body.shape, [tool.shape]);
      if (!split) throw this.h.fail('The surface could not be trimmed with this tool');
      const faces = subShapes(split, 'face');
      const comps = components(faces, tool.shape, tol);
      if (comps.length > 1) crossed = true;
      let keep: number[];
      if (f.keep.length) {
        const pts = f.keep.map(vertexAt);
        keep = [...new Set(pts.map((v) => {
          let best = -1, bd = Infinity;
          comps.forEach((c, ci) => { for (const fi of c) { const d = nearest(v, faces[fi])?.d ?? Infinity; if (d < bd) { bd = d; best = ci; } } });
          return best;
        }).filter((i) => i >= 0))];
      } else {
        keep = comps.flatMap((c, ci) => {
          const p = faceMidPoint(faces[c[0]]);
          const q = nearest(vertexAt(p), tool.shape);
          const n = q ? tool.normal(q.p2) : null;
          if (!q || !n) return [];
          const side = dot(sub(p, q.p2), n);
          return (side > 0) !== f.flip ? [ci] : [];
        });
      }
      const kept = keep.flatMap((ci) => comps[ci].map((fi) => faces[fi]));
      if (!kept.length) throw this.h.fail('Nothing of the surface is left on that side. Flip the side to keep, or pick the pieces to keep.');
      const shape = kept.length === 1 ? kept[0] : sew(kept, tol).shape;
      results.push({ shape, from: body, faces: inherit(shape, body.faces, tol, (k) => ({ name: `${f.id}:t${k}`, feature: f.id })) });
    }
    if (!crossed) this.h.warn('The trim tool does not cross the surface, so nothing was trimmed');
    results.forEach((r, k) => this.addBody(st, k ? `${f.id}.${k + 1}` : f.id, r.shape, r.faces, [r.from]));
  }

  private extend(f: SurfaceExtendFeature, st: SurfState) {
    if (!f.edges.length) throw this.h.fail('Select boundary edges of a surface to extend');
    const d = this.h.num(f, 'distance');
    if (!(d > 0)) throw this.h.fail('Distance must be greater than zero');
    const picks = f.edges.map((r) => {
      const s = this.findEdge(r, st);
      if (!s) throw this.h.fail('Select boundary edges of a surface body (the solid cannot be extended)');
      if (s.edge.faces.length !== 1) throw this.h.fail('Select edges on the boundary of the surface');
      return { body: s.body, edge: s.edge, face: s.body.faces[s.edge.faces[0]] };
    });
    const oc = getOc();
    for (const body of [...new Set(picks.map((p) => p.body))]) {
      const mine = picks.filter((p) => p.body === body);
      const tol = Math.max(1e-6, sizeOf(body.shape) * 1e-6);
      const pieces: SurfFace[] = [];
      const replaced = new Set<SurfFace>();
      if (f.mode === 'same') {
        // Each face grows on the sides of its parameter range the selected edges lie on.
        for (const face of [...new Set(mine.map((p) => p.face))]) {
          const sides = { umin: false, umax: false, vmin: false, vmax: false };
          const uv = oc.BRepTools.UVBounds(face.shape.wrapped, 0, 0, 0, 0);
          const span = Math.max(uv.UMax - uv.UMin, uv.VMax - uv.VMin, 1e-12);
          for (const p of mine.filter((q) => q.face === face)) {
            // The edge's ends and middle all lie on one side of the face's
            // parameter range: a circle bounding a flat disc touches all four
            // at its points, and extending one side made a rectangle of it.
            let side: keyof typeof sides | null = null;
            for (const pt of [p.edge.desc.mid, p.edge.desc.a, p.edge.desc.b]) {
              const at = surfaceParams(face.shape, pt);
              if (!at) throw this.h.fail('The surface could not be extended at the selected edge');
              const dists: [keyof typeof sides, number][] = [['umin', Math.abs(at.u - uv.UMin)], ['umax', Math.abs(at.u - uv.UMax)], ['vmin', Math.abs(at.v - uv.VMin)], ['vmax', Math.abs(at.v - uv.VMax)]];
              const on = dists.filter((x) => x[1] <= span * 1e-3).map((x) => x[0]);
              if (!on.length || (side && !on.includes(side))) side = null;
              else if (!side) side = on[0];
              if (!side) throw this.h.fail('Same-surface extension works on edges along the sides of a surface. Use Linear for this edge.');
            }
            sides[side!] = true;
          }
          const out = new oc.TopoDS_Face();
          try {
            oc.BRepLib.ExtendFace(face.shape.wrapped, d, sides.umin, sides.umax, sides.vmin, sides.vmax, out);
          } catch {
            throw this.h.fail('The surface could not be extended by this distance');
          }
          const ext = wrap(out);
          if (isEmpty(ext) || !(areaOf(ext) > face.desc.area)) throw this.h.fail('The surface could not be extended by this distance');
          replaced.add(face);
          pieces.push({ shape: ext, desc: describeFace(ext), name: face.name, feature: face.feature });
        }
      } else {
        // A strip along each edge, tangent to the surface and straight out from it.
        for (const p of mine) {
          const mid = p.edge.desc.mid;
          const n = normalAt(p.face.shape, mid);
          const t = edgeTangent(p.edge.shape, mid);
          if (!n || !t) throw this.h.fail('The surface could not be extended at the selected edge');
          // Away from the face: the face's middle lies behind the edge.
          const sign = dot(sub(faceMidPoint(p.face.shape), mid), cross(t, n)) > 0 ? -1 : 1;
          const out = scale(normalize(cross(t, n)), sign);
          const strip = p.edge.desc.type === 'line' ? 'straight' : ruledStrip(p.edge.shape, p.face.shape, out, sign, d);
          if (!strip) throw this.h.fail('The surface could not be extended at the selected edge');
          let shape: Sh;
          if (strip !== 'straight') shape = strip;
          else {
            // Straight out along one direction (a straight edge, or the rim of an extruded surface).
            const v = gvec(scale(out, d));
            const mk = new oc.BRepPrimAPI_MakePrism(p.edge.shape.wrapped, v, false, true);
            try { shape = wrap(mk.Shape()); } catch { throw this.h.fail('The surface could not be extended at the selected edge'); } finally { mk.delete(); v.delete(); }
          }
          if (!(areaOf(shape) > d * p.edge.desc.length * 0.5)) throw this.h.fail('The surface could not be extended at the selected edge');
          for (const s of subShapes(shape, 'face')) pieces.push({ shape: s, desc: describeFace(s), name: `${f.id}:x:${p.face.name}`, feature: f.id });
        }
      }
      const rest = body.faces.filter((x) => !replaced.has(x));
      const all = [...rest, ...pieces];
      const shape = all.length === 1 ? all[0].shape : sew(all.map((x) => x.shape), tol).shape;
      const n = st.surfaces.filter((b) => bodyFeature(b.id) === f.id).length;
      this.addBody(st, n ? `${f.id}.${n + 1}` : f.id, shape, inherit(shape, all, tol, (k) => ({ name: `${f.id}:x${k}`, feature: f.id })), [body]);
    }
  }

  // ---- knit, thicken, cut, delete face ----

  private knit(f: SurfaceKnitFeature, st: SurfState): 'surface' | 'body' {
    if (!f.faces.length) throw this.h.fail('Select the surfaces to knit');
    const bodies = this.bodiesOf(f.faces, st, 'surfaces to knit');
    const tol = this.h.num(f, 'tolerance');
    if (!(tol > 0)) throw this.h.fail('The knit tolerance must be greater than zero');
    const faces = bodies.flatMap((b) => b.faces);
    if (faces.length > MAX_KNIT_FACES) throw this.h.fail(`Too many faces to knit (more than ${MAX_KNIT_FACES})`);
    if (bodies.length < 2 && !f.solid) this.h.warn('Only one surface is selected: there is nothing to knit it to');
    let res: { shape: Sh; free: number };
    try {
      res = sew(bodies.map((b) => b.shape), tol);
    } catch {
      throw this.h.fail('The surfaces could not be knit');
    }
    const shells = subShapes(res.shape, 'shell');
    const named = inherit(res.shape, faces, Math.max(tol, 1e-6), (k) => ({ name: `${f.id}:k${k}`, feature: f.id }));
    if (f.solid) {
      if (res.free > 0 || shells.length !== 1) {
        throw this.h.fail(res.free > 0
          ? `The surfaces do not form a closed volume (${res.free} open ${res.free === 1 ? 'edge' : 'edges'}). Close the gaps or raise the knit tolerance, or knit without Create solid.`
          : 'The surfaces do not form a closed volume. Close the gaps or raise the knit tolerance, or knit without Create solid.');
      }
      const solid = solidFromShell(shells[0]);
      if (!solid) throw this.h.fail('The surfaces do not form a closed volume');
      const tool = inherit(solid, named, Math.max(tol, 1e-6), (k) => ({ name: `${f.id}:k${k}`, feature: f.id }));
      st.surfaces = st.surfaces.filter((b) => !bodies.includes(b));
      this.h.applyTool(f.id, st, solid, tool, false, 'The knit solid adds no material: it lies inside the part.');
      return 'body';
    }
    if (shells.length > 1 || (bodies.length > 1 && res.free > 0 && shells.length + subShapes(res.shape, 'face', 'shell').length > 1)) {
      this.h.warn('Some of the surfaces could not be knit: they do not meet within the knit tolerance');
    }
    this.addBody(st, f.id, res.shape, named, bodies);
    return 'surface';
  }

  private thicken(f: ThickenFeature, st: SurfState) {
    if (!f.faces.length) throw this.h.fail('Select a surface to thicken');
    const body = this.bodyOf(f.faces[0], st, 'a surface to thicken');
    const t = this.h.num(f, 'thickness');
    if (!(t > 0)) throw this.h.fail('Thickness must be greater than zero');
    const area = areaOf(body.shape);
    const solid = thickSolid(body.shape, f.side === 'back' ? -t : t, f.side === 'both', area);
    if (!solid) throw this.h.fail('The surface could not be thickened. Try a smaller thickness, or thicken smooth surfaces one by one.');
    const tool = this.named(f.id, solid, (k) => `t${k}`);
    st.surfaces = st.surfaces.filter((b) => b !== body);
    this.h.applyTool(f.id, st, solid, tool, f.cut, 'The thickened surface adds no material: it lies inside the part.');
  }

  private cutWith(f: SurfaceCutFeature, st: SurfState) {
    if (!f.face) throw this.h.fail('Select the surface to cut with');
    if (!st.body) throw this.h.fail('There is no solid body to cut');
    const tool = this.bodyOf(f.face, st, 'a surface to cut with');
    const body = st.body;
    const split = splitShape(body, [tool.shape]);
    if (!split) throw this.h.fail('The body could not be cut with this surface');
    const solids = subShapes(split, 'solid');
    const tol = Math.max(1e-6, sizeOf(body) * 1e-6);
    const kept: Sh[] = [];
    let removed = 0;
    for (const s of solids) {
      // A piece is removed when it lies on the side of the surface its normal
      // points to: its faces on the surface face the other way from it.
      let side = 0;
      for (const face of subShapes(s, 'face')) {
        const p = faceMidPoint(face);
        const q = nearest(vertexAt(p), tool.shape);
        if (!q || q.d > tol * 10) continue;
        const nTool = nearestFace(tool.shape, q.p2);
        const a = nTool ? normalAt(nTool, q.p2) : null;
        const b = normalAt(face, p);
        if (!a || !b) continue;
        side = dot(a, b) < 0 ? 1 : -1;
        break;
      }
      if ((side > 0) !== f.flip && side !== 0) removed++;
      else kept.push(s);
    }
    if (!removed) throw this.h.fail('The surface does not cut the body. Make it reach across the body (extend it), or flip the side.');
    if (!kept.length) throw this.h.fail('The cut removes all material');
    const result = kept.length === 1 ? kept[0] : compound(kept);
    const toolFaces = tool.faces.map((x, k) => ({ ...x, name: `${f.id}:c${k}`, feature: f.id }));
    st.faces = this.h.nameFaces(f.id, result, st, toolFaces);
    st.body = result;
    st.edges = null;
  }

  private deleteFace(f: DeleteFaceFeature, st: SurfState): 'surface' | 'body' {
    if (!f.faces.length) throw this.h.fail('Select faces of the solid to delete');
    if (!st.body) throw this.h.fail('There is no solid body to delete faces from');
    const gone = new Set(f.faces.map((r) => {
      if (this.findFace(r, st)) throw this.h.fail('Select faces of the solid. To remove part of a surface, trim it.');
      return this.h.resolveFace(r, st);
    }));
    const rest = st.faces.filter((_, i) => !gone.has(i));
    if (!rest.length) throw this.h.fail('Deleting every face leaves nothing');
    if (f.mode === 'patch') {
      const tol = Math.max(1e-6, sizeOf(st.body) * 1e-7);
      const holes = boundaryLoops(rest.map((x) => x.shape));
      const patches: SurfFace[] = [];
      holes.forEach((loop, k) => {
        const filled = fillLoop(loop);
        if (!filled) throw this.h.fail('The hole left by the deleted faces could not be patched');
        for (const s of subShapes(filled, 'face')) patches.push({ shape: s, desc: describeFace(s), name: `${f.id}:patch${k}`, feature: f.id });
      });
      const all = [...rest, ...patches];
      const { shape, free } = sew(all.map((x) => x.shape), tol);
      const shells = subShapes(shape, 'shell');
      const solid = free === 0 && shells.length === 1 ? solidFromShell(shells[0]) : null;
      if (!solid) throw this.h.fail('The patched faces do not close the body');
      st.faces = inherit(solid, all, tol, (k) => ({ name: `${f.id}:n${k}`, feature: f.id }));
      st.body = solid;
      st.edges = null;
      return 'body';
    }
    // The remaining faces share their edges already: one shell of them.
    const shape = shellOf(rest.map((x) => x.shape));
    const faces = rest.map((x) => ({ ...x }));
    st.body = null;
    st.faces = [];
    st.edges = null;
    this.addBody(st, f.id, shape, faces);
    return 'surface';
  }

  // ---------- output ----------

  /** The solid's mesh and lists with every surface body's faces and edges after them. */
  mesh(base: { mesh: MeshData | null; faces: FaceInfo[]; edges: EdgeInfo[] }, st: SurfState, quality: number): { mesh: MeshData | null; faces: FaceInfo[]; edges: EdgeInfo[] } {
    const box = this.box(st);
    const diag = box ? dist(box.min, box.max) : 1;
    const q = Math.max(0, Math.min(2, quality));
    const tol = Math.max(diag * [0.002, 0.0006, 0.0002][q], 1e-4), ang = [0.5, 0.25, 0.12][q];
    const pos: Float32Array[] = [], nrm: Float32Array[] = [], idx: Uint32Array[] = [], vf: Float32Array[] = [], ep: Float32Array[] = [], eid: Float32Array[] = [], vtx: Float32Array[] = [];
    const m0 = base.mesh;
    if (m0) { pos.push(m0.positions); nrm.push(m0.normals); idx.push(m0.indices); vf.push(m0.vertexFace); ep.push(m0.edgePositions); eid.push(m0.edgeIds); vtx.push(m0.vertices); }
    let vCount = m0 ? m0.positions.length / 3 : 0;
    const faces = [...base.faces];
    const edges = [...base.edges];
    const oc = getOc();
    for (const body of st.surfaces) {
      const f0 = faces.length, e0 = edges.length;
      const m = meshShape(body.shape, tol, ang);
      const fIndex = new ShapeIndex(body.faces.map((x) => x.shape));
      const vface = new Float32Array(m.positions.length / 3);
      const claimed = new Set<number>();
      for (let g = 0; g + 2 < m.faceGroups.length; g += 3) {
        const start = m.faceGroups[g], count = m.faceGroups[g + 1];
        const cands = fIndex.findHash(m.faceGroups[g + 2]);
        const fi = cands.find((c) => !claimed.has(c)) ?? cands[0] ?? 0;
        claimed.add(fi);
        for (let t = start; t < start + count; t++) vface[m.indices[t]] = f0 + fi;
      }
      const shifted = new Uint32Array(m.indices.length);
      for (let i = 0; i < m.indices.length; i++) shifted[i] = m.indices[i] + vCount;
      vCount += m.positions.length / 3;
      pos.push(m.positions); nrm.push(m.normals); idx.push(shifted); vf.push(vface);
      const bes = bodyEdges(body);
      const eIndex = new ShapeIndex(bes.map((e) => e.shape));
      const em = meshEdgesOf(body.shape, tol, ang);
      const lines: number[] = [], ids: number[] = [];
      const claimedE = new Set<number>();
      for (let g = 0; g + 2 < em.groups.length; g += 3) {
        const start = em.groups[g], count = em.groups[g + 1];
        const cands = eIndex.findHash(em.groups[g + 2]);
        const ei = cands.find((c) => !claimedE.has(c)) ?? cands[0] ?? 0;
        claimedE.add(ei);
        const e = bes[ei];
        // Seams (a closed face meeting itself) are not drawn.
        if (e && e.faces.length === 1 && oc.BRep_Tool.IsClosed(e.shape.wrapped, body.faces[e.faces[0]].shape.wrapped)) continue;
        for (let k = start; k < start + count; k++) { lines.push(em.lines[k * 3], em.lines[k * 3 + 1], em.lines[k * 3 + 2]); ids.push(e0 + ei); }
      }
      ep.push(new Float32Array(lines)); eid.push(new Float32Array(ids));
      const vs = subShapes(body.shape, 'vertex').map(vertexPoint);
      const va = new Float32Array(vs.length * 3);
      vs.forEach((p, i) => va.set(p, i * 3));
      vtx.push(va);
      for (const x of body.faces) {
        const d = x.desc;
        const info: FaceInfo = { name: x.name, type: d.type, center: d.center, area: d.area, feature: x.feature, body: body.id };
        if (d.type === 'plane') { info.normal = d.d; info.frame = planarFaceFrame(d); }
        if (d.type === 'cylinder' || d.type === 'sphere') { info.axis = { p: d.p, d: d.d }; info.radius = d.r; }
        faces.push(info);
      }
      for (const e of bes) {
        edges.push({
          name: e.name, type: e.desc.type, a: e.desc.a, b: e.desc.b, mid: e.desc.mid, length: e.desc.length, faces: e.faces.map((i) => f0 + i),
          dir: e.desc.dir, center: e.desc.center, axis: e.desc.axis, radius: e.desc.radius, body: body.id,
        });
      }
    }
    const cat = <T extends Float32Array | Uint32Array>(parts: T[], make: (n: number) => T): T => {
      const out = make(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { out.set(p as never, o); o += p.length; }
      return out;
    };
    const f32 = (n: number) => new Float32Array(n);
    const mesh: MeshData = {
      positions: cat(pos, f32), normals: cat(nrm, f32), indices: cat(idx, (n) => new Uint32Array(n)), vertexFace: cat(vf, f32),
      edgePositions: cat(ep, f32), edgeIds: cat(eid, f32), vertices: cat(vtx, f32),
    };
    return { mesh, faces, edges };
  }

  /** Bounding box of the solid and the surface bodies. */
  box(st: SurfState): { min: Vec3; max: Vec3 } | null {
    const shapes = [...(st.body ? [st.body] : []), ...st.surfaces.map((b) => b.shape)];
    if (!shapes.length) return null;
    return bbox(shapes.length === 1 ? shapes[0] : compound(shapes));
  }

  /** The solid with the surface bodies, for export and drawings. */
  allShapes(st: SurfState): Sh | null {
    const shapes = [...(st.body ? [st.body] : []), ...st.surfaces.map((b) => b.shape)];
    if (!shapes.length) return null;
    return shapes.length === 1 ? shapes[0] : compound(shapes);
  }

  /** Total area of the surface bodies. */
  area(st: SurfState): number {
    return st.surfaces.reduce((a, b) => a + areaOf(b.shape), 0);
  }

  /** A face or edge of a surface body by its index in the build result's lists (after the solid's). */
  shapeAt(st: SurfState, kind: 'face' | 'edge', index: number, solidCount: number): Sh | null {
    let i = index - solidCount;
    if (i < 0) return null;
    for (const b of st.surfaces) {
      const list = kind === 'face' ? b.faces : bodyEdges(b);
      if (i < list.length) return list[i].shape;
      i -= list.length;
    }
    return null;
  }
}

// ---------- geometry helpers ----------

function copyShape(s: Sh): Sh {
  // A transform by the identity copies the geometry (BRepBuilderAPI_Copy is not in the bindings).
  const oc = getOc();
  const tr = new oc.gp_Trsf();
  const mk = new oc.BRepBuilderAPI_Transform(s.wrapped, tr, true, false);
  try { return wrap(mk.Shape()); } finally { mk.delete(); tr.delete(); }
}

/**
 * Whether an offset of `base` by d is one: no face collapsed to nothing, and
 * no part of it nearer the base than d. Offsetting a curved face inward by
 * its radius or more turns it inside out: a cylinder of radius 5 offset by
 * -6 came out as a cylinder of radius 1, on the wrong side of the axis.
 */
function offsetHolds(out: Sh, base: Sh, d: number): boolean {
  const size = Math.max(sizeOf(base), d, 1);
  if (subShapes(out, 'face').some((f) => !(areaOf(f) > size * size * 1e-9))) return false;
  const q = nearest(out, base);
  return !!q && q.d > d * (1 - 1e-3) - size * 1e-6;
}

/** The shape split by the tools (null when the operation fails). */
function splitShape(shape: Sh, tools: Sh[]): Sh | null {
  const oc = getOc();
  const args = new oc.NCollection_List_TopoDS_Shape(), list = new oc.NCollection_List_TopoDS_Shape();
  const sp = new oc.BRepAlgoAPI_Splitter();
  try {
    args.Append(shape.wrapped);
    for (const t of tools) list.Append(t.wrapped);
    sp.SetArguments(args);
    sp.SetTools(list);
    progress((p) => sp.Build(p));
    if (!sp.IsDone() || sp.HasErrors?.()) return null;
    return wrap(sp.Shape());
  } catch {
    return null;
  } finally {
    sp.delete();
    args.delete();
    list.delete();
  }
}

/** Groups faces into pieces connected across edges that do not lie on the tool. */
function components(faces: Sh[], tool: Sh, tol: number): number[][] {
  const edgeFaces = new Map<number, { e: Sh; f: number[] }[]>();
  const oc = getOc();
  faces.forEach((f, fi) => {
    for (const e of subShapes(f, 'edge')) {
      const h = oc.ReplicadShapeHasher.HashCode(e.wrapped, 2147483647);
      let l = edgeFaces.get(h);
      if (!l) edgeFaces.set(h, (l = []));
      const hit = l.find((x) => x.e.wrapped.IsSame(e.wrapped));
      if (hit) { if (!hit.f.includes(fi)) hit.f.push(fi); } else l.push({ e, f: [fi] });
    }
  });
  const parent = faces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const l of edgeFaces.values()) {
    for (const { e, f } of l) {
      if (f.length < 2) continue;
      const mid = describeEdge(e).mid;
      const q = nearest(vertexAt(mid), tool);
      if (q && q.d < tol * 10) continue;
      for (let k = 1; k < f.length; k++) parent[find(f[k])] = find(f[0]);
    }
  }
  const groups = new Map<number, number[]>();
  faces.forEach((_, i) => { const r = find(i); const g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]); });
  return [...groups.values()];
}

/** The face of a shape nearest a point. */
function nearestFace(shape: Sh, p: Vec3): Sh | null {
  const faces = subShapes(shape, 'face');
  if (faces.length === 1) return faces[0];
  const v = vertexAt(p);
  let best: Sh | null = null, bd = Infinity;
  for (const f of faces) {
    const d = nearest(v, f)?.d ?? Infinity;
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

/** Parameters (u, v) of the point of a face's surface nearest p. */
function surfaceParams(face: Sh, p: Vec3): { u: number; v: number } | null {
  const oc = getOc();
  let surf: any = null, proj: any = null;
  const g = pnt(p);
  try {
    surf = oc.BRep_Tool.Surface(face.wrapped);
    proj = new oc.GeomAPI_ProjectPointOnSurf(g, surf, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
    if (!proj.NbPoints()) return null;
    const uv = proj.LowerDistanceParameters(0, 0);
    return { u: uv.U, v: uv.V };
  } catch {
    return null;
  } finally {
    proj?.delete(); surf?.delete?.(); g.delete();
  }
}

/**
 * A strip of width d straight out from a curved edge of a face, tangent to
 * the face, where the outward direction turns along the edge (a circle
 * bounding a flat disc): ruled between the edge and the curve d out from it.
 * 'straight' when the direction does not turn, so a prism makes the strip
 * exactly; null when the strip cannot be made.
 */
function ruledStrip(edge: Sh, face: Sh, outMid: Vec3, sign: number, d: number): Sh | 'straight' | null {
  const oc = getOc();
  const ad = new oc.BRepAdaptor_Curve(edge.wrapped);
  const far: Vec3[] = [];
  let turns = false;
  try {
    const f = ad.FirstParameter(), l = ad.LastParameter();
    const N = 64;
    for (let i = 0; i <= N; i++) {
      const q = new oc.gp_Pnt(), v = new oc.gp_Vec();
      ad.D1(f + ((l - f) * i) / N, q, v);
      const p = xyz(q), t = xyz(v);
      q.delete(); v.delete();
      const n = normalAt(face, p);
      if (!n || !(len(t) > 1e-12)) return null;
      const out = scale(normalize(cross(normalize(t), n)), sign);
      if (dot(out, outMid) < 1 - 1e-9) turns = true;
      far.push(add(p, scale(out, d)));
    }
  } finally {
    ad.delete();
  }
  if (!turns) return 'straight';
  if (describeEdge(edge).closed) far[far.length - 1] = far[0];
  const ts = new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6);
  try {
    const farEdge = R.makeBSplineApproximation(far, { tolerance: Math.max(1e-6, d * 1e-5) });
    ts.AddWire(R.assembleWire([edge as any]).wrapped);
    ts.AddWire(R.assembleWire([farEdge]).wrapped);
    progress((p) => ts.Build(p));
    if (!ts.IsDone()) return null;
    const s = wrap(ts.Shape());
    return isEmpty(s) ? null : s;
  } catch {
    return null;
  } finally {
    ts.delete();
  }
}

/** Unit tangent of an edge at the point of it nearest p. */
function edgeTangent(edge: Sh, p: Vec3): Vec3 | null {
  const oc = getOc();
  const ad = new oc.BRepAdaptor_Curve(edge.wrapped);
  try {
    const f = ad.FirstParameter(), l = ad.LastParameter();
    let best = f, bd = Infinity;
    for (let i = 0; i <= 32; i++) {
      const t = f + ((l - f) * i) / 32;
      const q = ad.Value(t);
      const d = dist(xyz(q), p);
      q.delete();
      if (d < bd) { bd = d; best = t; }
    }
    const q = new oc.gp_Pnt(), v = new oc.gp_Vec();
    ad.D1(best, q, v);
    const out = xyz(v);
    q.delete(); v.delete();
    return len(out) > 1e-12 ? normalize(out) : null;
  } catch {
    return null;
  } finally {
    ad.delete();
  }
}

/** A solid bounded by a closed shell, oriented so its volume is positive. */
function solidFromShell(shell: Sh): Sh | null {
  const oc = getOc();
  const fix = new oc.ShapeFix_Solid();
  try {
    let s = wrap(fix.SolidFromShell(oc.TopoDS.Shell(shell.wrapped)));
    if (volumeOf(s) < 0) s = wrap(s.wrapped.Reversed());
    return volumeOf(s) > 0 ? s : null;
  } catch {
    return null;
  } finally {
    fix.delete();
  }
}

/**
 * A solid made by thickening a surface by t along its normal (negative:
 * against it; both: half each way). A smooth surface is offset as a whole;
 * across sharp edges between faces that offset leaves gaps, so each face is
 * thickened alone and the slabs joined, with a wedge filling the corner
 * outside each sharp (straight) edge, as the offset faces would meet there.
 */
function thickSolid(shape: Sh, t: number, both: boolean, area: number): Sh | null {
  const oc = getOc();
  // A thickened surface takes at least a third of area × thickness (a sphere
  // thickened inward to its centre; less means its offset turned inside out)
  // and no more than its box grown by the thickness. Curvature alone takes it
  // well outside area × thickness: a dome of radius 5 thickened 7 outward is
  // three times that, and inward by 4 four tenths of it.
  const box = bbox(shape);
  const grown = box ? box.max.reduce((v, c, i) => v * (c - box.min[i] + 2 * Math.abs(t)), 1) : Infinity;
  const plausible = (v: number) => v > (area * Math.abs(t) / 3) * (1 - 1e-6) && v < grown * (1 + 1e-6);
  const simple = (base: Sh, off: number): Sh | null => {
    const mk = new oc.BRepOffsetAPI_MakeThickSolid();
    try {
      mk.MakeThickSolidBySimple(base.wrapped, off);
      if (!mk.IsDone()) return null;
      let s = wrap(mk.Shape());
      if (volumeOf(s) < 0) s = wrap(s.wrapped.Reversed());
      return s;
    } catch {
      return null;
    } finally {
      mk.delete();
    }
  };
  const shift = (base: Sh, off: number): Sh | null => {
    const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
    try {
      mk.PerformBySimple(base.wrapped, off);
      return mk.IsDone() ? wrap(mk.Shape()) : null;
    } catch {
      return null;
    } finally {
      mk.delete();
    }
  };
  const make = (base: Sh): Sh | null => {
    const start = both ? shift(base, -t / 2) : base;
    return start ? simple(start, t) : null;
  };
  const sharp = sharpEdges(shape);
  if (!sharp) return null;
  if (!sharp.length) {
    const whole = make(shape);
    if (!whole || isEmpty(whole)) return null;
    return plausible(volumeOf(whole)) && isValid(whole) ? whole : null;
  }
  // Wedges are built for straight edges only.
  if (sharp.some((e) => e.desc.type !== 'line')) return null;
  const pieces: Sh[] = [];
  for (const f of subShapes(shape, 'face')) {
    const slab = make(f);
    if (!slab || !(volumeOf(slab) > 0)) return null;
    pieces.push(slab);
  }
  const sides = both ? [t / 2, -t / 2] : [t];
  for (const e of sharp) {
    const k = 1 + dot(e.na, e.nb);
    if (k < 1e-6) return null;
    for (const s of sides) {
      const P = e.desc.a;
      const quad = [P, add(P, scale(e.na, s)), add(P, scale(add(e.na, e.nb), s / k)), add(P, scale(e.nb, s))];
      try {
        const face = R.makeFace(R.assembleWire(quad.map((q, i) => R.makeLine(q, quad[(i + 1) % 4]))));
        const v = gvec(sub(e.desc.b, e.desc.a));
        const mk = new oc.BRepPrimAPI_MakePrism(face.wrapped, v, false, true);
        try { pieces.push(wrap(mk.Shape())); } finally { mk.delete(); v.delete(); }
      } catch {
        // Faces meeting flat (no corner to fill) make no quad.
      }
    }
  }
  const args = new oc.NCollection_List_TopoDS_Shape(), tools = new oc.NCollection_List_TopoDS_Shape();
  const builder = new oc.BRepAlgoAPI_Fuse();
  try {
    args.Append(pieces[0].wrapped);
    for (let i = 1; i < pieces.length; i++) tools.Append(pieces[i].wrapped);
    builder.SetArguments(args);
    builder.SetTools(tools);
    progress((p) => builder.Build(p));
    if (!builder.IsDone()) return null;
    let out = wrap(builder.Shape());
    const unify = new oc.ShapeUpgrade_UnifySameDomain(out.wrapped, true, true, false);
    try { unify.Build(); out = wrap(unify.Shape()); } finally { unify.delete(); }
    return plausible(volumeOf(out)) && isValid(out) ? out : null;
  } catch {
    return null;
  } finally {
    builder.delete(); args.delete(); tools.delete();
  }
}

/**
 * Edges between two faces of a shell whose normals differ there, with the
 * normals at the edge's start (null when a normal cannot be found).
 */
function sharpEdges(shape: Sh): { desc: EdgeDesc; na: Vec3; nb: Vec3 }[] | null {
  const faces = subShapes(shape, 'face');
  if (faces.length < 2) return [];
  const edges = subShapes(shape, 'edge');
  const index = new ShapeIndex(edges);
  const adj: number[][] = edges.map(() => []);
  faces.forEach((f, fi) => {
    for (const e of subShapes(f, 'edge')) {
      const j = index.find(e.wrapped);
      if (j >= 0 && !adj[j].includes(fi)) adj[j].push(fi);
    }
  });
  const out: { desc: EdgeDesc; na: Vec3; nb: Vec3 }[] = [];
  for (let i = 0; i < edges.length; i++) {
    if (adj[i].length !== 2) continue;
    const desc = describeEdge(edges[i]);
    const na = normalAt(faces[adj[i][0]], desc.mid), nb = normalAt(faces[adj[i][1]], desc.mid);
    if (!na || !nb) return null;
    if (dot(na, nb) < Math.cos(Math.PI / 180)) {
      const a = normalAt(faces[adj[i][0]], desc.a), b = normalAt(faces[adj[i][1]], desc.a);
      if (!a || !b) return null;
      out.push({ desc, na: a, nb: b });
    }
  }
  return out;
}

/** Whether edges join into one closed loop: every end point is shared by two of them. */
function closesLoop(edges: Sh[]): boolean {
  if (!edges.length) return false;
  const ends: Vec3[] = [];
  for (const e of edges) {
    const d = describeEdge(e);
    if (d.closed) { if (edges.length === 1) return true; return false; }
    ends.push(d.a, d.b);
  }
  let size = 1;
  for (const p of ends) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const tol = 1e-5 * size;
  return ends.every((p) => ends.filter((q) => dist(p, q) < tol).length === 2);
}

/** Closed loops of the edges bounding only one of the faces (the holes left in them). */
function boundaryLoops(faces: Sh[]): Sh[][] {
  const oc = getOc();
  const seen = new Map<number, { e: Sh; n: number }[]>();
  for (const f of faces) {
    for (const e of subShapes(f, 'edge')) {
      const h = oc.ReplicadShapeHasher.HashCode(e.wrapped, 2147483647);
      let l = seen.get(h);
      if (!l) seen.set(h, (l = []));
      const hit = l.find((x) => x.e.wrapped.IsSame(e.wrapped));
      if (hit) hit.n++; else l.push({ e, n: 1 });
    }
  }
  const free = [...seen.values()].flat().filter((x) => x.n === 1).map((x) => x.e);
  const ends = free.map((e) => subShapes(e, 'vertex').map(vertexPoint));
  const used = new Set<number>();
  const loops: Sh[][] = [];
  const tol = 1e-6;
  for (let i = 0; i < free.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const loop = [free[i]];
    const start = ends[i][0];
    let tail = ends[i][ends[i].length - 1];
    for (let guard = 0; guard < free.length && dist(start, tail) > tol; guard++) {
      const j = free.findIndex((_, k) => !used.has(k) && ends[k].some((p) => dist(p, tail) < tol));
      if (j < 0) break;
      used.add(j);
      loop.push(free[j]);
      tail = dist(ends[j][0], tail) < tol ? ends[j][ends[j].length - 1] : ends[j][0];
    }
    loops.push(loop);
  }
  return loops;
}

/** A patch over a closed loop of edges. */
function fillLoop(edges: Sh[]): Sh | null {
  if (edges.length > MAX_FILL_EDGES) return null;
  const oc = getOc();
  const mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
  try {
    for (const e of edges) mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
    progress((p) => mk.Build(p));
    if (!mk.IsDone()) return null;
    const s = wrap(mk.Shape());
    return isEmpty(s) ? null : s;
  } catch {
    return null;
  } finally {
    mk.delete();
  }
}

