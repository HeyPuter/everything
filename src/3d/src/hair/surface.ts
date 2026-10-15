// Surface queries for hair: closest point, ray hits, UV lookups and random sampling on a mesh
// (in the mesh's object space). Built once per evaluated mesh and cached.
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { EvalMesh } from '../eval/types';

export interface SurfaceHit {
  point: Vector3;
  normal: Vector3;
  tri: number;
  /** barycentric weights of the triangle corners */
  bary: [number, number, number];
  uv: [number, number] | null;
}

const cache = new WeakMap<EvalMesh, Surface>();

export class Surface {
  /** vertex indices per triangle */
  tris: Uint32Array;
  /** corner indices per triangle (for UVs) */
  corners: Uint32Array;
  /** face of each triangle */
  triFace: Uint32Array;
  vnormals: Float32Array;
  bvh: MeshBVH | null;
  private cdf: Float64Array | null = null;
  private uvGrid: { n: number; cells: number[][] } | null = null;

  static of(mesh: EvalMesh): Surface {
    let s = cache.get(mesh);
    if (!s) cache.set(mesh, (s = new Surface(mesh)));
    return s;
  }

  constructor(public mesh: EvalMesh) {
    const tris: number[] = [],
      corners: number[] = [],
      faces: number[] = [];
    const { offsets, indices } = mesh;
    for (let f = 0; f + 1 < offsets.length; f++) {
      const a = offsets[f],
        n = offsets[f + 1] - a;
      for (let k = 1; k + 1 < n; k++) {
        tris.push(indices[a], indices[a + k], indices[a + k + 1]);
        corners.push(a, a + k, a + k + 1);
        faces.push(f);
      }
    }
    this.tris = Uint32Array.from(tris);
    this.corners = Uint32Array.from(corners);
    this.triFace = Uint32Array.from(faces);
    this.vnormals = smoothNormals(mesh.positions, this.tris);
    if (this.tris.length) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
      g.setIndex(new BufferAttribute(this.tris.slice(), 1));
      this.bvh = new MeshBVH(g);
    } else this.bvh = null;
  }

  get triCount() {
    return this.tris.length / 3;
  }

  get hasUV() {
    return this.mesh.uvs.length >= this.mesh.indices.length * 2 && this.mesh.indices.length > 0;
  }

  /** Closest point on the surface. */
  closest(p: Vector3): SurfaceHit | null {
    if (!this.bvh) return null;
    const r = this.bvh.closestPointToPoint(p);
    if (!r) return null;
    return this.hitAt(r.faceIndex, r.point);
  }

  /** First hit of a ray (both triangle sides). */
  raycast(origin: Vector3, dir: Vector3): SurfaceHit | null {
    if (!this.bvh) return null;
    const h = this.bvh.raycastFirst(new Ray(origin, dir.clone().normalize()), DoubleSide);
    if (!h || h.faceIndex === undefined || h.faceIndex === null) return null;
    return this.hitAt(h.faceIndex, h.point);
  }

  /** Full hit record for a point on triangle `t`. */
  hitAt(t: number, point: Vector3): SurfaceHit {
    const bary = this.barycentric(t, point);
    return { point: point.clone(), normal: this.normalAt(t, bary), tri: t, bary, uv: this.uvAt(t, bary) };
  }

  barycentric(t: number, p: Vector3): [number, number, number] {
    const P = this.mesh.positions;
    const a = this.tris[t * 3] * 3,
      b = this.tris[t * 3 + 1] * 3,
      c = this.tris[t * 3 + 2] * 3;
    const v0x = P[b] - P[a],
      v0y = P[b + 1] - P[a + 1],
      v0z = P[b + 2] - P[a + 2];
    const v1x = P[c] - P[a],
      v1y = P[c + 1] - P[a + 1],
      v1z = P[c + 2] - P[a + 2];
    const v2x = p.x - P[a],
      v2y = p.y - P[a + 1],
      v2z = p.z - P[a + 2];
    const d00 = v0x * v0x + v0y * v0y + v0z * v0z,
      d01 = v0x * v1x + v0y * v1y + v0z * v1z,
      d11 = v1x * v1x + v1y * v1y + v1z * v1z,
      d20 = v2x * v0x + v2y * v0y + v2z * v0z,
      d21 = v2x * v1x + v2y * v1y + v2z * v1z;
    const den = d00 * d11 - d01 * d01 || 1;
    const v = (d11 * d20 - d01 * d21) / den,
      w = (d00 * d21 - d01 * d20) / den;
    return [1 - v - w, v, w];
  }

  /** Shading normal: interpolated on smooth faces, the face normal on flat ones. */
  normalAt(t: number, bary: [number, number, number]): Vector3 {
    if (!this.mesh.smooth?.[this.triFace[t]]) return this.faceNormal(t);
    const N = this.vnormals;
    const n = new Vector3();
    for (let k = 0; k < 3; k++) {
      const i = this.tris[t * 3 + k] * 3;
      n.x += N[i] * bary[k];
      n.y += N[i + 1] * bary[k];
      n.z += N[i + 2] * bary[k];
    }
    if (n.lengthSq() < 1e-20) return this.faceNormal(t);
    return n.normalize();
  }

  faceNormal(t: number): Vector3 {
    const P = this.mesh.positions;
    const a = this.tris[t * 3] * 3,
      b = this.tris[t * 3 + 1] * 3,
      c = this.tris[t * 3 + 2] * 3;
    const e1 = new Vector3(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
    const e2 = new Vector3(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]);
    return e1.cross(e2).normalize();
  }

  uvAt(t: number, bary: [number, number, number]): [number, number] | null {
    if (!this.hasUV) return null;
    const U = this.mesh.uvs;
    let u = 0,
      v = 0;
    for (let k = 0; k < 3; k++) {
      const c = this.corners[t * 3 + k] * 2;
      u += U[c] * bary[k];
      v += U[c + 1] * bary[k];
    }
    return [u, v];
  }

  pointAt(t: number, bary: [number, number, number]): Vector3 {
    const P = this.mesh.positions;
    const out = new Vector3();
    for (let k = 0; k < 3; k++) {
      const i = this.tris[t * 3 + k] * 3;
      out.x += P[i] * bary[k];
      out.y += P[i + 1] * bary[k];
      out.z += P[i + 2] * bary[k];
    }
    return out;
  }

  /** The surface point with UV coordinate `uv` (null when no triangle covers it). */
  lookupUV(uv: [number, number]): SurfaceHit | null {
    if (!this.hasUV) return null;
    const grid = this.uvIndex();
    const n = grid.n;
    const gx = Math.min(n - 1, Math.max(0, Math.floor(uv[0] * n))),
      gy = Math.min(n - 1, Math.max(0, Math.floor(uv[1] * n)));
    const U = this.mesh.uvs;
    for (const t of grid.cells[gy * n + gx] ?? []) {
      const c0 = this.corners[t * 3] * 2,
        c1 = this.corners[t * 3 + 1] * 2,
        c2 = this.corners[t * 3 + 2] * 2;
      const b = bary2(uv[0], uv[1], U[c0], U[c0 + 1], U[c1], U[c1 + 1], U[c2], U[c2 + 1]);
      if (!b || b[0] < -1e-5 || b[1] < -1e-5 || b[2] < -1e-5) continue;
      const p = this.pointAt(t, b);
      return { point: p, normal: this.normalAt(t, b), tri: t, bary: b, uv: [uv[0], uv[1]] };
    }
    return null;
  }

  private uvIndex() {
    if (this.uvGrid) return this.uvGrid;
    const nt = this.triCount;
    const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(nt / 2))));
    const cells: number[][] = new Array(n * n);
    const U = this.mesh.uvs;
    for (let t = 0; t < nt; t++) {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const c = this.corners[t * 3 + k] * 2;
        x0 = Math.min(x0, U[c]);
        x1 = Math.max(x1, U[c]);
        y0 = Math.min(y0, U[c + 1]);
        y1 = Math.max(y1, U[c + 1]);
      }
      const ax = Math.max(0, Math.floor(x0 * n)),
        bx = Math.min(n - 1, Math.floor(x1 * n)),
        ay = Math.max(0, Math.floor(y0 * n)),
        by = Math.min(n - 1, Math.floor(y1 * n));
      for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) (cells[y * n + x] ??= []).push(t);
    }
    return (this.uvGrid = { n, cells });
  }

  /** Area-weighted random point (deterministic for a random source). */
  randomPoint(rand: () => number): SurfaceHit | null {
    const nt = this.triCount;
    if (!nt) return null;
    if (!this.cdf) {
      this.cdf = new Float64Array(nt);
      let acc = 0;
      for (let t = 0; t < nt; t++) {
        acc += this.triArea(t);
        this.cdf[t] = acc;
      }
    }
    const total = this.cdf[nt - 1];
    if (!(total > 0)) return null;
    const x = rand() * total;
    let lo = 0,
      hi = nt - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cdf[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    let u = rand(),
      v = rand();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const b: [number, number, number] = [1 - u - v, u, v];
    return { point: this.pointAt(lo, b), normal: this.normalAt(lo, b), tri: lo, bary: b, uv: this.uvAt(lo, b) };
  }

  triArea(t: number): number {
    const P = this.mesh.positions;
    const a = this.tris[t * 3] * 3,
      b = this.tris[t * 3 + 1] * 3,
      c = this.tris[t * 3 + 2] * 3;
    const e1x = P[b] - P[a],
      e1y = P[b + 1] - P[a + 1],
      e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a],
      e2y = P[c + 1] - P[a + 1],
      e2z = P[c + 2] - P[a + 2];
    return 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
  }

  get area() {
    let s = 0;
    for (let t = 0; t < this.triCount; t++) s += this.triArea(t);
    return s;
  }
}

function bary2(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): [number, number, number] | null {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-14) return null;
  const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  return [l1, l2, 1 - l1 - l2];
}

function smoothNormals(P: Float32Array, tris: Uint32Array): Float32Array {
  const N = new Float32Array(P.length);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3,
      b = tris[t + 1] * 3,
      c = tris[t + 2] * 3;
    const e1x = P[b] - P[a],
      e1y = P[b + 1] - P[a + 1],
      e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a],
      e2y = P[c + 1] - P[a + 1],
      e2z = P[c + 2] - P[a + 2];
    // area-weighted face normal
    const nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    for (const i of [a, b, c]) {
      N[i] += nx;
      N[i + 1] += ny;
      N[i + 2] += nz;
    }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
    N[i] /= l;
    N[i + 1] /= l;
    N[i + 2] /= l;
  }
  return N;
}
