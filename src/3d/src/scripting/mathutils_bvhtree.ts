// `mathutils.bvhtree`: a bounding volume hierarchy over mesh triangles for fast ray casts,
// nearest-point and overlap queries from scripts. Built once (median split on the longest
// axis of the triangle centroids, up to 4 triangles per leaf), queried with an explicit
// stack and front-to-back child ordering. Results report the source polygon index.
import { app } from '../app/app';
import { ensureEvaluated } from './rna';
import { Vector, toArray, mathError, type VecLike } from './mathutils';
import { tessellateRings } from './mathutils_geometry';

const LEAF = 4;
type Hit = [Vector, Vector, number, number];
type NoHit = [null, null, null, null];
const NO_HIT: NoHit = [null, null, null, null];

/** Mesh topology in the document layout: xyz per vertex, polygon corner offsets (faces + 1), corner vertex indices. */
export interface FlatMesh {
  positions: ArrayLike<number>;
  offsets: ArrayLike<number>;
  indices: ArrayLike<number>;
}

function triangulatePolygon(P: ArrayLike<number>, corners: number[], out: number[]) {
  const n = corners.length;
  if (n < 3) return;
  if (n === 3) {
    out.push(corners[0], corners[1], corners[2]);
    return;
  }
  if (n === 4) {
    // split along the shorter diagonal, or the one that keeps both triangles facing the same way (concave quads)
    const p = corners.map((c) => [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]]);
    const nrm = (a: number[], b: number[], c: number[]) => {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    };
    const d = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const d02 = (p[0][0] - p[2][0]) ** 2 + (p[0][1] - p[2][1]) ** 2 + (p[0][2] - p[2][2]) ** 2;
    const d13 = (p[1][0] - p[3][0]) ** 2 + (p[1][1] - p[3][1]) ** 2 + (p[1][2] - p[3][2]) ** 2;
    const ok02 = d(nrm(p[0], p[1], p[2]), nrm(p[0], p[2], p[3])) > 0,
      ok13 = d(nrm(p[0], p[1], p[3]), nrm(p[1], p[2], p[3])) > 0;
    // prefer the shorter diagonal unless it would fold the quad
    if (ok02 && (!ok13 || d02 <= d13)) out.push(corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]);
    else out.push(corners[0], corners[1], corners[3], corners[1], corners[2], corners[3]);
    return;
  }
  const ring = corners.map((c) => [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]] as [number, number, number]);
  const tris = tessellateRings([ring]);
  if (!tris.length) for (let k = 1; k + 1 < n; k++) out.push(corners[0], corners[k], corners[k + 1]);
  else for (const t of tris) out.push(corners[t[0]], corners[t[1]], corners[t[2]]);
}

export class BVHTree {
  readonly __type = 'BVHTree';
  private tri: Float64Array; // 9 per triangle, in leaf order
  private triPoly: Int32Array;
  private polyN: Float64Array; // 3 per polygon
  private nodeBox: Float64Array; // minx, miny, minz, maxx, maxy, maxz
  private nodeLeft: Int32Array; // first child (second child = left + 1) for inner nodes
  private nodeStart: Int32Array;
  private nodeCount: Int32Array; // > 0 for leaves
  private nodes = 0;
  private epsilon: number;
  private stack = new Int32Array(256);
  private scratch = new Float64Array(3);

  /** Use the From* constructors. */
  constructor(mesh: FlatMesh, epsilon = 0, allTriangles = false) {
    this.epsilon = Math.max(0, Number(epsilon) || 0);
    const P = mesh.positions,
      O = mesh.offsets,
      I = mesh.indices;
    const nv = Math.floor(P.length / 3);
    const np = Math.max(0, O.length - 1);
    const corners: number[] = [];
    const polyOf: number[] = [];
    this.polyN = new Float64Array(np * 3);
    for (let f = 0; f < np; f++) {
      const cs: number[] = [];
      for (let c = O[f]; c < O[f + 1]; c++) {
        const v = I[c];
        if (!(v >= 0 && v < nv)) throw mathError('ValueError', `BVHTree: polygon ${f} uses vertex index ${v}, but there are only ${nv} vertices`);
        cs.push(v);
      }
      // polygon normal (Newell)
      let nx = 0,
        ny = 0,
        nz = 0;
      for (let k = 0; k < cs.length; k++) {
        const a = cs[k] * 3,
          b = cs[(k + 1) % cs.length] * 3;
        nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
        ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
        nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      this.polyN.set([nx / l, ny / l, nz / l], f * 3);
      const before = corners.length;
      if (allTriangles && cs.length >= 3) corners.push(cs[0], cs[1], cs[2]);
      else triangulatePolygon(P, cs, corners);
      for (let k = before; k < corners.length; k += 3) polyOf.push(f);
    }
    const nt = polyOf.length;
    const raw = new Float64Array(nt * 9);
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) raw[t * 9 + k * 3 + a] = P[corners[t * 3 + k] * 3 + a];
    // build
    const order = new Int32Array(nt);
    const cen = new Float64Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      order[t] = t;
      for (let a = 0; a < 3; a++) cen[t * 3 + a] = (raw[t * 9 + a] + raw[t * 9 + 3 + a] + raw[t * 9 + 6 + a]) / 3;
    }
    const maxNodes = Math.max(1, 2 * Math.ceil(nt / 1) + 1);
    this.nodeBox = new Float64Array(maxNodes * 6);
    this.nodeLeft = new Int32Array(maxNodes);
    this.nodeStart = new Int32Array(maxNodes);
    this.nodeCount = new Int32Array(maxNodes);
    const eps = this.epsilon;
    const select = (lo: number, hi: number, k: number, ax: number) => {
      hi--;
      while (hi > lo) {
        const pv = cen[order[(lo + hi) >> 1] * 3 + ax];
        let i = lo,
          j = hi;
        while (i <= j) {
          while (cen[order[i] * 3 + ax] < pv) i++;
          while (cen[order[j] * 3 + ax] > pv) j--;
          if (i <= j) {
            const tmp = order[i];
            order[i] = order[j];
            order[j] = tmp;
            i++;
            j--;
          }
        }
        if (k <= j) hi = j;
        else if (k >= i) lo = i;
        else return;
      }
    };
    const build = (node: number, lo: number, hi: number) => {
      let mnx = Infinity,
        mny = Infinity,
        mnz = Infinity,
        mxx = -Infinity,
        mxy = -Infinity,
        mxz = -Infinity;
      let cnx = Infinity,
        cny = Infinity,
        cnz = Infinity,
        cxx = -Infinity,
        cxy = -Infinity,
        cxz = -Infinity;
      for (let i = lo; i < hi; i++) {
        const t = order[i];
        for (let k = 0; k < 9; k += 3) {
          const x = raw[t * 9 + k],
            y = raw[t * 9 + k + 1],
            z = raw[t * 9 + k + 2];
          if (x < mnx) mnx = x;
          if (y < mny) mny = y;
          if (z < mnz) mnz = z;
          if (x > mxx) mxx = x;
          if (y > mxy) mxy = y;
          if (z > mxz) mxz = z;
        }
        const x = cen[t * 3],
          y = cen[t * 3 + 1],
          z = cen[t * 3 + 2];
        if (x < cnx) cnx = x;
        if (y < cny) cny = y;
        if (z < cnz) cnz = z;
        if (x > cxx) cxx = x;
        if (y > cxy) cxy = y;
        if (z > cxz) cxz = z;
      }
      this.nodeBox.set([mnx - eps, mny - eps, mnz - eps, mxx + eps, mxy + eps, mxz + eps], node * 6);
      if (hi - lo <= LEAF) {
        this.nodeStart[node] = lo;
        this.nodeCount[node] = hi - lo;
        return;
      }
      const ex = cxx - cnx,
        ey = cxy - cny,
        ez = cxz - cnz;
      const ax = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const mid = (lo + hi) >> 1;
      select(lo, hi, mid, ax);
      const left = this.nodes;
      this.nodes += 2;
      this.nodeLeft[node] = left;
      this.nodeCount[node] = 0;
      build(left, lo, mid);
      build(left + 1, mid, hi);
    };
    this.nodes = 1;
    if (nt) build(0, 0, nt);
    else this.nodeBox.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], 0);
    // store triangles in leaf order
    this.tri = new Float64Array(nt * 9);
    this.triPoly = new Int32Array(nt);
    for (let i = 0; i < nt; i++) {
      const t = order[i];
      this.tri.set(raw.subarray(t * 9, t * 9 + 9), i * 9);
      this.triPoly[i] = polyOf[t];
    }
  }

  // -------------------------------------------------------------------------
  // constructors

  /** Tree over polygons given as vertex coordinates and lists of vertex indices. */
  static FromPolygons(vertices: VecLike[], polygons: ArrayLike<number>[], all_triangles = false, epsilon = 0) {
    const verts = Array.from(vertices ?? []);
    const positions = new Float64Array(verts.length * 3);
    verts.forEach((v, i) => {
      const a = toArray(v);
      positions[i * 3] = a[0];
      positions[i * 3 + 1] = a[1];
      positions[i * 3 + 2] = a[2] ?? 0;
    });
    const offsets = [0];
    const indices: number[] = [];
    for (const p of Array.from(polygons ?? [])) {
      for (const i of Array.from(p as ArrayLike<number>)) indices.push(Number(i));
      offsets.push(indices.length);
    }
    return new BVHTree({ positions, offsets, indices }, epsilon, !!all_triangles);
  }

  /** Same as FromPolygons with flat arrays (xyz per vertex, corner offsets, corner indices); used by the Python module. */
  static _fromFlat(positions: ArrayLike<number>, offsets: ArrayLike<number>, indices: ArrayLike<number>, all_triangles = false, epsilon = 0) {
    return new BVHTree({ positions, offsets, indices }, epsilon, !!all_triangles);
  }

  /** Tree over an object's evaluated mesh in object space (deform=false uses the mesh without modifiers). */
  static FromObject(object: unknown, _depsgraph?: unknown, deform = true, _render = false, _cage = false, epsilon = 0) {
    const ob = object as { __table?: string; __id?: string } | null;
    if (!ob || ob.__table !== 'objects' || typeof ob.__id !== 'string') throw mathError('TypeError', 'BVHTree.FromObject(): expected an Object');
    const raw = app.doc.objects[ob.__id];
    if (!raw) throw mathError('ValueError', 'BVHTree.FromObject(): the object no longer exists');
    let mesh: FlatMesh | undefined;
    if (deform === false) mesh = raw.type === 'MESH' && raw.data ? app.doc.meshes[raw.data] : undefined;
    else {
      ensureEvaluated();
      mesh = app.graph.get(ob.__id)?.mesh;
    }
    if (!mesh) throw mathError('ValueError', `BVHTree.FromObject(): object '${raw.name}' has no mesh data to be used`);
    return new BVHTree(mesh, epsilon);
  }

  /** Tree over a BMesh's faces (uses face and vertex order as indices). */
  static FromBMesh(bmesh: unknown, epsilon = 0) {
    const bm = bmesh as { verts?: Iterable<unknown> & { index_update?: () => void }; faces?: Iterable<unknown> };
    if (!bm || !bm.verts || !bm.faces) throw mathError('TypeError', 'BVHTree.FromBMesh(): expected a BMesh');
    bm.verts.index_update?.();
    const verts = [...bm.verts] as { co: VecLike; index?: number }[];
    const slot = new Map<unknown, number>();
    const positions = new Float64Array(verts.length * 3);
    verts.forEach((v, i) => {
      slot.set(v, i);
      const a = toArray(v.co);
      positions[i * 3] = a[0];
      positions[i * 3 + 1] = a[1];
      positions[i * 3 + 2] = a[2] ?? 0;
    });
    const offsets = [0];
    const indices: number[] = [];
    for (const f of bm.faces as Iterable<{ verts: Iterable<unknown> }>) {
      for (const v of f.verts) {
        const i = slot.get(v) ?? (v as { index?: number }).index;
        if (i === undefined || i < 0) throw mathError('ValueError', 'BVHTree.FromBMesh(): face uses a vertex that is not in bm.verts');
        indices.push(i);
      }
      offsets.push(indices.length);
    }
    return new BVHTree({ positions, offsets, indices }, epsilon);
  }

  // -------------------------------------------------------------------------
  // queries (raw)

  private rayRaw(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): [number, number] {
    const l = Math.hypot(dx, dy, dz);
    if (l === 0 || !this.tri.length) return [-1, 0];
    dx /= l;
    dy /= l;
    dz /= l;
    const ix = 1 / dx,
      iy = 1 / dy,
      iz = 1 / dz;
    const box = this.nodeBox,
      T = this.tri;
    const eps = this.epsilon;
    const bary = -1e-9 - eps;
    let best = maxDist === undefined || maxDist === null || !(maxDist >= 0) ? Infinity : maxDist;
    let hit = -1;
    const entry = (n: number) => {
      const b = n * 6;
      let t1 = (box[b] - ox) * ix,
        t2 = (box[b + 3] - ox) * ix;
      let tmin = Math.min(t1, t2),
        tmax = Math.max(t1, t2);
      t1 = (box[b + 1] - oy) * iy;
      t2 = (box[b + 4] - oy) * iy;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
      t1 = (box[b + 2] - oz) * iz;
      t2 = (box[b + 5] - oz) * iz;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
      if (Number.isNaN(tmin) || Number.isNaN(tmax)) return slowEntry(b);
      return tmax >= Math.max(tmin, 0) && tmin <= best ? Math.max(tmin, 0) : Infinity;
    };
    // axis-parallel rays starting exactly on a slab plane produce 0 * Infinity; fall back to a containment test
    const slowEntry = (b: number) => {
      const o = [ox, oy, oz],
        d = [dx, dy, dz];
      let tmin = 0,
        tmax = best;
      for (let a = 0; a < 3; a++) {
        if (d[a] === 0) {
          if (o[a] < box[b + a] || o[a] > box[b + 3 + a]) return Infinity;
        } else {
          const t1 = (box[b + a] - o[a]) / d[a],
            t2 = (box[b + 3 + a] - o[a]) / d[a];
          tmin = Math.max(tmin, Math.min(t1, t2));
          tmax = Math.min(tmax, Math.max(t1, t2));
        }
      }
      return tmax >= tmin ? tmin : Infinity;
    };
    let sp = 0;
    if (entry(0) < Infinity) this.stack[sp++] = 0;
    while (sp) {
      const n = this.stack[--sp];
      const cnt = this.nodeCount[n];
      if (cnt > 0) {
        const s = this.nodeStart[n];
        for (let t = s; t < s + cnt; t++) {
          const o9 = t * 9;
          const ax = T[o9],
            ay = T[o9 + 1],
            az = T[o9 + 2];
          const e1x = T[o9 + 3] - ax,
            e1y = T[o9 + 4] - ay,
            e1z = T[o9 + 5] - az;
          const e2x = T[o9 + 6] - ax,
            e2y = T[o9 + 7] - ay,
            e2z = T[o9 + 8] - az;
          const px = dy * e2z - dz * e2y,
            py = dz * e2x - dx * e2z,
            pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-14 && det < 1e-14) continue;
          const inv = 1 / det;
          const sx = ox - ax,
            sy = oy - ay,
            sz = oz - az;
          const u = (sx * px + sy * py + sz * pz) * inv;
          if (u < bary || u > 1 - bary) continue;
          const qx = sy * e1z - sz * e1y,
            qy = sz * e1x - sx * e1z,
            qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < bary || u + v > 1 - bary) continue;
          const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (tt >= 0 && tt < best) {
            best = tt;
            hit = t;
          }
        }
        continue;
      }
      const l = this.nodeLeft[n];
      const ta = entry(l),
        tb = entry(l + 1);
      if (sp + 2 > this.stack.length) this.stack = this.growStack();
      const st = this.stack;
      if (ta <= tb) {
        if (tb < Infinity) st[sp++] = l + 1;
        if (ta < Infinity) st[sp++] = l;
      } else {
        if (ta < Infinity) st[sp++] = l;
        if (tb < Infinity) st[sp++] = l + 1;
      }
    }
    return [hit, best];
  }

  private growStack() {
    const s = new Int32Array(this.stack.length * 2);
    s.set(this.stack);
    return s;
  }

  private boxDist2(n: number, x: number, y: number, z: number) {
    const b = n * 6,
      box = this.nodeBox;
    const dx = x < box[b] ? box[b] - x : x > box[b + 3] ? x - box[b + 3] : 0;
    const dy = y < box[b + 1] ? box[b + 1] - y : y > box[b + 4] ? y - box[b + 4] : 0;
    const dz = z < box[b + 2] ? box[b + 2] - z : z > box[b + 5] ? z - box[b + 5] : 0;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Closest point on triangle t to (x, y, z) into this.scratch; returns the squared distance. */
  private triClosest(t: number, x: number, y: number, z: number) {
    const T = this.tri,
      o = t * 9,
      r = this.scratch;
    const ax = T[o],
      ay = T[o + 1],
      az = T[o + 2];
    const abx = T[o + 3] - ax,
      aby = T[o + 4] - ay,
      abz = T[o + 5] - az;
    const acx = T[o + 6] - ax,
      acy = T[o + 7] - ay,
      acz = T[o + 8] - az;
    const apx = x - ax,
      apy = y - ay,
      apz = z - az;
    const d1 = abx * apx + aby * apy + abz * apz,
      d2 = acx * apx + acy * apy + acz * apz;
    let s = 0,
      w = 0;
    if (d1 <= 0 && d2 <= 0) {
      s = 0;
      w = 0;
    } else {
      const bpx = x - T[o + 3],
        bpy = y - T[o + 4],
        bpz = z - T[o + 5];
      const d3 = abx * bpx + aby * bpy + abz * bpz,
        d4 = acx * bpx + acy * bpy + acz * bpz;
      const cpx = x - T[o + 6],
        cpy = y - T[o + 7],
        cpz = z - T[o + 8];
      const d5 = abx * cpx + aby * cpy + abz * cpz,
        d6 = acx * cpx + acy * cpy + acz * cpz;
      const vc = d1 * d4 - d3 * d2,
        vb = d5 * d2 - d1 * d6,
        va = d3 * d6 - d5 * d4;
      if (d3 >= 0 && d4 <= d3) [s, w] = [1, 0];
      else if (vc <= 0 && d1 >= 0 && d3 <= 0) [s, w] = [d1 / (d1 - d3), 0];
      else if (d6 >= 0 && d5 <= d6) [s, w] = [0, 1];
      else if (vb <= 0 && d2 >= 0 && d6 <= 0) [s, w] = [0, d2 / (d2 - d6)];
      else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const k = (d4 - d3) / (d4 - d3 + (d5 - d6));
        [s, w] = [1 - k, k];
      } else {
        const den = 1 / (va + vb + vc);
        [s, w] = [vb * den, vc * den];
      }
    }
    r[0] = ax + abx * s + acx * w;
    r[1] = ay + aby * s + acy * w;
    r[2] = az + abz * s + acz * w;
    return (r[0] - x) ** 2 + (r[1] - y) ** 2 + (r[2] - z) ** 2;
  }

  private nearestRaw(x: number, y: number, z: number, maxDist: number): [number, number, number, number, number] | null {
    if (!this.tri.length) return null;
    let best = maxDist === undefined || maxDist === null || !(maxDist >= 0) || maxDist === Infinity ? Infinity : maxDist * maxDist;
    let hit = -1,
      hx = 0,
      hy = 0,
      hz = 0;
    let sp = 0;
    if (this.boxDist2(0, x, y, z) <= best) this.stack[sp++] = 0;
    while (sp) {
      const n = this.stack[--sp];
      if (this.boxDist2(n, x, y, z) > best) continue;
      const cnt = this.nodeCount[n];
      if (cnt > 0) {
        const s = this.nodeStart[n];
        for (let t = s; t < s + cnt; t++) {
          const d = this.triClosest(t, x, y, z);
          if (d < best || (hit < 0 && d <= best)) {
            best = d;
            hit = t;
            [hx, hy, hz] = this.scratch;
          }
        }
        continue;
      }
      const l = this.nodeLeft[n];
      const da = this.boxDist2(l, x, y, z),
        db = this.boxDist2(l + 1, x, y, z);
      if (sp + 2 > this.stack.length) this.stack = this.growStack();
      if (da <= db) {
        if (db <= best) this.stack[sp++] = l + 1;
        if (da <= best) this.stack[sp++] = l;
      } else {
        if (da <= best) this.stack[sp++] = l;
        if (db <= best) this.stack[sp++] = l + 1;
      }
    }
    return hit < 0 ? null : [hit, hx, hy, hz, Math.sqrt(best)];
  }

  private rangeRaw(x: number, y: number, z: number, dist: number): [number, number, number, number, number][] {
    const r2 = dist * dist;
    const found: [number, number, number, number, number][] = [];
    if (!this.tri.length || !(dist >= 0)) return found;
    let sp = 0;
    this.stack[sp++] = 0;
    while (sp) {
      const n = this.stack[--sp];
      if (this.boxDist2(n, x, y, z) > r2) continue;
      const cnt = this.nodeCount[n];
      if (cnt > 0) {
        const s = this.nodeStart[n];
        for (let t = s; t < s + cnt; t++) {
          const d = this.triClosest(t, x, y, z);
          if (d <= r2) found.push([t, this.scratch[0], this.scratch[1], this.scratch[2], Math.sqrt(d)]);
        }
        continue;
      }
      if (sp + 2 > this.stack.length) this.stack = this.growStack();
      this.stack[sp++] = this.nodeLeft[n];
      this.stack[sp++] = this.nodeLeft[n] + 1;
    }
    return found.sort((a, b) => a[4] - b[4] || this.triPoly[a[0]] - this.triPoly[b[0]]);
  }

  private normalOf(t: number) {
    const p = this.triPoly[t] * 3;
    return [this.polyN[p], this.polyN[p + 1], this.polyN[p + 2]];
  }

  // -------------------------------------------------------------------------
  // public queries

  /** First hit along a ray: [location, normal, polygon index, distance] or four nulls. */
  ray_cast(origin: VecLike, direction: VecLike, distance = Infinity): Hit | NoHit {
    const o = toArray(origin),
      d = toArray(direction);
    const [t, dist] = this.rayRaw(o[0], o[1], o[2] ?? 0, d[0], d[1], d[2] ?? 0, distance);
    if (t < 0) return [...NO_HIT];
    const l = Math.hypot(d[0], d[1], d[2] ?? 0);
    return [new Vector([o[0] + (d[0] / l) * dist, o[1] + (d[1] / l) * dist, (o[2] ?? 0) + ((d[2] ?? 0) / l) * dist]), new Vector(this.normalOf(t)), this.triPoly[t], dist];
  }

  /** Closest surface point within `distance`: [location, normal, polygon index, distance] or four nulls. */
  find_nearest(origin: VecLike, distance = Infinity): Hit | NoHit {
    const o = toArray(origin);
    const r = this.nearestRaw(o[0], o[1], o[2] ?? 0, distance);
    if (!r) return [...NO_HIT];
    return [new Vector([r[1], r[2], r[3]]), new Vector(this.normalOf(r[0])), this.triPoly[r[0]], r[4]];
  }

  /** Every triangle within `distance`, as [location, normal, polygon index, distance], closest first. */
  find_nearest_range(origin: VecLike, distance = Infinity): Hit[] {
    const o = toArray(origin);
    return this.rangeRaw(o[0], o[1], o[2] ?? 0, distance).map(([t, x, y, z, d]) => [new Vector([x, y, z]), new Vector(this.normalOf(t)), this.triPoly[t], d] as Hit);
  }

  /** Pairs [index in this tree, index in other] of polygons that intersect. */
  overlap(other: BVHTree): [number, number][] {
    if (!(other instanceof BVHTree)) throw mathError('TypeError', 'BVHTree.overlap(): expected a BVHTree');
    const flat = this._overlapFlat(other);
    const out: [number, number][] = [];
    for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out;
  }

  // Flat results for the Python module.
  _rayFlat(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, distance = Infinity): number[] {
    const [t, dist] = this.rayRaw(ox, oy, oz, dx, dy, dz, distance);
    if (t < 0) return [];
    const l = Math.hypot(dx, dy, dz);
    return [ox + (dx / l) * dist, oy + (dy / l) * dist, oz + (dz / l) * dist, ...this.normalOf(t), this.triPoly[t], dist];
  }
  _nearestFlat(x: number, y: number, z: number, distance = Infinity): number[] {
    const r = this.nearestRaw(x, y, z, distance);
    return r ? [r[1], r[2], r[3], ...this.normalOf(r[0]), this.triPoly[r[0]], r[4]] : [];
  }
  _rangeFlat(x: number, y: number, z: number, distance: number): number[] {
    const out: number[] = [];
    for (const [t, px, py, pz, d] of this.rangeRaw(x, y, z, distance)) out.push(px, py, pz, ...this.normalOf(t), this.triPoly[t], d);
    return out;
  }
  _overlapFlat(other: BVHTree): number[] {
    const A = this,
      B = other;
    if (!A.tri.length || !B.tri.length) return [];
    const seen = new Set<number>();
    const pairs: [number, number][] = [];
    const boxesOverlap = (a: number, b: number) => {
      const p = a * 6,
        q = b * 6;
      return A.nodeBox[p] <= B.nodeBox[q + 3] && A.nodeBox[p + 3] >= B.nodeBox[q] && A.nodeBox[p + 1] <= B.nodeBox[q + 4] && A.nodeBox[p + 4] >= B.nodeBox[q + 1] && A.nodeBox[p + 2] <= B.nodeBox[q + 5] && A.nodeBox[p + 5] >= B.nodeBox[q + 2];
    };
    const nb = B.triPoly.length ? Math.max(...B.triPoly) + 1 : 1;
    const work: number[] = [0, 0];
    const eps = Math.max(A.epsilon, B.epsilon);
    while (work.length) {
      const b = work.pop()!,
        a = work.pop()!;
      if (!boxesOverlap(a, b)) continue;
      const la = A.nodeCount[a] > 0,
        lb = B.nodeCount[b] > 0;
      if (la && lb) {
        for (let i = A.nodeStart[a]; i < A.nodeStart[a] + A.nodeCount[a]; i++)
          for (let j = B.nodeStart[b]; j < B.nodeStart[b] + B.nodeCount[b]; j++) {
            const key = A.triPoly[i] * nb + B.triPoly[j];
            if (seen.has(key)) continue;
            if (triTri(A.tri, i * 9, B.tri, j * 9, eps)) {
              seen.add(key);
              pairs.push([A.triPoly[i], B.triPoly[j]]);
            }
          }
      } else if (!la) {
        const l = A.nodeLeft[a];
        work.push(l, b, l + 1, b);
      } else {
        const l = B.nodeLeft[b];
        work.push(a, l, a, l + 1);
      }
    }
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    return pairs.flat();
  }

  toString() {
    return `<BVHTree object (${this.triPoly.length} triangles)>`;
  }
  repr() {
    return this.toString();
  }
}

/** Separating-axis test between two triangles (9 coordinates each); touching counts as overlapping. */
function triTri(A: Float64Array, a: number, B: Float64Array, b: number, eps: number): boolean {
  const pa = [0, 1, 2].map((k) => [A[a + k * 3], A[a + k * 3 + 1], A[a + k * 3 + 2]]);
  const pb = [0, 1, 2].map((k) => [B[b + k * 3], B[b + k * 3 + 1], B[b + k * 3 + 2]]);
  const sub = (p: number[], q: number[]) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const cross = (p: number[], q: number[]) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const ea = [sub(pa[1], pa[0]), sub(pa[2], pa[1]), sub(pa[0], pa[2])];
  const eb = [sub(pb[1], pb[0]), sub(pb[2], pb[1]), sub(pb[0], pb[2])];
  const na = cross(ea[0], ea[1]),
    nb = cross(eb[0], eb[1]);
  const axes: number[][] = [na, nb];
  for (const e of ea) for (const f of eb) axes.push(cross(e, f));
  for (const e of ea) axes.push(cross(na, e));
  for (const e of eb) axes.push(cross(nb, e));
  for (const ax of axes) {
    const l = Math.hypot(ax[0], ax[1], ax[2]);
    if (l < 1e-12) continue;
    let amin = Infinity,
      amax = -Infinity,
      bmin = Infinity,
      bmax = -Infinity;
    for (const p of pa) {
      const s = (p[0] * ax[0] + p[1] * ax[1] + p[2] * ax[2]) / l;
      if (s < amin) amin = s;
      if (s > amax) amax = s;
    }
    for (const p of pb) {
      const s = (p[0] * ax[0] + p[1] * ax[1] + p[2] * ax[2]) / l;
      if (s < bmin) bmin = s;
      if (s > bmax) bmax = s;
    }
    const tol = eps + 1e-9 * (Math.abs(amax) + Math.abs(bmax) + 1);
    if (amax < bmin - tol || bmax < amin - tol) return false;
  }
  return true;
}

export const bvhtree = { BVHTree };
