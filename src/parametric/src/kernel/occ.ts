/* eslint-disable @typescript-eslint/no-explicit-any */
// Thin helpers over the OpenCascade WebAssembly bindings: topology
// enumeration, surface/curve descriptors, transforms, booleans and fast mesh
// extraction straight from the WebAssembly heap.

import * as R from 'replicad';
import type { Frame, Vec3 } from '../math/vec';
import { cross, dot, frameFrom, len, normalize, scale, sub } from '../math/vec';

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
export function subShapes(shape: Sh, kind: TopoKind): Sh[] {
  const out: Sh[] = [];
  const buckets = new Map<number, any[]>();
  const ex = new oc.TopExp_Explorer(shape.wrapped, kindEnum(kind), oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
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

/** Sketch frame for a planar face: origin is the projected world origin. */
export function planarFaceFrame(desc: SurfDesc): Frame {
  const n = desc.d;
  const o = sub([0, 0, 0], scale(n, dot(sub([0, 0, 0], desc.p), n)));
  // Prefer world X projected into the plane, else world Z.
  const cand: Vec3 = Math.abs(n[0]) < 0.99 ? [1, 0, 0] : [0, 0, -Math.sign(n[0])];
  return frameFrom(o, cand, n);
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

export function rotated(shape: Sh, p: Vec3, d: Vec3, angleRad: number): Sh {
  const tr = new oc.gp_Trsf();
  const ax = new oc.gp_Ax1(pnt(p), gdir(d));
  tr.SetRotation(ax, angleRad);
  try { return transformShape(shape, tr); } finally { ax.delete(); tr.delete(); }
}

export function mirrored(shape: Sh, p: Vec3, n: Vec3): Sh {
  const tr = new oc.gp_Trsf();
  const ax = new oc.gp_Ax2(pnt(p), gdir(n));
  tr.SetMirror(ax);
  try { return transformShape(shape, tr); } finally { ax.delete(); tr.delete(); }
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
  return runBoolean(new oc.BRepAlgoAPI_Fuse(a.wrapped, b.wrapped));
}

export function cut(a: Sh, b: Sh): Sh {
  return runBoolean(new oc.BRepAlgoAPI_Cut(a.wrapped, b.wrapped));
}

export function common(a: Sh, b: Sh): Sh {
  return runBoolean(new oc.BRepAlgoAPI_Common(a.wrapped, b.wrapped));
}

export function compound(shapes: Sh[]): Sh {
  return R.makeCompound(shapes as any) as unknown as Sh;
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
