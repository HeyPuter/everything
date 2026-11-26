/* eslint-disable @typescript-eslint/no-explicit-any */
// Assemblies in the geometry worker. Every part an assembly uses is built by
// a ModelBuilder of its own (kept while the assembly uses it), and the
// components are placed copies of those bodies. The main thread places the
// meshes itself, so moving a component never needs the worker; the worker
// keeps the current placement of every component (the scene) for what needs
// the exact solids: measuring between components, interference, mass
// properties, drawing projections and STEP and STL export.

import * as R from 'replicad';
import type { Vec3 } from '../math/vec';
import { add, dist, scale, sub } from '../math/vec';
import type { Feature, Id } from '../model/types';
import { ModelBuilder, eigenSym3 } from './build';
import { cutOutlines, halfOf } from './drawing-section';
import { type Sh, bbox, common, compound, getOc, gdir, meshShape, pnt, projectShape, subShapes, volumeOf, wrap, xyz } from './occ';
import type { BuildResult, EdgeInfo, FaceInfo, FeatureStatus, MassProperties, MeasureResult, MeasureTarget, MeshData, ProjectionRequest, ProjectionResult } from './protocol';

export interface AsmPartBuild {
  /** Identifies the part's content (the key of its embedded copy). */
  key: string;
  features: Feature[];
  blobs: Record<Id, string>;
  quality: number;
  invalid?: Record<Id, string>;
}

export interface AsmPartResult {
  key: string;
  quality: number;
  mesh: MeshData | null;
  faces: FaceInfo[];
  edges: EdgeInfo[];
  bbox: { min: Vec3; max: Vec3 } | null;
  status: FeatureStatus[];
  /** Axes of conical faces (by face index), which the part's face list does not carry. */
  cones: Record<number, { p: Vec3; d: Vec3 }>;
}

/** A component in the worker's scene: its part and its placement as a 3×4 row-major matrix. */
export interface AsmSceneItem {
  part: string;
  m: number[];
  name: string;
  color: string;
  /**
   * Hidden components are in the scene for mass properties (hiding only
   * changes what is shown), but not in the graphics area's face and edge
   * lists, measuring, interference, drawings or export.
   */
  hidden?: boolean;
}

export interface InterferencePair {
  /** Scene indices of the two components. */
  a: number;
  b: number;
  volume: number;
  mesh: MeshData | null;
  /** The overlap of the two could not be computed: they were not checked (volume 0, no mesh). */
  failed?: boolean;
}

export interface AsmMassResult {
  /** Some component has no closed solid (its volume is left out). */
  open: string[];
  /** kg */
  mass: number;
  /** mm³ */
  volume: number;
  /** mm² */
  area: number;
  center: Vec3;
  /** About the centre of mass, assembly axes, kg·mm², row-major 3×3. */
  inertia: number[];
  principal: { moments: Vec3; axes: [Vec3, Vec3, Vec3] };
}

export type AsmRequest =
  | { op: 'build'; parts: AsmPartBuild[] }
  | { op: 'scene'; items: AsmSceneItem[] }
  | { op: 'drop'; keep: string[] }
  | { op: 'interference' }
  /** densities: kg/m³ for each scene item. */
  | { op: 'mass'; densities: number[] }
  /** Drawing projections of components placed as given (the scene is left as it is). */
  | { op: 'project'; items: AsmSceneItem[]; views: ProjectionRequest[] };

const IDENTITY_M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export class AssemblyBuilder {
  /** The open document is an assembly: drawings, measure and export use the scene. */
  active = false;
  private builders = new Map<string, ModelBuilder>();
  private scene: AsmSceneItem[] = [];
  private placedCache = new Map<string, Sh>();

  reset() {
    this.builders.clear();
    this.placedCache.clear();
    this.scene = [];
  }

  async build(parts: AsmPartBuild[]): Promise<AsmPartResult[]> {
    this.active = true;
    const out: AsmPartResult[] = [];
    for (const p of parts) {
      let b = this.builders.get(p.key);
      if (!b) this.builders.set(p.key, (b = new ModelBuilder()));
      const res: BuildResult = await b.build({ features: p.features, upTo: p.features.length, blobs: p.blobs, quality: p.quality, invalid: p.invalid });
      const shapes = b.currentShapes();
      const cones: AsmPartResult['cones'] = {};
      shapes.faces.forEach((f, i) => { if (f.desc.type === 'cone') { const ax = coneAxis(f.shape); if (ax) cones[i] = ax; } });
      out.push({ key: p.key, quality: p.quality, mesh: copyMesh(res.mesh), faces: res.faces, edges: res.edges, bbox: res.bbox, status: res.status, cones });
    }
    this.placedCache.clear();
    return out;
  }

  /** Forgets the parts the assembly no longer uses. */
  drop(keep: string[]) {
    const k = new Set(keep);
    for (const key of [...this.builders.keys()]) if (!k.has(key)) this.builders.delete(key);
  }

  setScene(items: AsmSceneItem[]) {
    this.active = true;
    this.scene = items;
    this.placedCache.clear();
  }

  private shapesOf(key: string) {
    const b = this.builders.get(key);
    if (!b) throw new Error('A part of the assembly is not built yet. Rebuild the assembly and try again.');
    return b.currentShapes();
  }

  /** A component's body where the scene places it (null when its part has no body). */
  private placedBody(i: number): Sh | null {
    const it = this.scene[i];
    const cacheKey = `${i}|${it.part}|${it.m.join(',')}`;
    const hit = this.placedCache.get(cacheKey);
    if (hit) return hit;
    const body = this.shapesOf(it.part).body;
    if (!body) return null;
    const placed = place(body, it.m);
    this.placedCache.set(cacheKey, placed);
    return placed;
  }

  /** The placed bodies of the shown components (`hidden`: of the hidden ones too), with their scene indices. */
  private bodies(hidden = false): { i: number; shape: Sh }[] {
    const out: { i: number; shape: Sh }[] = [];
    this.scene.forEach((it, i) => { if (it.hidden && !hidden) return; const s = this.placedBody(i); if (s) out.push({ i, shape: s }); });
    return out;
  }

  /** The face or edge with a combined index (components in scene order, as the main thread lists them). */
  private locate(kind: 'face' | 'edge', index: number): Sh {
    let k = index;
    for (const it of this.scene) {
      if (it.hidden) continue;
      const s = this.shapesOf(it.part);
      const list = kind === 'face' ? s.faces.map((f) => f.shape) : s.edges;
      if (k < list.length) return place(list[k], it.m);
      k -= list.length;
    }
    throw new Error(`${kind === 'face' ? 'Face' : 'Edge'} not found`);
  }

  measure(a: MeasureTarget, b: MeasureTarget): MeasureResult {
    const oc = getOc();
    const shapeOf = (t: MeasureTarget): Sh => {
      if (t.kind === 'vertex') {
        const gp = pnt(t.p);
        const mv = new oc.BRepBuilderAPI_MakeVertex(gp);
        const v = wrap(mv.Vertex());
        mv.delete();
        gp.delete();
        return v;
      }
      return this.locate(t.kind, t.index);
    };
    const s1 = shapeOf(a), s2 = shapeOf(b);
    const ext = new oc.BRepExtrema_DistShapeShape();
    const progress = new oc.Message_ProgressRange();
    try {
      ext.LoadS1(s1.wrapped);
      ext.LoadS2(s2.wrapped);
      ext.Perform(progress);
      if (!ext.IsDone() || ext.NbSolution() < 1) throw new Error('Distance could not be computed');
      const p1 = ext.PointOnShape1(1), p2 = ext.PointOnShape2(1);
      const out = { distance: ext.Value(), p1: xyz(p1), p2: xyz(p2) };
      p1.delete(); p2.delete();
      return out;
    } finally {
      ext.delete();
      progress.delete();
    }
  }

  /**
   * The combined solid of the visible components where they are placed:
   * what a drawing of the assembly projects (see project).
   */
  combined(): Sh | null {
    const list = this.bodies();
    return list.length ? compound(list.map((b) => b.shape)) : null;
  }

  project(views: ProjectionRequest[]): ProjectionResult[] {
    return projectBodies(this.bodies().map((b) => b.shape), views);
  }

  /**
   * Projections of the components placed as `items` say (a drawing of the assembly
   * collapsed or exploded, whatever the graphics area shows). Hidden components are drawn.
   */
  projectItems(items: AsmSceneItem[], views: ProjectionRequest[]): ProjectionResult[] {
    const list: Sh[] = [];
    for (const it of items) {
      const body = this.shapesOf(it.part).body;
      if (body) list.push(place(body, it.m));
    }
    return projectBodies(list, views);
  }

  /** Volume properties per unit density of all components together (what the part's Mass Properties reports). */
  massProperties(): MassProperties | null {
    const r = this.mass(this.scene.map(() => 1e9));
    if (!r) return null;
    // At 1e9 kg/m³ a cubic millimetre weighs a kilogram: the values are per unit density in mm.
    return { solid: !r.open.length, volume: r.volume, area: r.area, center: r.center, inertia: r.inertia, principal: r.principal };
  }

  /** Mass properties of the components (hidden ones too), each with its own density (kg/m³) by scene index. */
  mass(densities: number[]): AsmMassResult | null {
    const oc = getOc();
    const items: { m: number; v: number; area: number; c: Vec3; I: number[] }[] = [];
    const open: string[] = [];
    for (const { i, shape } of this.bodies(true)) {
      const props = new oc.GProp_GProps();
      const sprops = new oc.GProp_GProps();
      try {
        oc.BRepGProp.VolumeProperties(shape.wrapped, props, true, false, false);
        oc.BRepGProp.SurfaceProperties(shape.wrapped, sprops, true, false);
        const v = props.Mass();
        const b = bbox(shape);
        const area = sprops.Mass();
        if (!(v > (b ? dist(b.min, b.max) : 1) ** 3 * 1e-12)) { open.push(this.scene[i].name); items.push({ m: 0, v: 0, area, c: [0, 0, 0], I: new Array(9).fill(0) }); continue; }
        const gc = props.CentreOfMass();
        const c = xyz(gc);
        gc.delete();
        const moment = (d: Vec3) => {
          const gp = pnt(c), gd = gdir(d);
          const ax = new oc.gp_Ax1(gp, gd);
          const val = props.MomentOfInertia(ax);
          ax.delete(); gp.delete(); gd.delete();
          return val;
        };
        const ixx = moment([1, 0, 0]), iyy = moment([0, 1, 0]), izz = moment([0, 0, 1]);
        const s = Math.SQRT1_2;
        const ixy = moment([s, s, 0]) - (ixx + iyy) / 2;
        const iyz = moment([0, s, s]) - (iyy + izz) / 2;
        const ixz = moment([s, 0, s]) - (ixx + izz) / 2;
        const rho = (densities[i] ?? 1000) * 1e-9; // kg/mm³
        items.push({ m: v * rho, v, area, c, I: [ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz].map((x) => x * rho) });
      } finally {
        props.delete();
        sprops.delete();
      }
    }
    if (!items.length) return null;
    const mass = items.reduce((s, x) => s + x.m, 0);
    const volume = items.reduce((s, x) => s + x.v, 0);
    const area = items.reduce((s, x) => s + x.area, 0);
    const center: Vec3 = mass > 0 ? scale(items.reduce((s, x) => add(s, scale(x.c, x.m)), [0, 0, 0] as Vec3), 1 / mass) : [0, 0, 0];
    // Each component's inertia moved to the common centre (parallel axis theorem).
    const I = new Array<number>(9).fill(0);
    for (const x of items) {
      const d = sub(x.c, center);
      const d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) I[r * 3 + c] += x.I[r * 3 + c] + x.m * ((r === c ? d2 : 0) - d[r] * d[c]);
    }
    return { open, mass, volume, area, center, inertia: I, principal: eigenSym3(I) };
  }

  /** The solid two placed bodies share (a method so tests can make it fail). */
  protected sharedSolid(a: Sh, b: Sh): Sh {
    return common(a, b);
  }

  /**
   * Pairs of components whose solids overlap, with the volume they share, and
   * pairs whose overlap could not be computed (`failed`: never reported as clear).
   */
  interference(): InterferencePair[] {
    const list = this.bodies().map((b) => ({ ...b, box: bbox(b.shape) }));
    const all = this.combined();
    const ab = all ? bbox(all) : null;
    const diag = ab ? dist(ab.min, ab.max) : 1;
    const minVolume = Math.max(1e-6, 1e-12 * diag ** 3);
    const out: InterferencePair[] = [];
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const A = list[x], B = list[y];
        if (!A.box || !B.box || !boxesOverlap(A.box, B.box)) continue;
        let shared: Sh, v: number;
        try {
          shared = this.sharedSolid(A.shape, B.shape);
          v = volumeOf(shared);
        } catch {
          out.push({ a: A.i, b: B.i, volume: 0, mesh: null, failed: true });
          continue;
        }
        if (!Number.isFinite(v)) { out.push({ a: A.i, b: B.i, volume: 0, mesh: null, failed: true }); continue; }
        if (!(v > minVolume)) continue;
        out.push({ a: A.i, b: B.i, volume: v, mesh: meshOf(shared, diag) });
      }
    }
    return out;
  }

  /** A STEP file with every component as a named solid of its own. */
  async exportStep(): Promise<Uint8Array> {
    const list = this.bodies();
    if (!list.length) throw new Error('There is no geometry to export');
    const oc = getOc();
    // replicad's writer changes global translation settings: they are put back
    // afterwards so a part exported later is written exactly as before.
    const ints = ['write.surfacecurve.mode', 'write.precision.mode', 'write.step.assembly', 'write.step.schema'];
    const strs = ['write.step.unit', 'xstep.cascade.unit'];
    const savedI = ints.map((k) => oc.Interface_Static.IVal(k));
    const savedC = strs.map((k) => oc.Interface_Static.CVal(k));
    const naming = oc.XCAFDoc_ShapeTool.AutoNaming();
    try {
      const blob = (R as any).exportSTEP(list.map(({ i, shape }) => ({ shape, name: this.scene[i].name, color: this.scene[i].color })), { unit: 'MM' }) as Blob;
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      ints.forEach((k, j) => oc.Interface_Static.SetIVal(k, savedI[j]));
      strs.forEach((k, j) => oc.Interface_Static.SetCVal(k, savedC[j]));
      oc.XCAFDoc_ShapeTool.SetAutoNaming(naming);
    }
  }

  /** Binary STL of all components where they are placed. */
  exportStl(quality: number): Uint8Array {
    const list = this.bodies();
    if (!list.length) throw new Error('There is no geometry to export');
    const all = this.combined()!;
    const b = bbox(all);
    const diag = b ? dist(b.min, b.max) : 1;
    const q = Math.max(1, Math.min(2, quality));
    const meshes = list.map(({ shape }) => meshShape(shape, Math.max(diag * [0.002, 0.0006, 0.0002][q] * 0.5, 1e-4), [0.5, 0.25, 0.12][q] * 0.5));
    const tris = meshes.reduce((s, m) => s + m.indices.length / 3, 0);
    const buf = new ArrayBuffer(84 + tris * 50);
    const dv = new DataView(buf);
    const header = 'Parametric binary STL (assembly)';
    for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
    dv.setUint32(80, tris, true);
    let o = 84;
    for (const m of meshes) {
      const P = m.positions;
      for (let t = 0; t < m.indices.length / 3; t++) {
        const i0 = m.indices[t * 3] * 3, i1 = m.indices[t * 3 + 1] * 3, i2 = m.indices[t * 3 + 2] * 3;
        const ux = P[i1] - P[i0], uy = P[i1 + 1] - P[i0 + 1], uz = P[i1 + 2] - P[i0 + 2];
        const vx = P[i2] - P[i0], vy = P[i2 + 1] - P[i0 + 1], vz = P[i2 + 2] - P[i0 + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
        o += 12;
        for (const i of [i0, i1, i2]) {
          dv.setFloat32(o, P[i], true); dv.setFloat32(o + 4, P[i + 1], true); dv.setFloat32(o + 8, P[i + 2], true);
          o += 12;
        }
        dv.setUint16(o, 0, true);
        o += 2;
      }
    }
    return new Uint8Array(buf);
  }

  /** The scene item count (tests). */
  get sceneSize(): number {
    return this.scene.length;
  }
}

/**
 * Hidden-line projections of placed components. A section view cuts each component on its
 * own (a boolean on all of them at once loses those that touch), and tells which component
 * each cut outline belongs to, so neighbours are hatched differently.
 */
function projectBodies(list: Sh[], views: ProjectionRequest[]): ProjectionResult[] {
  const body = list.length ? compound(list) : null;
  const b = body ? bbox(body) : null;
  const tol = b ? Math.max(dist(b.min, b.max) * 1e-3, 1e-4) : 0.01;
  return views.map((v) => {
    if (!body || !b) return { id: v.id, visible: [], hidden: [], bounds: null };
    if (!v.section) return { id: v.id, ...projectShape(body, v.dir, v.x, tol, tol / 10, v.hidden !== false, v.smooth !== false) };
    const { p, n } = v.section;
    const size = 2 * (dist(b.min, b.max) + Math.hypot(...p) + Math.hypot(...b.min) + 1);
    const halves: Sh[] = [], cut: number[][] = [], cutGroups: number[] = [];
    list.forEach((s, i) => {
      const half = halfOf(s, p, n, size);
      if (!subShapes(half, 'face').length) return;
      halves.push(half);
      for (const pl of cutOutlines(half, p, n, v.dir, v.x, tol)) { cut.push(pl); cutGroups.push(i); }
    });
    if (!halves.length) return { id: v.id, visible: [], hidden: [], bounds: null, cut: [] };
    return { id: v.id, ...projectShape(compound(halves), v.dir, v.x, tol, tol / 10, v.hidden !== false, v.smooth !== false), cut, cutGroups };
  });
}

/** A shape moved by a rigid 3×4 row-major matrix (the geometry is shared, only its location changes). */
export function place(shape: Sh, m: number[]): Sh {
  if (m.every((v, i) => Math.abs(v - IDENTITY_M[i]) < 1e-15)) return shape;
  const oc = getOc();
  const tr = new oc.gp_Trsf();
  try {
    tr.SetValues(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11]);
    const t = new oc.BRepBuilderAPI_Transform(shape.wrapped, tr, false);
    try { return wrap(t.Shape()); } finally { t.delete(); }
  } finally {
    tr.delete();
  }
}

function coneAxis(face: Sh): { p: Vec3; d: Vec3 } | null {
  const oc = getOc();
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
  try {
    const cone = ad.Cone();
    const ax = cone.Axis();
    const loc = ax.Location(), dd = ax.Direction();
    const out = { p: xyz(loc), d: xyz(dd) };
    loc.delete(); dd.delete(); ax.delete(); cone.delete();
    return out;
  } catch {
    return null;
  } finally {
    ad.delete();
  }
}

function boxesOverlap(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): boolean {
  for (let k = 0; k < 3; k++) if (a.max[k] < b.min[k] - 1e-7 || b.max[k] < a.min[k] - 1e-7) return false;
  return true;
}

function meshOf(shape: Sh, diag: number): MeshData | null {
  try {
    const m = meshShape(shape, Math.max(diag * 0.001, 1e-4), 0.3);
    if (!m.indices.length) return null;
    return { positions: m.positions, normals: m.normals, indices: m.indices, vertexFace: new Float32Array(m.positions.length / 3), edgePositions: new Float32Array(0), edgeIds: new Float32Array(0), vertices: new Float32Array(0) };
  } catch {
    return null;
  }
}

function copyMesh(m: MeshData | null): MeshData | null {
  return m && {
    positions: m.positions.slice(), normals: m.normals.slice(), indices: m.indices.slice(), vertexFace: m.vertexFace.slice(),
    edgePositions: m.edgePositions.slice(), edgeIds: m.edgeIds.slice(), vertices: m.vertices.slice(),
  };
}

/** Buffers of the meshes in results, to transfer rather than copy. */
export function asmTransfers(result: unknown): Transferable[] {
  const out: Transferable[] = [];
  const add = (m: MeshData | null | undefined) => {
    if (!m) return;
    for (const a of [m.positions, m.normals, m.indices, m.vertexFace, m.edgePositions, m.edgeIds, m.vertices]) out.push(a.buffer as ArrayBuffer);
  };
  if (Array.isArray(result)) for (const r of result) add((r as { mesh?: MeshData | null })?.mesh);
  return out;
}
