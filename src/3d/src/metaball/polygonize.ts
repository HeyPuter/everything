// Metaball polygonization: every element contributes a smooth polynomial field
//   f(d) = stiffness * (1 - d²/r²)³   for d < r (0 outside),
// where d is the distance from the sample point to the element's core shape (a point, a
// segment, a rectangle, a box, or a point in axis-scaled space). Negative elements subtract.
// The surface is the set where the summed field equals the threshold; it is extracted with a
// marching-cubes pass over a grid aligned to multiples of the cell size. The per-cube
// triangulation table is derived at start-up from a face rule (on an ambiguous cube face the
// inside corners are kept apart), which every pair of neighbouring cubes applies identically,
// so the output is closed and edge-manifold.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { MeshBuilder } from '../eval/meshbuild';
import type { EvalMesh } from '../eval/types';
import type { MetaElement, MetaElementType } from './types';

export interface FieldElement {
  type: MetaElementType;
  radius: number;
  stiffness: number;
  sx: number;
  sy: number;
  sz: number;
  negative: boolean;
  /** affine map (row-major 3x4) from polygonization space into the element's local frame */
  inv: Float64Array;
  /** influence bounds in polygonization space */
  min: [number, number, number];
  max: [number, number, number];
}

/** Squared distance from a local-frame point to the element's core shape. */
export function coreDistance2(type: MetaElementType, x: number, y: number, z: number, sx: number, sy: number, sz: number): number {
  switch (type) {
    case 'CAPSULE': {
      const ax = Math.max(Math.abs(x) - sx, 0);
      return ax * ax + y * y + z * z;
    }
    case 'PLANE': {
      const ax = Math.max(Math.abs(x) - sx, 0),
        ay = Math.max(Math.abs(y) - sy, 0);
      return ax * ax + ay * ay + z * z;
    }
    case 'CUBE': {
      const ax = Math.max(Math.abs(x) - sx, 0),
        ay = Math.max(Math.abs(y) - sy, 0),
        az = Math.max(Math.abs(z) - sz, 0);
      return ax * ax + ay * ay + az * az;
    }
    case 'ELLIPSOID': {
      const ax = x / (sx || 1e-6),
        ay = y / (sy || 1e-6),
        az = z / (sz || 1e-6);
      return ax * ax + ay * ay + az * az;
    }
    default:
      return x * x + y * y + z * z;
  }
}

/** Field contribution of one element at squared core distance `d2` (always >= 0). */
export function falloff(d2: number, radius: number, stiffness: number): number {
  const r2 = radius * radius;
  if (d2 >= r2 || r2 <= 0) return 0;
  const t = 1 - d2 / r2;
  return stiffness * t * t * t;
}

/** Local-frame half extents of an element's influence. */
function localExtent(e: MetaElement): [number, number, number] {
  const r = e.radius;
  switch (e.type) {
    case 'CAPSULE':
      return [e.size_x + r, r, r];
    case 'PLANE':
      return [e.size_x + r, e.size_y + r, r];
    case 'CUBE':
      return [e.size_x + r, e.size_y + r, e.size_z + r];
    case 'ELLIPSOID':
      return [r * e.size_x, r * e.size_y, r * e.size_z];
    default:
      return [r, r, r];
  }
}

/** Matrix of an element's local frame inside its owner's space. */
export function elementMatrix(e: MetaElement): Matrix4 {
  const q = new Quaternion(e.rotation[1], e.rotation[2], e.rotation[3], e.rotation[0]);
  if (q.lengthSq() < 1e-12) q.identity();
  else q.normalize();
  return new Matrix4().compose(new Vector3(e.co[0], e.co[1], e.co[2]), q, new Vector3(1, 1, 1));
}

/**
 * Prepare elements for sampling. `toSpace` maps the owner's object space into the
 * polygonization space (identity for the basis itself). Hidden elements still contribute.
 */
export function fieldElements(elements: MetaElement[], toSpace: Matrix4 = new Matrix4()): FieldElement[] {
  const out: FieldElement[] = [];
  const corner = new Vector3();
  for (const e of elements) {
    if (!(e.radius > 0) || !(e.stiffness > 0)) continue;
    const m = toSpace.clone().multiply(elementMatrix(e));
    if (Math.abs(m.determinant()) < 1e-12) continue;
    const iv = m.clone().invert().elements; // column-major
    const inv = new Float64Array([iv[0], iv[4], iv[8], iv[12], iv[1], iv[5], iv[9], iv[13], iv[2], iv[6], iv[10], iv[14]]);
    const [ex, ey, ez] = localExtent(e);
    const min: [number, number, number] = [Infinity, Infinity, Infinity],
      max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      corner.set(c & 1 ? ex : -ex, c & 2 ? ey : -ey, c & 4 ? ez : -ez).applyMatrix4(m);
      for (let k = 0; k < 3; k++) {
        const v = corner.getComponent(k);
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    out.push({ type: e.type, radius: e.radius, stiffness: e.stiffness, sx: e.size_x, sy: e.size_y, sz: e.size_z, negative: !!e.use_negative, inv, min, max });
  }
  return out;
}

/** Summed field at a point (used for tests and normals). */
export function fieldAt(els: FieldElement[], x: number, y: number, z: number): number {
  let f = 0;
  for (const e of els) {
    const i = e.inv;
    const lx = i[0] * x + i[1] * y + i[2] * z + i[3],
      ly = i[4] * x + i[5] * y + i[6] * z + i[7],
      lz = i[8] * x + i[9] * y + i[10] * z + i[11];
    const v = falloff(coreDistance2(e.type, lx, ly, lz, e.sx, e.sy, e.sz), e.radius, e.stiffness);
    f += e.negative ? -v : v;
  }
  return f;
}

// ---------------------------------------------------------------------------
// cube configuration table

// corner c has offset (c & 1, c >> 1 & 1, c >> 2 & 1)
const EDGES: [number, number][] = [];
for (let a = 0; a < 8; a++)
  for (let k = 0; k < 3; k++) {
    const b = a | (1 << k);
    if (b !== a) EDGES.push([a, b]);
  }
const edgeId = (a: number, b: number) => EDGES.findIndex(([p, q]) => (p === a && q === b) || (p === b && q === a));
const cornerPos = (c: number) => [c & 1, (c >> 1) & 1, (c >> 2) & 1];

/** Face corner cycles (each face of the cube, corners in cyclic order). */
const FACES: number[][] = [];
for (let k = 0; k < 3; k++)
  for (let side = 0; side < 2; side++) {
    const u = (k + 1) % 3,
      w = (k + 2) % 3;
    const at = (a: number, b: number) => (side << k) | (a << u) | (b << w);
    FACES.push([at(0, 0), at(1, 0), at(1, 1), at(0, 1)]);
  }

function buildTable(): number[][][] {
  const table: number[][][] = [];
  for (let cfg = 0; cfg < 256; cfg++) {
    const inside = (c: number) => ((cfg >> c) & 1) === 1;
    const adj = new Map<number, number[]>();
    const link = (a: number, b: number) => {
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
    };
    for (const cyc of FACES) {
      const crossing: number[] = []; // positions i where edge (cyc[i], cyc[i+1]) crosses
      for (let i = 0; i < 4; i++) if (inside(cyc[i]) !== inside(cyc[(i + 1) % 4])) crossing.push(i);
      const e = (i: number) => edgeId(cyc[i], cyc[(i + 1) % 4]);
      if (crossing.length === 2) link(e(crossing[0]), e(crossing[1]));
      else if (crossing.length === 4) {
        // keep inside corners apart: cut each inside corner off on its own
        for (let i = 0; i < 4; i++) if (inside(cyc[i])) link(e((i + 3) % 4), e(i));
      }
    }
    const loops: number[][] = [];
    const used = new Set<number>();
    for (const start of adj.keys()) {
      if (used.has(start)) continue;
      const loop = [start];
      used.add(start);
      let prev = -1,
        cur = start;
      for (;;) {
        const nb = adj.get(cur)!;
        const next = nb[0] !== prev ? nb[0] : nb[1];
        if (next === start || next === undefined) break;
        if (used.has(next)) break;
        loop.push(next);
        used.add(next);
        prev = cur;
        cur = next;
      }
      // orient so the polygon normal points from inside to outside
      const mid = (id: number) => {
        const [a, b] = EDGES[id];
        const pa = cornerPos(a),
          pb = cornerPos(b);
        return [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      };
      const n = [0, 0, 0],
        out = [0, 0, 0];
      for (let i = 0; i < loop.length; i++) {
        const p = mid(loop[i]),
          q = mid(loop[(i + 1) % loop.length]);
        n[0] += (p[1] - q[1]) * (p[2] + q[2]);
        n[1] += (p[2] - q[2]) * (p[0] + q[0]);
        n[2] += (p[0] - q[0]) * (p[1] + q[1]);
        const [a, b] = EDGES[loop[i]];
        const [ins, outs] = inside(a) ? [a, b] : [b, a];
        const pi = cornerPos(ins),
          po = cornerPos(outs);
        for (let k = 0; k < 3; k++) out[k] += po[k] - pi[k];
      }
      if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) loop.reverse();
      loops.push(loop);
    }
    table.push(loops);
  }
  return table;
}

let TABLE: number[][][] | null = null;
export function cubeTable() {
  return (TABLE ??= buildTable());
}

// ---------------------------------------------------------------------------
// polygonization

/** Upper bound on grid samples; coarser cells are used beyond it to keep editing responsive. */
export const MAX_SAMPLES = 2_500_000;

export interface PolygonizeResult {
  mesh: EvalMesh;
  /** the cell size actually used */
  cell: number;
}

export function polygonize(els: FieldElement[], threshold: number, cellSize: number): PolygonizeResult {
  const empty = new MeshBuilder().build();
  const pos = els.filter((e) => !e.negative);
  if (!pos.length || !(threshold > 0)) return { mesh: empty, cell: cellSize };
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (const e of pos)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], e.min[k]);
      hi[k] = Math.max(hi[k], e.max[k]);
    }
  let cell = Math.max(cellSize, 1e-4);
  const dims = (c: number) => [0, 1, 2].map((k) => Math.ceil(hi[k] / c) - Math.floor(lo[k] / c) + 3);
  let d = dims(cell);
  while (d[0] * d[1] * d[2] > MAX_SAMPLES) {
    cell *= 1.25;
    d = dims(cell);
  }
  const [nx, ny, nz] = d;
  const o = [0, 1, 2].map((k) => (Math.floor(lo[k] / cell) - 1) * cell);
  const field = new Float32Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number) => (k * ny + j) * nx + i;

  // splat each element over its own bounds
  for (const e of els) {
    const r = [0, 1, 2].map((k) => [Math.max(0, Math.floor((e.min[k] - o[k]) / cell)), Math.min(d[k] - 1, Math.ceil((e.max[k] - o[k]) / cell))]);
    if (r.some(([a, b]) => a > b)) continue;
    const m = e.inv,
      r2 = e.radius * e.radius;
    for (let k = r[2][0]; k <= r[2][1]; k++) {
      const z = o[2] + k * cell;
      for (let j = r[1][0]; j <= r[1][1]; j++) {
        const y = o[1] + j * cell;
        const bx = m[1] * y + m[2] * z + m[3],
          by = m[5] * y + m[6] * z + m[7],
          bz = m[9] * y + m[10] * z + m[11];
        let p = idx(r[0][0], j, k);
        for (let i = r[0][0]; i <= r[0][1]; i++, p++) {
          const x = o[0] + i * cell;
          const d2 = coreDistance2(e.type, m[0] * x + bx, m[4] * x + by, m[8] * x + bz, e.sx, e.sy, e.sz);
          if (d2 >= r2) continue;
          const t = 1 - d2 / r2;
          const v = e.stiffness * t * t * t;
          field[p] += e.negative ? -v : v;
        }
      }
    }
  }

  // marching cubes with shared edge vertices
  const table = cubeTable();
  const N = nx * ny * nz;
  const vx = new Int32Array(N).fill(-1),
    vy = new Int32Array(N).fill(-1),
    vz = new Int32Array(N).fill(-1);
  const vertCache = [vx, vy, vz];
  const b = new MeshBuilder();
  const edgeVert = new Int32Array(12);
  const vertexOn = (edge: number, i: number, j: number, k: number): number => {
    const [a, c] = EDGES[edge];
    const axis = Math.log2(a ^ c) | 0;
    const ca = cornerPos(a);
    const gi = i + ca[0],
      gj = j + ca[1],
      gk = k + ca[2];
    const p0 = idx(gi, gj, gk);
    const cache = vertCache[axis];
    if (cache[p0] >= 0) return cache[p0];
    const p1 = axis === 0 ? p0 + 1 : axis === 1 ? p0 + nx : p0 + nx * ny;
    const f0 = field[p0],
      f1 = field[p1];
    let t = f1 !== f0 ? (threshold - f0) / (f1 - f0) : 0.5;
    t = Math.min(1, Math.max(0, t));
    const x = o[0] + (gi + (axis === 0 ? t : 0)) * cell,
      y = o[1] + (gj + (axis === 1 ? t : 0)) * cell,
      z = o[2] + (gk + (axis === 2 ? t : 0)) * cell;
    const v = b.addVert(x, y, z);
    cache[p0] = v;
    return v;
  };
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let cfg = 0;
        for (let c = 0; c < 8; c++) {
          const p = idx(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1));
          if (field[p] > threshold) cfg |= 1 << c;
        }
        if (cfg === 0 || cfg === 255) continue;
        edgeVert.fill(-1);
        for (const loop of table[cfg]) {
          const verts = loop.map((e) => (edgeVert[e] >= 0 ? edgeVert[e] : (edgeVert[e] = vertexOn(e, i, j, k))));
          if (verts.length <= 4) b.addFace(verts, undefined, 1);
          else for (let t = 1; t + 1 < verts.length; t++) b.addFace([verts[0], verts[t], verts[t + 1]], undefined, 1);
        }
      }
  return { mesh: b.build(), cell };
}

export { EDGES as CUBE_EDGES };
