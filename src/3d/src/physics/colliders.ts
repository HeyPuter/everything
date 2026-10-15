// Collision objects for cloth, soft bodies and particles: world-space triangle
// soups (interpolated between the previous and current frame) in a spatial hash.
import type { DocumentData, ObjectData } from '../data/types';
import type { Matrix4 } from 'three';
import { meshSignature, baseEvalMesh } from '../eval/depsgraph';
import { collectionMembers, motionKey, worldAt, type SimContext } from './common';
import type { CollisionSettingsX } from './types';
import { triangulatePoly } from '../mesh/mesh';

export function colliderObjects(doc: DocumentData, exclude?: string, collection?: string | null): ObjectData[] {
  const out: ObjectData[] = [];
  // a collision collection limits the colliders to its objects
  const only = collectionMembers(doc, collection);
  for (const id of doc.object_order) {
    const ob = doc.objects[id];
    if (!ob || ob.id === exclude || !ob.collision?.use || ob.hide_viewport || (only && !only.has(ob.id))) continue;
    if (ob.type !== 'MESH' && ob.type !== 'CURVE' && ob.type !== 'FONT') continue;
    out.push(ob);
  }
  return out;
}

export function collidersKey(doc: DocumentData, refFrame: number, exclude?: string, collection?: string | null): string {
  return colliderObjects(doc, exclude, collection)
    .map((ob) => {
      const me = ob.type === 'MESH' && ob.data ? doc.meshes[ob.data] : null;
      return `${ob.id}:${JSON.stringify(ob.collision)}:${me ? meshSignature(me) : ''}:${JSON.stringify(ob.modifiers)}:${motionKey(doc, ob, refFrame)}`;
    })
    .join('|');
}

/** Triangulate a polygon mesh into a flat index list. */
export function triangulate(positions: Float32Array, offsets: Uint32Array, indices: Uint32Array): Uint32Array {
  const out: number[] = [];
  for (let f = 0; f < offsets.length - 1; f++) {
    const s = offsets[f],
      e = offsets[f + 1];
    const n = e - s;
    if (n < 3) continue;
    if (n === 3) out.push(indices[s], indices[s + 1], indices[s + 2]);
    else if (n === 4) out.push(indices[s], indices[s + 1], indices[s + 2], indices[s], indices[s + 2], indices[s + 3]);
    else {
      const verts = indices.subarray(s, e);
      const local: number[] = [];
      triangulatePoly(positions, verts, local);
      for (const i of local) out.push(verts[i]);
    }
  }
  return new Uint32Array(out);
}

export class ColliderMesh {
  pos: Float32Array;
  cell = 1;
  grid = new Map<number, number[]>();
  big: number[] = [];
  private stamp: Uint32Array;
  private stampId = 1;

  constructor(
    public id: string,
    public settings: CollisionSettingsX,
    public p0: Float32Array,
    public p1: Float32Array,
    public tris: Uint32Array,
    margin: number,
  ) {
    this.pos = new Float32Array(p1);
    this.stamp = new Uint32Array(tris.length / 3);
    this.build(margin);
  }

  setTime(t: number) {
    const a = this.p0,
      b = this.p1,
      p = this.pos;
    if (t >= 1) p.set(b);
    else for (let i = 0; i < p.length; i++) p[i] = a[i] + (b[i] - a[i]) * t;
  }

  private key(ix: number, iy: number, iz: number) {
    return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;
  }

  private build(margin: number) {
    const nt = this.tris.length / 3;
    if (!nt) return;
    // cell size from the average triangle extent
    let ext = 0;
    const bb = (t: number, out: number[]) => {
      out[0] = out[1] = out[2] = Infinity;
      out[3] = out[4] = out[5] = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = this.tris[t * 3 + k] * 3;
        for (const P of [this.p0, this.p1])
          for (let c = 0; c < 3; c++) {
            out[c] = Math.min(out[c], P[v + c] - margin);
            out[c + 3] = Math.max(out[c + 3], P[v + c] + margin);
          }
      }
    };
    const b = [0, 0, 0, 0, 0, 0];
    for (let t = 0; t < nt; t++) {
      bb(t, b);
      ext += Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    }
    this.cell = Math.max(1e-3, ext / nt, margin * 2);
    const h = this.cell;
    for (let t = 0; t < nt; t++) {
      bb(t, b);
      const x0 = Math.floor(b[0] / h),
        y0 = Math.floor(b[1] / h),
        z0 = Math.floor(b[2] / h),
        x1 = Math.floor(b[3] / h),
        y1 = Math.floor(b[4] / h),
        z1 = Math.floor(b[5] / h);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 512) {
        this.big.push(t);
        continue;
      }
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) {
            const k = this.key(x, y, z);
            let list = this.grid.get(k);
            if (!list) this.grid.set(k, (list = []));
            list.push(t);
          }
    }
  }

  /** Visit candidate triangles near an axis-aligned box. */
  forEachNear(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, fn: (t: number) => void) {
    const h = this.cell;
    if (++this.stampId === 0xffffffff) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    const sid = this.stampId;
    const st = this.stamp;
    for (const t of this.big)
      if (st[t] !== sid) {
        st[t] = sid;
        fn(t);
      }
    const ax = Math.floor(x0 / h),
      ay = Math.floor(y0 / h),
      az = Math.floor(z0 / h),
      bx = Math.floor(x1 / h),
      by = Math.floor(y1 / h),
      bz = Math.floor(z1 / h);
    if ((bx - ax + 1) * (by - ay + 1) * (bz - az + 1) > 4096) {
      for (let t = 0; t < st.length; t++)
        if (st[t] !== sid) {
          st[t] = sid;
          fn(t);
        }
      return;
    }
    for (let x = ax; x <= bx; x++)
      for (let y = ay; y <= by; y++)
        for (let z = az; z <= bz; z++) {
          const list = this.grid.get(this.key(x, y, z));
          if (!list) continue;
          for (const t of list)
            if (st[t] !== sid) {
              st[t] = sid;
              fn(t);
            }
        }
  }
}

/** Result of closest-point queries (reused to avoid allocations). */
export interface Hit {
  /** closest point */
  cx: number;
  cy: number;
  cz: number;
  /** triangle normal (unit) */
  nx: number;
  ny: number;
  nz: number;
  dist: number;
  /** barycentric velocity of the surface point over the frame (world units per frame) */
  vx: number;
  vy: number;
  vz: number;
  collider: ColliderMesh | null;
}

export const newHit = (): Hit => ({ cx: 0, cy: 0, cz: 0, nx: 0, ny: 0, nz: 1, dist: Infinity, vx: 0, vy: 0, vz: 0, collider: null });

/** Closest point on triangle (a, b, c) to p, returning barycentric weights in w. */
export function closestOnTri(px: number, py: number, pz: number, P: Float32Array, ia: number, ib: number, ic: number, w: number[]): void {
  const ax = P[ia],
    ay = P[ia + 1],
    az = P[ia + 2];
  const abx = P[ib] - ax,
    aby = P[ib + 1] - ay,
    abz = P[ib + 2] - az;
  const acx = P[ic] - ax,
    acy = P[ic + 1] - ay,
    acz = P[ic + 2] - az;
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return void ((w[0] = 1), (w[1] = 0), (w[2] = 0));
  const bpx = px - P[ib],
    bpy = py - P[ib + 1],
    bpz = pz - P[ib + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz,
    d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return void ((w[0] = 0), (w[1] = 1), (w[2] = 0));
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return void ((w[0] = 1 - v), (w[1] = v), (w[2] = 0));
  }
  const cpx = px - P[ic],
    cpy = py - P[ic + 1],
    cpz = pz - P[ic + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz,
    d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return void ((w[0] = 0), (w[1] = 0), (w[2] = 1));
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return void ((w[0] = 1 - t), (w[1] = 0), (w[2] = t));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return void ((w[0] = 0), (w[1] = 1 - t), (w[2] = t));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom,
    u = vc * denom;
  w[0] = 1 - v - u;
  w[1] = v;
  w[2] = u;
}

const _w = [0, 0, 0];

/** Closest surface point among all colliders within radius r. Returns false when none. */
export function closestSurface(cols: ColliderMesh[], x: number, y: number, z: number, r: number, hit: Hit): boolean {
  hit.dist = Infinity;
  hit.collider = null;
  for (const c of cols) {
    const P = c.pos,
      T = c.tris;
    c.forEachNear(x - r, y - r, z - r, x + r, y + r, z + r, (t) => {
      const ia = T[t * 3] * 3,
        ib = T[t * 3 + 1] * 3,
        ic = T[t * 3 + 2] * 3;
      closestOnTri(x, y, z, P, ia, ib, ic, _w);
      const qx = P[ia] * _w[0] + P[ib] * _w[1] + P[ic] * _w[2];
      const qy = P[ia + 1] * _w[0] + P[ib + 1] * _w[1] + P[ic + 1] * _w[2];
      const qz = P[ia + 2] * _w[0] + P[ib + 2] * _w[1] + P[ic + 2] * _w[2];
      const d = Math.hypot(x - qx, y - qy, z - qz);
      if (d > r || d >= hit.dist) return;
      // triangle normal
      const e1x = P[ib] - P[ia],
        e1y = P[ib + 1] - P[ia + 1],
        e1z = P[ib + 2] - P[ia + 2];
      const e2x = P[ic] - P[ia],
        e2y = P[ic + 1] - P[ia + 1],
        e2z = P[ic + 2] - P[ia + 2];
      let nx = e1y * e2z - e1z * e2y,
        ny = e1z * e2x - e1x * e2z,
        nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-12) return;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      hit.dist = d;
      hit.cx = qx;
      hit.cy = qy;
      hit.cz = qz;
      hit.nx = nx;
      hit.ny = ny;
      hit.nz = nz;
      const A = c.p0,
        B = c.p1;
      hit.vx = (B[ia] - A[ia]) * _w[0] + (B[ib] - A[ib]) * _w[1] + (B[ic] - A[ic]) * _w[2];
      hit.vy = (B[ia + 1] - A[ia + 1]) * _w[0] + (B[ib + 1] - A[ib + 1]) * _w[1] + (B[ic + 1] - A[ic + 1]) * _w[2];
      hit.vz = (B[ia + 2] - A[ia + 2]) * _w[0] + (B[ib + 2] - A[ib + 2]) * _w[1] + (B[ic + 2] - A[ic + 2]) * _w[2];
      hit.collider = c;
    });
  }
  return hit.collider !== null;
}

/** First triangle crossed by segment a→b (Möller–Trumbore). Fills hit (dist = segment parameter). */
export function segmentHit(cols: ColliderMesh[], ax: number, ay: number, az: number, bx: number, by: number, bz: number, hit: Hit, pad = 0): boolean {
  hit.dist = Infinity;
  hit.collider = null;
  const dx = bx - ax,
    dy = by - ay,
    dz = bz - az;
  for (const c of cols) {
    const P = c.pos,
      T = c.tris;
    c.forEachNear(Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.min(az, bz) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad, Math.max(az, bz) + pad, (t) => {
      const ia = T[t * 3] * 3,
        ib = T[t * 3 + 1] * 3,
        ic = T[t * 3 + 2] * 3;
      const e1x = P[ib] - P[ia],
        e1y = P[ib + 1] - P[ia + 1],
        e1z = P[ib + 2] - P[ia + 2];
      const e2x = P[ic] - P[ia],
        e2y = P[ic + 1] - P[ia + 1],
        e2z = P[ic + 2] - P[ia + 2];
      const px = dy * e2z - dz * e2y,
        py = dz * e2x - dx * e2z,
        pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) return;
      const inv = 1 / det;
      const tx = ax - P[ia],
        ty = ay - P[ia + 1],
        tz = az - P[ia + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) return;
      const qx = ty * e1z - tz * e1y,
        qy = tz * e1x - tx * e1z,
        qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) return;
      const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (s < 0 || s > 1 || s >= hit.dist) return;
      let nx = e1y * e2z - e1z * e2y,
        ny = e1z * e2x - e1x * e2z,
        nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      hit.dist = s;
      hit.cx = ax + dx * s;
      hit.cy = ay + dy * s;
      hit.cz = az + dz * s;
      hit.nx = nx;
      hit.ny = ny;
      hit.nz = nz;
      const w0 = 1 - u - v;
      const A = c.p0,
        B = c.p1;
      hit.vx = (B[ia] - A[ia]) * w0 + (B[ib] - A[ib]) * u + (B[ic] - A[ic]) * v;
      hit.vy = (B[ia + 1] - A[ia + 1]) * w0 + (B[ib + 1] - A[ib + 1]) * u + (B[ic + 1] - A[ic + 1]) * v;
      hit.vz = (B[ia + 2] - A[ia + 2]) * w0 + (B[ib + 2] - A[ib + 2]) * u + (B[ic + 2] - A[ic + 2]) * v;
      hit.collider = c;
    });
  }
  return hit.collider !== null;
}

function transformed(local: Float32Array, m: Matrix4): Float32Array {
  const e = m.elements;
  const out = new Float32Array(local.length);
  for (let i = 0; i < local.length; i += 3) {
    const x = local[i],
      y = local[i + 1],
      z = local[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  return out;
}

const triCache = new WeakMap<Uint32Array, Uint32Array>();

/** Build collider meshes for the step from frame-1 to frame. */
export function buildColliders(ctx: SimContext, frame: number, exclude: string | undefined, margin: number, collection?: string | null): ColliderMesh[] {
  const out: ColliderMesh[] = [];
  for (const ob of colliderObjects(ctx.doc, exclude, collection)) {
    const ev = ctx.graph?.get(ob.id);
    let mesh = ev?.mesh;
    if (!mesh) {
      const me = ob.type === 'MESH' && ob.data ? ctx.doc.meshes[ob.data] : undefined;
      if (!me) continue;
      mesh = baseEvalMesh(me);
    }
    let tris = triCache.get(mesh.indices);
    if (!tris) {
      tris = triangulate(mesh.positions, mesh.offsets, mesh.indices);
      triCache.set(mesh.indices, tris);
    }
    if (!tris.length) continue;
    const m1 = worldAt(ctx, ob, frame),
      m0 = worldAt(ctx, ob, frame - 1);
    const st = ob.collision as CollisionSettingsX;
    out.push(new ColliderMesh(ob.id, st, transformed(mesh.positions, m0), transformed(mesh.positions, m1), tris, margin + (st.thickness_outer ?? 0.02)));
  }
  return out;
}
