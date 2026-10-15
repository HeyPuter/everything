// Per-object paint/sculpt session: topology caches (triangles, adjacency), a BVH for surface
// raycasts, incrementally maintained face/vertex normals and direct updates of the synced GPU
// geometry so strokes stay interactive on large meshes without re-evaluating the depsgraph.
import { BufferAttribute, BufferGeometry, DoubleSide, Matrix3, Matrix4, Ray, Vector3, type Mesh } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { app } from '../app/app';
import type { MeshData, ObjectData } from '../data/types';
import { triangulatePoly, vertexFaces, vertexNeighbors } from '../mesh/mesh';
import { renderContext } from '../render/context';
import { shareGeometry } from '../render/geometry';
import type { View3D } from '../editors/view3d/view3d';
import { activeHiddenFaces, hiddenVerts, paintFilter } from './fsdata';

export interface Hit {
  /** hit point in object space */
  point: Vector3;
  /** world space hit point */
  world: Vector3;
  /** triangle index (into session.tris) */
  tri: number;
  face: number;
  /** face normal in object space (unit) */
  normal: Vector3;
}

export class MeshSession {
  obId: string;
  meshId: string;
  indices: Uint32Array;
  offsets: Uint32Array;
  nv: number;
  nf: number;
  nc: number;
  /** triangle corner indices (3 per triangle) */
  triCorners: Uint32Array;
  /** triangle vertex indices (3 per triangle) */
  tris: Uint32Array;
  triFace: Uint32Array;
  vf: { offsets: Uint32Array; faces: Uint32Array; corners: Uint32Array };
  private nbCache: { offsets: Uint32Array; neighbors: Uint32Array } | null = null;
  positions: Float32Array;
  /** unnormalized (area weighted) face normals */
  fn: Float32Array;
  /** unit vertex normals */
  vn: Float32Array;
  private bvhGeo: BufferGeometry;
  private bvh: MeshBVH;
  bvhDirty = false;
  private lastRefit = 0;
  // scratch
  vstamp: Uint32Array;
  fstamp: Uint32Array;
  private stampV = 1;
  private stampF = 1;
  /** gather buffers for brush dabs */
  gv: Int32Array;
  gf: Float32Array;
  gd: Float32Array;
  tmp: Float32Array;
  // GPU dirty corner range
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private dirtyColorLo = Infinity;
  private dirtyColorHi = -1;
  private dirtyExtra = new Map<string, [number, number]>();
  /** true when the synced geometry mirrors the base mesh corner-for-corner */
  direct = false;
  /** Sculpt Mode hidden faces / vertices (null when everything is visible) */
  hiddenF: Uint8Array | null = null;
  hiddenV: Uint8Array | null = null;
  /** paint modes: faces / vertices the brushes may touch (selection masks, hidden geometry) */
  paintFaces: Uint8Array | null = null;
  paintVerts: Uint8Array | null = null;

  constructor(ob: ObjectData, me: MeshData) {
    this.obId = ob.id;
    this.meshId = me.id;
    this.indices = me.indices;
    this.offsets = me.offsets;
    this.positions = me.positions;
    this.nv = me.positions.length / 3;
    this.nf = me.offsets.length - 1;
    this.nc = me.indices.length;
    const corners: number[] = [];
    const tf: number[] = [];
    const tmp: number[] = [];
    for (let f = 0; f < this.nf; f++) {
      const s = me.offsets[f],
        e = me.offsets[f + 1];
      tmp.length = 0;
      triangulatePoly(me.positions, me.indices.subarray(s, e), tmp, s);
      for (let i = 0; i < tmp.length; i++) corners.push(tmp[i]);
      for (let i = 0; i < tmp.length / 3; i++) tf.push(f);
    }
    this.triCorners = new Uint32Array(corners);
    this.tris = new Uint32Array(corners.length);
    for (let i = 0; i < corners.length; i++) this.tris[i] = me.indices[corners[i]];
    this.triFace = new Uint32Array(tf);
    this.vf = vertexFaces(me);
    this.fn = new Float32Array(this.nf * 3);
    this.vn = new Float32Array(this.nv * 3);
    this.vstamp = new Uint32Array(this.nv);
    this.fstamp = new Uint32Array(this.nf);
    this.gv = new Int32Array(this.nv);
    this.gf = new Float32Array(this.nv);
    this.gd = new Float32Array(this.nv);
    this.tmp = new Float32Array(this.nv * 3);
    this.recomputeNormals();
    this.bvhGeo = new BufferGeometry();
    this.bvhGeo.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.bvhGeo.setIndex(new BufferAttribute(this.tris, 1));
    this.bvh = new MeshBVH(this.bvhGeo, { indirect: true });
  }

  get neighbors() {
    if (!this.nbCache)
      this.nbCache = vertexNeighbors({
        offsets: this.offsets,
        indices: this.indices,
        positions: this.positions,
      });
    return this.nbCache;
  }

  /** Mesh positions array was replaced (copy-on-write, undo, other editors). */
  setPositions(p: Float32Array, sameContents: boolean) {
    if (p === this.positions) return;
    this.positions = p;
    this.bvhGeo.setAttribute('position', new BufferAttribute(p, 3));
    if (!sameContents) {
      this.recomputeNormals();
      this.bvh.refit();
      this.bvhDirty = false;
    }
  }

  // ---------------------------------------------------------------------------
  // normals

  private faceNormal(f: number) {
    const P = this.positions,
      I = this.indices;
    const s = this.offsets[f],
      e = this.offsets[f + 1];
    let x = 0,
      y = 0,
      z = 0;
    // Newell's method: magnitude is twice the polygon area
    for (let c = s; c < e; c++) {
      const a = I[c] * 3,
        b = I[c + 1 < e ? c + 1 : s] * 3;
      x += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      y += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      z += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    this.fn[f * 3] = x;
    this.fn[f * 3 + 1] = y;
    this.fn[f * 3 + 2] = z;
  }

  private vertexNormal(v: number) {
    const o = this.vf.offsets,
      F = this.vf.faces,
      fn = this.fn;
    let x = 0,
      y = 0,
      z = 0;
    for (let k = o[v]; k < o[v + 1]; k++) {
      const f = F[k] * 3;
      x += fn[f];
      y += fn[f + 1];
      z += fn[f + 2];
    }
    const l = Math.hypot(x, y, z) || 1;
    this.vn[v * 3] = x / l;
    this.vn[v * 3 + 1] = y / l;
    this.vn[v * 3 + 2] = z / l;
  }

  recomputeNormals() {
    for (let f = 0; f < this.nf; f++) this.faceNormal(f);
    for (let v = 0; v < this.nv; v++) this.vertexNormal(v);
  }

  private nextV() {
    if (++this.stampV >= 0xfffffff0) {
      this.vstamp.fill(0);
      this.stampV = 1;
    }
    return this.stampV;
  }
  private nextF() {
    if (++this.stampF >= 0xfffffff0) {
      this.fstamp.fill(0);
      this.stampF = 1;
    }
    return this.stampF;
  }

  /** Faces adjacent to the given vertices (deduplicated). */
  facesOf(verts: ArrayLike<number>, n: number): number[] {
    const st = this.nextF();
    const out: number[] = [];
    const o = this.vf.offsets,
      F = this.vf.faces;
    for (let i = 0; i < n; i++) {
      const v = verts[i];
      for (let k = o[v]; k < o[v + 1]; k++) {
        const f = F[k];
        if (this.fstamp[f] !== st) {
          this.fstamp[f] = st;
          out.push(f);
        }
      }
    }
    return out;
  }

  /** Recompute normals around moved vertices; returns the affected faces. */
  updateNormals(verts: ArrayLike<number>, n: number): number[] {
    const faces = this.facesOf(verts, n);
    for (const f of faces) this.faceNormal(f);
    const st = this.nextV();
    const I = this.indices,
      O = this.offsets;
    for (const f of faces)
      for (let c = O[f]; c < O[f + 1]; c++) {
        const v = I[c];
        if (this.vstamp[v] !== st) {
          this.vstamp[v] = st;
          this.vertexNormal(v);
        }
      }
    this.bvhDirty = true;
    return faces;
  }

  // ---------------------------------------------------------------------------
  // raycast

  world(): Matrix4 {
    return app.graph.get(this.obId)?.world ?? new Matrix4();
  }

  /** Average scale of the object matrix (object ↔ world distance conversion). */
  scale(): number {
    const e = this.world().elements;
    const sx = Math.hypot(e[0], e[1], e[2]),
      sy = Math.hypot(e[4], e[5], e[6]),
      sz = Math.hypot(e[8], e[9], e[10]);
    return (sx + sy + sz) / 3 || 1;
  }

  /** Refit the BVH after vertices moved (throttled while a stroke is running). */
  refit(force = false) {
    if (!this.bvhDirty) return;
    const now = performance.now();
    if (!force && now - this.lastRefit < 60) return;
    this.bvh.refit();
    this.bvhDirty = false;
    this.lastRefit = performance.now();
  }

  /** Object-space ray under a viewport pixel. */
  localRay(v: View3D, x: number, y: number): Ray {
    const { origin, dir } = v.ray(x, y);
    const inv = this.world().clone().invert();
    const o = origin.clone().applyMatrix4(inv);
    const d = dir.clone().applyMatrix3(new Matrix3().setFromMatrix4(inv)).normalize();
    return new Ray(o, d);
  }

  raycast(v: View3D, x: number, y: number): Hit | null {
    this.refit();
    const ray = this.localRay(v, x, y);
    let hit = this.hiddenF ? null : this.bvh.raycastFirst(ray, DoubleSide);
    if (this.hiddenF) {
      const hf = this.hiddenF;
      const all = this.bvh.raycast(ray, DoubleSide).sort((a, b) => a.distance - b.distance);
      hit = all.find((x) => x.faceIndex != null && !hf[this.triFace[x.faceIndex]]) ?? null;
    }
    if (!hit || hit.faceIndex == null) return null;
    const tri = hit.faceIndex;
    const face = this.triFace[tri];
    const n = new Vector3(this.fn[face * 3], this.fn[face * 3 + 1], this.fn[face * 3 + 2]).normalize();
    return {
      point: hit.point.clone(),
      world: hit.point.clone().applyMatrix4(this.world()),
      tri,
      face,
      normal: n,
    };
  }

  /** Object-space length of `px` screen pixels at the depth of a world point. */
  pixelsToLocal(v: View3D, worldPoint: Vector3, px: number): number {
    const p = v.project(worldPoint);
    const a = v.unproject(p.x, p.y, worldPoint);
    const b = v.unproject(p.x + px, p.y, worldPoint);
    return a.distanceTo(b) / this.scale();
  }

  /** Object-space view direction (camera → point) for a local point. */
  viewDir(v: View3D, local: Vector3): Vector3 {
    const w = this.world();
    const pw = local.clone().applyMatrix4(w);
    const p = v.project(pw);
    const ray = this.localRay(v, p.x, p.y);
    return ray.direction;
  }

  // ---------------------------------------------------------------------------
  // GPU geometry

  /** The synced three.js mesh of the object (if any). */
  syncedMesh(): Mesh | undefined {
    renderContext?.ensureSynced();
    return renderContext?.sync.objects.get(this.obId)?.mesh;
  }

  /** Geometry whose corners map 1:1 to the base mesh corners, or null (modifiers / shape keys). */
  liveGeometry(): BufferGeometry | null {
    if (!this.direct) return null;
    const m = this.syncedMesh();
    const g = m?.geometry;
    if (!g) return null;
    const pos = g.getAttribute('position');
    if (!pos || pos.count !== this.nc) return null;
    return g;
  }

  /**
   * Write positions and normals of the given faces into the synced geometry (corner layout).
   * Smooth faces get vertex normals, flat faces the face normal.
   */
  writeFaces(faces: number[], smooth: Uint8Array | undefined) {
    const g = this.liveGeometry();
    if (!g) return;
    const pa = g.getAttribute('position') as BufferAttribute,
      na = g.getAttribute('normal') as BufferAttribute;
    const pos = pa.array as Float32Array,
      nrm = na.array as Float32Array;
    const P = this.positions,
      I = this.indices,
      O = this.offsets,
      vn = this.vn,
      fn = this.fn;
    let lo = this.dirtyLo,
      hi = this.dirtyHi;
    for (const f of faces) {
      const s = O[f],
        e = O[f + 1];
      if (s < lo) lo = s;
      if (e - 1 > hi) hi = e - 1;
      const sm = smooth ? smooth[f] : 0;
      let fx = 0,
        fy = 0,
        fz = 0;
      if (!sm) {
        const l = Math.hypot(fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]) || 1;
        fx = fn[f * 3] / l;
        fy = fn[f * 3 + 1] / l;
        fz = fn[f * 3 + 2] / l;
      }
      for (let c = s; c < e; c++) {
        const v = I[c] * 3;
        pos[c * 3] = P[v];
        pos[c * 3 + 1] = P[v + 1];
        pos[c * 3 + 2] = P[v + 2];
        if (sm) {
          nrm[c * 3] = vn[v];
          nrm[c * 3 + 1] = vn[v + 1];
          nrm[c * 3 + 2] = vn[v + 2];
        } else {
          nrm[c * 3] = fx;
          nrm[c * 3 + 1] = fy;
          nrm[c * 3 + 2] = fz;
        }
      }
    }
    this.dirtyLo = lo;
    this.dirtyHi = hi;
  }

  /** Mark a corner range of the color attribute dirty (vertex paint). */
  markColorDirty(lo: number, hi: number) {
    if (lo < this.dirtyColorLo) this.dirtyColorLo = lo;
    if (hi > this.dirtyColorHi) this.dirtyColorHi = hi;
  }

  markAttrDirty(name: string, lo: number, hi: number) {
    const r = this.dirtyExtra.get(name);
    if (!r) this.dirtyExtra.set(name, [lo, hi]);
    else {
      r[0] = Math.min(r[0], lo);
      r[1] = Math.max(r[1], hi);
    }
  }

  /** Upload dirty ranges to the GPU and redraw. */
  flush() {
    const m = this.syncedMesh();
    const g = this.liveGeometry();
    if (g && this.dirtyHi >= this.dirtyLo) {
      for (const name of ['position', 'normal']) {
        const a = g.getAttribute(name) as BufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(this.dirtyLo * 3, (this.dirtyHi - this.dirtyLo + 1) * 3);
        a.needsUpdate = true;
      }
      const wire = renderContext?.sync.objects.get(this.obId)?.wire;
      const wa = wire?.geometry.getAttribute('position') as BufferAttribute | undefined;
      if (wa && wa.array === this.positions) wa.needsUpdate = true;
    }
    if (g && this.dirtyColorHi >= this.dirtyColorLo) {
      const a = g.getAttribute('color') as BufferAttribute | undefined;
      if (a) {
        a.clearUpdateRanges();
        a.addUpdateRange(this.dirtyColorLo * 4, (this.dirtyColorHi - this.dirtyColorLo + 1) * 4);
        a.needsUpdate = true;
      }
    }
    if (m)
      for (const [name, [lo, hi]] of this.dirtyExtra) {
        const a = m.geometry.getAttribute(name) as BufferAttribute | undefined;
        if (!a) continue;
        a.clearUpdateRanges();
        a.addUpdateRange(lo * a.itemSize, (hi - lo + 1) * a.itemSize);
        a.needsUpdate = true;
      }
    this.dirtyLo = this.dirtyColorLo = Infinity;
    this.dirtyHi = this.dirtyColorHi = -1;
    this.dirtyExtra.clear();
    renderContext?.engine.requestDraw();
  }

  /** Recompute the bounding volumes of the synced geometry (after a stroke). */
  finishGeometry() {
    const g = this.liveGeometry();
    if (g) {
      g.computeBoundingSphere();
      g.computeBoundingBox();
    }
    this.refit(true);
  }
}

let current: MeshSession | null = null;

/** Session for the active mesh object (rebuilt when the topology changed). */
export function meshSession(): MeshSession | null {
  const ob = app.activeObject;
  const me = ob?.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
  if (!ob || !me || !me.indices.length) return null;
  if (current && current.obId === ob.id && current.meshId === me.id && current.indices === me.indices && current.offsets === me.offsets && current.nv === me.positions.length / 3) {
    current.setPositions(me.positions, false);
  } else current = new MeshSession(ob, me);
  const sculpt = app.doc.mode === 'SCULPT';
  current.hiddenF = sculpt ? activeHiddenFaces(me) : null;
  current.hiddenV = current.hiddenF ? hiddenVerts(me) : null;
  const pm = app.doc.mode === 'VERTEX_PAINT' || app.doc.mode === 'WEIGHT_PAINT' || app.doc.mode === 'TEXTURE_PAINT';
  const pf = pm ? paintFilter(me) : null;
  current.paintFaces = pf?.faces ?? null;
  current.paintVerts = pf?.verts ?? null;
  return current;
}

export function dropSession() {
  current = null;
}

export function activeMeshData(): { ob: ObjectData; me: MeshData } | null {
  const ob = app.activeObject;
  const me = ob?.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
  return ob && me ? { ob, me } : null;
}

/**
 * Prepare a stroke that replaces some mesh arrays copy-on-write: `mutate` performs the cow()
 * calls. The depsgraph is re-evaluated immediately and the GPU geometry of the previous
 * evaluation is carried over, so the stroke can write into it directly.
 */
export function beginGeometryStroke(s: MeshSession, me: MeshData, mutate: () => void) {
  const ev = app.graph.get(s.obId);
  const before = ev?.mesh;
  const directBefore = !!before && before.positions === me.positions && before.indices === me.indices;
  const oldPositions = me.positions;
  mutate();
  s.setPositions(me.positions, true);
  app.evaluate();
  const after = app.graph.get(s.obId)?.mesh;
  s.direct = false;
  if (before && after && directBefore && after.positions === me.positions && after.indices === me.indices) {
    if (before === after || shareGeometry(before, after)) s.direct = true;
  }
  void oldPositions;
  app.changed('geometry');
  renderContext?.forceSync();
  renderContext?.ensureSynced();
}

/** Re-evaluate the object through its modifier stack (non-direct sessions), throttled by the caller. */
export function reevaluate(s: MeshSession) {
  app.graph.invalidate(s.obId);
  app.changed('geometry');
}
