// Spatial queries over evaluated meshes: nearest surface point (BVH), nearest vertex and nearest
// edge (uniform grids), and ray casts. Used by modifiers that relate geometry to other geometry.
import { BufferAttribute, BufferGeometry, Matrix4, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { EvalMesh } from '../types';
import { edgeTopology, triangulatePoly } from '../../mesh/mesh';

export interface SurfaceHit {
  point: Vector3;
  distance: number;
  /** polygon index in the source mesh */
  face: number;
  /** triangle vertex ids, face corners and barycentric weights of the hit point */
  tri: [number, number, number];
  corners: [number, number, number];
  bary: [number, number, number];
}

/** Triangulation of an evaluated mesh: three vertex ids per triangle and the polygon of each. */
export function triangles(m: EvalMesh): { tris: Uint32Array; triFace: Uint32Array; triCorners: Uint32Array } {
  const out: number[] = [],
    faceOf: number[] = [],
    corners: number[] = [];
  const tmp: number[] = [];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    tmp.length = 0;
    const verts = m.indices.subarray(s, e);
    triangulatePoly(m.positions, verts, tmp, 0);
    for (let i = 0; i < tmp.length; i += 3) {
      out.push(verts[tmp[i]], verts[tmp[i + 1]], verts[tmp[i + 2]]);
      corners.push(s + tmp[i], s + tmp[i + 1], s + tmp[i + 2]);
      faceOf.push(f);
    }
  }
  return { tris: Uint32Array.from(out), triFace: Uint32Array.from(faceOf), triCorners: Uint32Array.from(corners) };
}

/** Barycentric weights of p (assumed on/near the triangle plane) in triangle abc. */
export function barycentric(p: Vector3, a: Vector3, b: Vector3, c: Vector3, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const v0x = b.x - a.x,
    v0y = b.y - a.y,
    v0z = b.z - a.z;
  const v1x = c.x - a.x,
    v1y = c.y - a.y,
    v1z = c.z - a.z;
  const v2x = p.x - a.x,
    v2y = p.y - a.y,
    v2z = p.z - a.z;
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z,
    d01 = v0x * v1x + v0y * v1y + v0z * v1z,
    d11 = v1x * v1x + v1y * v1y + v1z * v1z,
    d20 = v2x * v0x + v2y * v0y + v2z * v0z,
    d21 = v2x * v1x + v2y * v1y + v2z * v1z;
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-20) {
    out[0] = 1;
    out[1] = out[2] = 0;
    return out;
  }
  const v = (d11 * d20 - d01 * d21) / den,
    w = (d00 * d21 - d01 * d20) / den;
  out[0] = 1 - v - w;
  out[1] = v;
  out[2] = w;
  return out;
}

/** Nearest-surface and ray queries against a mesh, optionally placed by a matrix. */
export class SurfaceQuery {
  readonly positions: Float32Array;
  readonly tris: Uint32Array;
  readonly triFace: Uint32Array;
  readonly triCorners: Uint32Array;
  private bvh: MeshBVH | null = null;
  private a = new Vector3();
  private b = new Vector3();
  private c = new Vector3();

  constructor(m: EvalMesh, matrix?: Matrix4 | null) {
    let P = m.positions;
    if (matrix) {
      P = new Float32Array(P.length);
      const v = new Vector3();
      for (let i = 0; i < P.length; i += 3) {
        v.fromArray(m.positions, i).applyMatrix4(matrix);
        P[i] = v.x;
        P[i + 1] = v.y;
        P[i + 2] = v.z;
      }
    }
    this.positions = P;
    const t = triangles(m);
    this.tris = t.tris;
    this.triFace = t.triFace;
    this.triCorners = t.triCorners;
    if (this.tris.length) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(P, 3));
      g.setIndex(new BufferAttribute(new Uint32Array(this.tris), 1));
      this.bvh = new MeshBVH(g, { indirect: true });
    }
  }

  get empty() {
    return !this.bvh;
  }

  private fill(point: Vector3, distance: number, t: number): SurfaceHit {
    const ia = this.tris[t * 3],
      ib = this.tris[t * 3 + 1],
      ic = this.tris[t * 3 + 2];
    this.a.fromArray(this.positions, ia * 3);
    this.b.fromArray(this.positions, ib * 3);
    this.c.fromArray(this.positions, ic * 3);
    const C = this.triCorners;
    return { point: point.clone(), distance, face: this.triFace[t], tri: [ia, ib, ic], corners: [C[t * 3], C[t * 3 + 1], C[t * 3 + 2]], bary: barycentric(point, this.a, this.b, this.c) };
  }

  nearest(p: Vector3, maxDistance = Infinity): SurfaceHit | null {
    if (!this.bvh) return null;
    const hit = this.bvh.closestPointToPoint(p, undefined, 0, maxDistance);
    if (!hit) return null;
    return this.fill(hit.point, hit.distance, hit.faceIndex);
  }

  raycast(origin: Vector3, dir: Vector3, maxDistance = Infinity, bothSides = true): SurfaceHit | null {
    if (!this.bvh) return null;
    const ray = new Ray(origin.clone(), dir.clone().normalize());
    const hit = this.bvh.raycastFirst(ray, bothSides ? 2 : 0, 0, maxDistance);
    if (!hit || hit.faceIndex == null) return null;
    return this.fill(hit.point, hit.distance, hit.faceIndex);
  }
}

/** Uniform grid of primitives (points or segments) with nearest queries. */
class PrimGrid {
  private cells = new Map<number, number[]>();
  private cell: number;
  private origin: [number, number, number];
  private dims: [number, number, number];

  constructor(
    count: number,
    bounds: (i: number, out: number[]) => void,
    private dist2: (i: number, p: Vector3) => number,
  ) {
    const bb: number[] = [0, 0, 0, 0, 0, 0];
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    let ext = 0;
    for (let i = 0; i < count; i++) {
      bounds(i, bb);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], bb[k]);
        hi[k] = Math.max(hi[k], bb[k + 3]);
      }
      ext += Math.max(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]);
    }
    if (!count) lo.fill(0), hi.fill(0);
    const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
    // cells about the size of an average primitive, capped to a sensible grid resolution
    const avg = count ? ext / count : size;
    this.cell = Math.max(avg * 1.5, size / 64, 1e-6);
    this.origin = [lo[0], lo[1], lo[2]];
    this.dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((hi[k] - lo[k]) / this.cell) + 1)) as [number, number, number];
    for (let i = 0; i < count; i++) {
      bounds(i, bb);
      const a = this.coord(bb[0], bb[1], bb[2]),
        b = this.coord(bb[3], bb[4], bb[5]);
      for (let x = a[0]; x <= b[0]; x++)
        for (let y = a[1]; y <= b[1]; y++)
          for (let z = a[2]; z <= b[2]; z++) {
            const key = this.key(x, y, z);
            const list = this.cells.get(key);
            if (list) list.push(i);
            else this.cells.set(key, [i]);
          }
    }
  }

  private coord(x: number, y: number, z: number): [number, number, number] {
    const c = this.cell;
    return [
      Math.max(0, Math.min(this.dims[0] - 1, Math.floor((x - this.origin[0]) / c))),
      Math.max(0, Math.min(this.dims[1] - 1, Math.floor((y - this.origin[1]) / c))),
      Math.max(0, Math.min(this.dims[2] - 1, Math.floor((z - this.origin[2]) / c))),
    ];
  }

  private key(x: number, y: number, z: number) {
    return (x * this.dims[1] + y) * this.dims[2] + z;
  }

  nearest(p: Vector3): { index: number; dist: number } | null {
    if (!this.cells.size) return null;
    const c = this.coord(p.x, p.y, p.z);
    // distance from p to the grid (when outside) so ring expansion starts sensibly
    let best = -1,
      bd = Infinity;
    const maxR = Math.max(...this.dims);
    for (let r = 0; r <= maxR; r++) {
      for (let x = c[0] - r; x <= c[0] + r; x++) {
        if (x < 0 || x >= this.dims[0]) continue;
        for (let y = c[1] - r; y <= c[1] + r; y++) {
          if (y < 0 || y >= this.dims[1]) continue;
          for (let z = c[2] - r; z <= c[2] + r; z++) {
            if (z < 0 || z >= this.dims[2]) continue;
            if (Math.max(Math.abs(x - c[0]), Math.abs(y - c[1]), Math.abs(z - c[2])) !== r) continue;
            const list = this.cells.get(this.key(x, y, z));
            if (!list) continue;
            for (const i of list) {
              const d = this.dist2(i, p);
              if (d < bd) {
                bd = d;
                best = i;
              }
            }
          }
        }
      }
      // every cell at ring r+1 is at least r*cell away from p's cell
      if (best >= 0 && Math.sqrt(bd) <= r * this.cell) break;
    }
    return best >= 0 ? { index: best, dist: Math.sqrt(bd) } : null;
  }
}

/** Nearest vertex of a point set. */
export class PointQuery {
  private grid: PrimGrid;
  constructor(readonly positions: ArrayLike<number>) {
    const P = positions;
    this.grid = new PrimGrid(
      P.length / 3,
      (i, o) => {
        o[0] = o[3] = P[i * 3];
        o[1] = o[4] = P[i * 3 + 1];
        o[2] = o[5] = P[i * 3 + 2];
      },
      (i, p) => (P[i * 3] - p.x) ** 2 + (P[i * 3 + 1] - p.y) ** 2 + (P[i * 3 + 2] - p.z) ** 2,
    );
  }
  nearest(p: Vector3) {
    return this.grid.nearest(p);
  }
}

/** Parameter t of the closest point to p on segment ab and its squared distance. */
export function segmentClosest(P: ArrayLike<number>, a: number, b: number, p: Vector3): { t: number; d2: number } {
  const ax = P[a * 3],
    ay = P[a * 3 + 1],
    az = P[a * 3 + 2];
  const dx = P[b * 3] - ax,
    dy = P[b * 3 + 1] - ay,
    dz = P[b * 3 + 2] - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = len2 > 0 ? ((p.x - ax) * dx + (p.y - ay) * dy + (p.z - az) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const d2 = (ax + dx * t - p.x) ** 2 + (ay + dy * t - p.y) ** 2 + (az + dz * t - p.z) ** 2;
  return { t, d2 };
}

/** Nearest edge of a mesh (face edges and loose edges). */
export class EdgeQuery {
  readonly edges: Uint32Array;
  private grid: PrimGrid;
  constructor(readonly positions: ArrayLike<number>, m: EvalMesh) {
    const et = edgeTopology(m);
    const list = Array.from(et.verts.subarray(0, et.count * 2));
    if (m.looseEdges) list.push(...m.looseEdges);
    this.edges = Uint32Array.from(list);
    const P = positions,
      E = this.edges;
    this.grid = new PrimGrid(
      E.length / 2,
      (i, o) => {
        const a = E[i * 2] * 3,
          b = E[i * 2 + 1] * 3;
        for (let k = 0; k < 3; k++) {
          o[k] = Math.min(P[a + k], P[b + k]);
          o[k + 3] = Math.max(P[a + k], P[b + k]);
        }
      },
      (i, p) => segmentClosest(P, E[i * 2], E[i * 2 + 1], p).d2,
    );
  }
  nearest(p: Vector3): { edge: number; t: number; dist: number } | null {
    const r = this.grid.nearest(p);
    if (!r) return null;
    const { t } = segmentClosest(this.positions, this.edges[r.index * 2], this.edges[r.index * 2 + 1], p);
    return { edge: r.index, t, dist: r.dist };
  }
}

/** Positions of a mesh transformed by a matrix (or the original array when none). */
export function transformedPositions(P: Float32Array, mat: Matrix4 | null): Float32Array {
  if (!mat) return P;
  const out = new Float32Array(P.length);
  const v = new Vector3();
  for (let i = 0; i < P.length; i += 3) {
    v.fromArray(P, i).applyMatrix4(mat);
    out[i] = v.x;
    out[i + 1] = v.y;
    out[i + 2] = v.z;
  }
  return out;
}
