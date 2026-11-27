// Combines the meshes of an assembly's components into one model for the
// renderer: every component's part mesh is placed by its transform and its
// faces and edges are numbered after those of the components before it, so
// picking, selection states, display styles and section views work on an
// assembly as they do on a part. A combined face or edge remembers its
// component and its index in the part.

import type { EdgeInfo, FaceInfo, MeshData } from '../kernel/protocol';
import type { Frame, Vec3 } from '../math/vec';
import { cross, dot, normalize, qRotate } from '../math/vec';
import type { AsmComponent, Placement } from '../model/assembly';
import type { EdgeRef, FaceRef, Id } from '../model/types';
import { type CamProfile, type Geo, type ProfileArc, applyPlacement, camProfile } from './solver';

/** What the worker built for a part. */
export interface PartGeometry {
  mesh: MeshData | null;
  faces: FaceInfo[];
  edges: EdgeInfo[];
  bbox: { min: Vec3; max: Vec3 } | null;
  cones: Record<number, { p: Vec3; d: Vec3 }>;
}

export interface ComposedModel {
  mesh: MeshData | null;
  faces: FaceInfo[];
  edges: EdgeInfo[];
  bbox: { min: Vec3; max: Vec3 } | null;
  /** RGBA of every combined face (the component's part colour). */
  faceColors: Uint8Array;
  /** For each combined face and edge: the component (index into `comps`) and the index in its part. */
  faceComp: Int32Array;
  faceLocal: Int32Array;
  edgeComp: Int32Array;
  edgeLocal: Int32Array;
  /** The components in the model, in order (what faceComp indexes). */
  comps: Id[];
}

/** Separates a component id from a face or edge name in the combined lists. */
export const NAME_SEP = '#';
export const combinedName = (comp: Id, name: string) => `${comp}${NAME_SEP}${name}`;
export function splitName(name: string): { comp: Id; name: string } | null {
  const i = name.indexOf(NAME_SEP);
  return i > 0 ? { comp: name.slice(0, i), name: name.slice(i + 1) } : null;
}

/** A placement as a 3×4 row-major matrix (rotation | translation). */
export function placementMatrix(pl: Placement): number[] {
  const x = qRotate(pl.q, [1, 0, 0]), y = qRotate(pl.q, [0, 1, 0]), z = qRotate(pl.q, [0, 0, 1]);
  return [x[0], y[0], z[0], pl.p[0], x[1], y[1], z[1], pl.p[1], x[2], y[2], z[2], pl.p[2]];
}

export function composeModel(items: { comp: AsmComponent; placement: Placement; geom: PartGeometry; color: [number, number, number] }[]): ComposedModel {
  let nv = 0, ni = 0, ne = 0, nvert = 0;
  for (const it of items) {
    const m = it.geom.mesh;
    if (!m) continue;
    nv += m.positions.length; ni += m.indices.length; ne += m.edgePositions.length; nvert += m.vertices.length;
  }
  const faces: FaceInfo[] = [];
  const edges: EdgeInfo[] = [];
  const faceComp: number[] = [], faceLocal: number[] = [], edgeComp: number[] = [], edgeLocal: number[] = [];
  const colors: number[] = [];
  if (!nv) {
    return { mesh: null, faces, edges, bbox: null, faceColors: new Uint8Array(0), faceComp: new Int32Array(0), faceLocal: new Int32Array(0), edgeComp: new Int32Array(0), edgeLocal: new Int32Array(0), comps: items.map((i) => i.comp.id) };
  }
  const positions = new Float32Array(nv), normals = new Float32Array(nv), vertexFace = new Float32Array(nv / 3);
  const indices = new Uint32Array(ni), edgePositions = new Float32Array(ne), edgeIds = new Float32Array(ne / 3), vertices = new Float32Array(nvert);
  let ov = 0, oi = 0, oe = 0, overt = 0;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  items.forEach((it, ci) => {
    const { geom, placement: pl } = it;
    const faceBase = faces.length, edgeBase = edges.length;
    const m = geom.mesh;
    const R = rotation(pl);
    const t = pl.p;
    if (m) {
      const vBase = ov / 3;
      for (let k = 0; k < m.positions.length; k += 3) {
        const x = m.positions[k], y = m.positions[k + 1], z = m.positions[k + 2];
        const px = R[0] * x + R[1] * y + R[2] * z + t[0], py = R[3] * x + R[4] * y + R[5] * z + t[1], pz = R[6] * x + R[7] * y + R[8] * z + t[2];
        positions[ov + k] = px; positions[ov + k + 1] = py; positions[ov + k + 2] = pz;
        if (px < min[0]) min[0] = px; if (py < min[1]) min[1] = py; if (pz < min[2]) min[2] = pz;
        if (px > max[0]) max[0] = px; if (py > max[1]) max[1] = py; if (pz > max[2]) max[2] = pz;
        const nx = m.normals[k], ny = m.normals[k + 1], nz = m.normals[k + 2];
        normals[ov + k] = R[0] * nx + R[1] * ny + R[2] * nz;
        normals[ov + k + 1] = R[3] * nx + R[4] * ny + R[5] * nz;
        normals[ov + k + 2] = R[6] * nx + R[7] * ny + R[8] * nz;
      }
      for (let k = 0; k < m.vertexFace.length; k++) vertexFace[ov / 3 + k] = m.vertexFace[k] + faceBase;
      for (let k = 0; k < m.indices.length; k++) indices[oi + k] = m.indices[k] + vBase;
      for (let k = 0; k < m.edgePositions.length; k += 3) {
        const x = m.edgePositions[k], y = m.edgePositions[k + 1], z = m.edgePositions[k + 2];
        edgePositions[oe + k] = R[0] * x + R[1] * y + R[2] * z + t[0];
        edgePositions[oe + k + 1] = R[3] * x + R[4] * y + R[5] * z + t[1];
        edgePositions[oe + k + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
      }
      for (let k = 0; k < m.edgeIds.length; k++) edgeIds[oe / 3 + k] = m.edgeIds[k] + edgeBase;
      for (let k = 0; k < m.vertices.length; k += 3) {
        const x = m.vertices[k], y = m.vertices[k + 1], z = m.vertices[k + 2];
        vertices[overt + k] = R[0] * x + R[1] * y + R[2] * z + t[0];
        vertices[overt + k + 1] = R[3] * x + R[4] * y + R[5] * z + t[1];
        vertices[overt + k + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
      }
      ov += m.positions.length; oi += m.indices.length; oe += m.edgePositions.length; overt += m.vertices.length;
    }
    const P = (p: Vec3) => applyPlacement(pl, p);
    const D = (d: Vec3) => qRotate(pl.q, d);
    const id = it.comp.id;
    geom.faces.forEach((f, i) => {
      const out: FaceInfo = { ...f, name: combinedName(id, f.name), center: P(f.center), feature: id };
      if (f.normal) out.normal = D(f.normal);
      if (f.frame) out.frame = placeFrame(f.frame, pl);
      if (f.axis) out.axis = { p: P(f.axis.p), d: D(f.axis.d) };
      faces.push(out);
      faceComp.push(ci); faceLocal.push(i);
      colors.push(...it.color.map((c) => Math.round(c * 255)), 255);
    });
    geom.edges.forEach((e, i) => {
      const out: EdgeInfo = { ...e, name: combinedName(id, e.name), a: P(e.a), b: P(e.b), mid: P(e.mid), faces: e.faces.map((x) => x + faceBase) };
      if (e.dir) out.dir = D(e.dir);
      if (e.center) out.center = P(e.center);
      if (e.axis) out.axis = D(e.axis);
      edges.push(out);
      edgeComp.push(ci); edgeLocal.push(i);
    });
  });
  return {
    mesh: { positions, normals, indices, vertexFace, edgePositions, edgeIds, vertices },
    faces, edges,
    bbox: min[0] <= max[0] ? { min, max } : null,
    faceColors: new Uint8Array(colors),
    faceComp: Int32Array.from(faceComp), faceLocal: Int32Array.from(faceLocal), edgeComp: Int32Array.from(edgeComp), edgeLocal: Int32Array.from(edgeLocal),
    comps: items.map((i) => i.comp.id),
  };
}

function rotation(pl: Placement): number[] {
  const x = qRotate(pl.q, [1, 0, 0]), y = qRotate(pl.q, [0, 1, 0]), z = qRotate(pl.q, [0, 0, 1]);
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

function placeFrame(f: Frame, pl: Placement): Frame {
  return { o: applyPlacement(pl, f.o), x: qRotate(pl.q, f.x), y: qRotate(pl.q, f.y), n: qRotate(pl.q, f.n) };
}

// ---------- mate geometry from a part's faces and edges ----------

/** The face a reference names in a part's face list (by name, then by signature among same-named pieces). */
export function findFace(faces: FaceInfo[], ref: FaceRef): number {
  const same = faces.map((f, i) => (f.name === ref.name ? i : -1)).filter((i) => i >= 0);
  if (same.length <= 1) return same[0] ?? -1;
  let best = same[0], bestD = Infinity;
  for (const i of same) {
    const c = faces[i].center;
    const d = Math.hypot(c[0] - ref.sig.c[0], c[1] - ref.sig.c[1], c[2] - ref.sig.c[2]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function findEdge(edges: EdgeInfo[], ref: EdgeRef): number {
  const same = edges.map((e, i) => (e.name === ref.name ? i : -1)).filter((i) => i >= 0);
  if (same.length <= 1) return same[0] ?? -1;
  let best = same[0], bestD = Infinity;
  for (const i of same) {
    const m = edges[i].mid;
    const d = Math.hypot(m[0] - ref.sig.m[0], m[1] - ref.sig.m[1], m[2] - ref.sig.m[2]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Mate geometry of a part face (in the part's coordinates), or null for faces mates cannot use. */
export function faceGeo(geom: PartGeometry, index: number): Geo | null {
  const f = geom.faces[index];
  if (!f) return null;
  if (f.type === 'plane' && f.normal) return { kind: 'plane', o: f.center, n: f.normal };
  if (f.type === 'cylinder' && f.axis) return { kind: 'axis', p: f.axis.p, d: f.axis.d, r: f.radius ?? 0, surface: 'cylinder' };
  if (f.type === 'sphere' && f.axis) return { kind: 'sphere', c: f.axis.p, r: f.radius ?? 0 };
  const cone = geom.cones[index];
  if (f.type === 'cone' && cone) return { kind: 'axis', p: cone.p, d: cone.d, r: 0, surface: 'cone' };
  return null;
}

export function edgeGeo(geom: PartGeometry, index: number): Geo | null {
  const e = geom.edges[index];
  if (!e) return null;
  if (e.type === 'line' && e.dir) return { kind: 'line', p: e.a, d: e.dir };
  if (e.type === 'circle' && e.center && e.axis) return { kind: 'axis', p: e.center, d: e.axis, r: e.radius ?? 0, surface: 'circle' };
  return null;
}

/** A cam's profile from the faces of its part, or why it cannot be one. */
export function camProfileOf(g: PartGeometry, refs: FaceRef[], name: string): CamProfile | string {
  const arcs: ProfileArc[] = [], points: Vec3[] = [];
  let d: Vec3 | null = null;
  const normals: Vec3[] = [];
  for (const ref of refs) {
    const i = findFace(g.faces, ref);
    if (i < 0) return `A face of the cam's profile on ${name} no longer exists`;
    const f = g.faces[i];
    const edges = g.edges.filter((e) => e.faces.includes(i));
    if (f.type === 'cylinder' && f.axis && f.radius) {
      const ax = normalize(f.axis.d);
      if (d && Math.abs(dot(d, ax)) < 0.9999) return 'The faces of the cam\'s profile must all run along one direction (the cam\'s sides)';
      d ??= ax;
      // Its extent from a circular edge: a whole circle closes on itself.
      const e = edges.find((x) => x.type === 'circle' && x.radius && Math.abs(x.radius - f.radius!) < 1e-6 * Math.max(1, f.radius!));
      const whole = !e || Math.abs(e.length - 2 * Math.PI * f.radius) < 1e-6 * f.radius;
      arcs.push({ c: f.axis.p, r: f.radius, ...(whole ? {} : { ends: [e!.a, e!.b, e!.mid] as [Vec3, Vec3, Vec3] }) });
      continue;
    }
    if (f.type === 'plane' && f.normal) normals.push(normalize(f.normal));
    for (const e of edges) points.push(e.a, e.b, e.mid);
    // Curved faces of other kinds: their mesh vertices (as close as the mesh is to the face).
    const m = g.mesh;
    if (m && f.type !== 'plane') for (let k = 0; k < m.vertexFace.length; k++) if (m.vertexFace[k] === i) points.push([m.positions[k * 3], m.positions[k * 3 + 1], m.positions[k * 3 + 2]]);
  }
  if (!d) {
    for (let i = 0; i < normals.length && !d; i++) for (let j = i + 1; j < normals.length && !d; j++) { const x = cross(normals[i], normals[j]); if (Math.hypot(...x) > 1e-3) d = normalize(x); }
  }
  if (!d) return 'Select the faces around the cam (its sides): their direction cannot be told from these';
  if (normals.some((n) => Math.abs(dot(n, d!)) > 1e-6)) return 'The faces of the cam\'s profile must all run along one direction (the cam\'s sides, not its ends)';
  return camProfile(d, arcs, points);
}
