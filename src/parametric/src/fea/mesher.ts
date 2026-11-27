// Volume mesher: 10-node tetrahedra filling the part.
//
// 1. Isosurface stuffing (after Labelle and Shewchuk, 2007): a body-centred
//    cubic lattice is laid over the part; lattice points are classified inside
//    or outside by exact ray crossing counts, lattice edges that cross the
//    boundary are cut where they cross it, lattice points close to a cut are
//    moved onto it ("warped"), and every lattice tetrahedron is clipped to the
//    part with fixed stencils. Quadrilaterals shared by neighbours are split
//    through their lowest numbered corner, so neighbours always agree.
// 2. Feature recovery: the stuffed boundary passes through the part's
//    surface but cuts across its edges and corners. Mesh vertices are moved
//    onto the corners and then onto the edges between faces, so that every
//    boundary triangle lies on one B-rep face (faces carrying loads and
//    fixtures are covered exactly). Moves that would spoil a tetrahedron are
//    refused.
// 3. Interior vertices are smoothed where that improves the worst element
//    around them.
// 4. Quadratic nodes are added at edge midpoints; those on the boundary are
//    put on the curved surface (or on the edge between two faces).
//
// The lattice is uniform: features thinner than about the element size are
// meshed coarsely or missed, which the volume check reports.

import { SurfaceIndex } from './surface';

export interface MeshOptions {
  /** Target element size (lattice spacing), mm. */
  size: number;
  progress?: (stage: string, fraction: number) => void;
  /** Development: logs statistics after each stage. */
  debug?: (msg: string) => void;
}

export interface TetMesh {
  /** xyz of every node: corner nodes first, then midside nodes. */
  nodes: Float64Array;
  /** Number of corner nodes. */
  corners: number;
  /** 10 nodes per element: corners 0-3, then midside nodes of edges 01, 12, 20, 03, 13, 23. */
  tets: Int32Array;
  /** 6 nodes per boundary triangle: corners, then midside nodes of edges 01, 12, 20 (outward normal by the right hand rule). */
  tris: Int32Array;
  /** B-rep face of each boundary triangle. */
  triFace: Int32Array;
  stats: MeshStats;
}

export interface MeshStats {
  size: number;
  nodes: number;
  elements: number;
  /** Volume of the mesh and of the boundary it was made from (mm^3). */
  volume: number;
  surfaceVolume: number;
  /** Mean ratio quality (1 regular, 0 flat): worst and average. */
  minQuality: number;
  meanQuality: number;
  /** Smallest and largest dihedral angle of the corner tetrahedra (degrees). */
  minDihedral: number;
  maxDihedral: number;
  /** Elements whose quadratic shape had to be straightened (their surface stays flat). */
  straightened: number;
  /** Boundary triangles whose face could not be told from their corners. */
  unassigned: number;
  /** Separate pieces of mesh. */
  pieces: number;
}

const ALPHA_LONG = 0.24917;
const ALPHA_SHORT = 0.41189;

/** Edges of a 10-node tetrahedron (corner pairs), in midside node order. */
export const TET_EDGES: [number, number][] = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];

export class MeshError extends Error {}

export function tetVolume(P: ArrayLike<number>, a: number, b: number, c: number, d: number): number {
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const bx = P[b * 3] - ax, by = P[b * 3 + 1] - ay, bz = P[b * 3 + 2] - az;
  const cx = P[c * 3] - ax, cy = P[c * 3 + 1] - ay, cz = P[c * 3 + 2] - az;
  const dx = P[d * 3] - ax, dy = P[d * 3 + 1] - ay, dz = P[d * 3 + 2] - az;
  return (bx * (cy * dz - cz * dy) - by * (cx * dz - cz * dx) + bz * (cx * dy - cy * dx)) / 6;
}

/** Mean ratio quality of a tetrahedron: 1 for a regular one, 0 (or negative) for flat (inverted) ones. */
export function tetQuality(P: ArrayLike<number>, a: number, b: number, c: number, d: number): number {
  const v = tetVolume(P, a, b, c, d);
  const l2 = (i: number, j: number) => (P[i * 3] - P[j * 3]) ** 2 + (P[i * 3 + 1] - P[j * 3 + 1]) ** 2 + (P[i * 3 + 2] - P[j * 3 + 2]) ** 2;
  const s = l2(a, b) + l2(a, c) + l2(a, d) + l2(b, c) + l2(b, d) + l2(c, d);
  if (!(s > 0)) return 0;
  return (12 * Math.sign(v) * Math.cbrt(9 * v * v)) / s;
}

function dihedrals(P: ArrayLike<number>, n: number[]): number[] {
  const p = (i: number) => [P[n[i] * 3], P[n[i] * 3 + 1], P[n[i] * 3 + 2]];
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cr = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const out: number[] = [];
  for (const [i, j] of TET_EDGES) {
    const [k, l] = [0, 1, 2, 3].filter((q) => q !== i && q !== j);
    const e = sub(p(j), p(i));
    const n1 = cr(e, sub(p(k), p(i))), n2 = cr(e, sub(p(l), p(i)));
    const c = (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) / (Math.hypot(...n1) * Math.hypot(...n2) || 1);
    out.push((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI);
  }
  return out;
}

/** Default element size for a part: fine enough for its walls, bounded so the problem stays solvable in a browser. */
export function defaultElementSize(volume: number, area: number, diag: number): number {
  // 2V/A is the thickness of a plate (and a third of a cube's side).
  const wall = area > 0 ? (2 * volume) / area : diag / 10;
  const h = Math.min(diag / 25, wall / 1.5);
  // About 48 degrees of freedom per h^3 of a quadratic BCC mesh; keep the default near 150k.
  const floor = Math.cbrt(Math.max(volume, 1e-9) / 3000);
  return Math.max(h, floor, diag / 400);
}

/** Largest element size that still meshes the part's walls (about their thickness). */
export function maxElementSize(volume: number, area: number, diag: number): number {
  const wall = area > 0 ? (2 * volume) / area : diag / 10;
  return Math.max(wall, defaultElementSize(volume, area, diag));
}

/** Estimated degrees of freedom of a mesh of the given element size. */
export function estimateDofs(volume: number, size: number): number {
  return Math.round((48 * volume) / size ** 3);
}

export function meshSolid(surf: SurfaceIndex, opts: MeshOptions): TetMesh {
  const h = opts.size;
  const progress = opts.progress ?? (() => {});
  if (!(h > 0) || !surf.nt) throw new MeshError('The part has no solid to mesh.');
  const ext = [0, 1, 2].map((d) => surf.max[d] - surf.min[d]);
  // Lattice origin a cell and an odd fraction outside the part: no lattice point lands exactly on a flat face.
  const frac = [0.1374, 0.2653, 0.3917];
  const o = [0, 1, 2].map((d) => surf.min[d] - h * (1 + frac[d]));
  const n = [0, 1, 2].map((d) => Math.ceil((ext[d] + 2 * h) / h) + 1);
  const [nx, ny, nz] = n;
  const NB = (nx + 1) * (ny + 1) * (nz + 1);
  const NR = nx * ny * nz;
  const NV = NB + NR;
  if (NV > 60e6) throw new MeshError('The elements are too small for this part. Choose a coarser mesh.');
  const bId = (i: number, j: number, k: number) => i + (nx + 1) * (j + (ny + 1) * k);
  const rId = (i: number, j: number, k: number) => NB + i + nx * (j + ny * k);
  const latticePos = (v: number, out: number[]) => {
    if (v < NB) {
      const i = v % (nx + 1), r = (v - i) / (nx + 1), j = r % (ny + 1), k = (r - j) / (ny + 1);
      out[0] = o[0] + i * h; out[1] = o[1] + j * h; out[2] = o[2] + k * h;
    } else {
      const w = v - NB, i = w % nx, r = (w - i) / nx, j = r % ny, k = (r - j) / ny;
      out[0] = o[0] + (i + 0.5) * h; out[1] = o[1] + (j + 0.5) * h; out[2] = o[2] + (k + 0.5) * h;
    }
    return out;
  };

  // ---- classify lattice points ----
  progress('Classifying lattice points', 0);
  const sign = new Int8Array(NV).fill(-1);
  const scan = (yz: (j: number, k: number) => [number, number], count: number, xAt: (i: number) => number, id: (i: number, j: number, k: number) => number, nj: number, nk: number) => {
    for (let k = 0; k < nk; k++) {
      for (let j = 0; j < nj; j++) {
        const [y, z] = yz(j, k);
        const { x } = surf.xCrossings(y, z);
        if (!x.length) continue;
        // Points before the first crossing are outside; each crossing flips.
        let c = 0;
        for (let i = 0; i < count; i++) {
          const xi = xAt(i);
          while (c < x.length && x[c] <= xi) c++;
          if (c & 1) sign[id(i, j, k)] = 1;
        }
      }
    }
  };
  scan((j, k) => [o[1] + j * h, o[2] + k * h], nx + 1, (i) => o[0] + i * h, bId, ny + 1, nz + 1);
  scan((j, k) => [o[1] + (j + 0.5) * h, o[2] + (k + 0.5) * h], nx, (i) => o[0] + (i + 0.5) * h, rId, ny, nz);

  // ---- neighbours of a lattice point: [vertex, long edge?] ----
  const neighbours = (v: number, out: number[]): number => {
    let m = 0;
    if (v < NB) {
      const i = v % (nx + 1), r = (v - i) / (nx + 1), j = r % (ny + 1), k = (r - j) / (ny + 1);
      if (i > 0) out[m++] = bId(i - 1, j, k);
      if (i < nx) out[m++] = bId(i + 1, j, k);
      if (j > 0) out[m++] = bId(i, j - 1, k);
      if (j < ny) out[m++] = bId(i, j + 1, k);
      if (k > 0) out[m++] = bId(i, j, k - 1);
      if (k < nz) out[m++] = bId(i, j, k + 1);
      const long = m;
      for (let c = 0; c < 8; c++) {
        const a = i - 1 + (c & 1), b = j - 1 + ((c >> 1) & 1), d = k - 1 + ((c >> 2) & 1);
        if (a >= 0 && b >= 0 && d >= 0 && a < nx && b < ny && d < nz) out[m++] = rId(a, b, d);
      }
      return m * 16 + long;
    }
    const w = v - NB, i = w % nx, r = (w - i) / nx, j = r % ny, k = (r - j) / ny;
    if (i > 0) out[m++] = rId(i - 1, j, k);
    if (i < nx - 1) out[m++] = rId(i + 1, j, k);
    if (j > 0) out[m++] = rId(i, j - 1, k);
    if (j < ny - 1) out[m++] = rId(i, j + 1, k);
    if (k > 0) out[m++] = rId(i, j, k - 1);
    if (k < nz - 1) out[m++] = rId(i, j, k + 1);
    const long = m;
    for (let c = 0; c < 8; c++) out[m++] = bId(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1));
    return m * 16 + long;
  };

  // ---- cut points ----
  progress('Cutting the lattice', 0.15);
  const ekey = (a: number, b: number) => (a < b ? a * NV + b : b * NV + a);
  const cutIndex = new Map<number, number>();
  const cutPos: number[] = [];
  const cutTri: number[] = [];
  const nb: number[] = new Array(14);
  const pa = [0, 0, 0], pb = [0, 0, 0];
  for (let v = 0; v < NV; v++) {
    if (sign[v] !== 1) continue;
    const m = neighbours(v, nb) >> 4;
    latticePos(v, pa);
    for (let q = 0; q < m; q++) {
      const w = nb[q];
      if (sign[w] !== -1) continue;
      latticePos(w, pb);
      const hit = surf.segmentHit(pa, pb);
      let p: number[], tri: number;
      if (hit) {
        p = [pa[0] + (pb[0] - pa[0]) * hit.t, pa[1] + (pb[1] - pa[1]) * hit.t, pa[2] + (pb[2] - pa[2]) * hit.t];
        tri = hit.tri;
      } else {
        // A crossing too close to a triangle edge for the segment test: the nearest boundary point to the edge's middle.
        const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
        const c = surf.closest(mid, h * 2);
        if (!c) { p = mid; tri = -1; } else {
          const dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
          const t = Math.max(0.05, Math.min(0.95, ((c.p[0] - pa[0]) * dx + (c.p[1] - pa[1]) * dy + (c.p[2] - pa[2]) * dz) / (dx * dx + dy * dy + dz * dz)));
          p = [pa[0] + dx * t, pa[1] + dy * t, pa[2] + dz * t];
          tri = c.tri;
        }
      }
      cutIndex.set(ekey(v, w), cutTri.length);
      cutPos.push(p[0], p[1], p[2]);
      cutTri.push(tri);
    }
  }

  // ---- warp lattice points onto cuts close to them ----
  progress('Warping', 0.3);
  const warped = new Map<number, { p: number[]; tri: number }>();
  const candidates = new Set<number>();
  for (const k of cutIndex.keys()) { const a = Math.floor(k / NV); candidates.add(a); candidates.add(k - a * NV); }
  for (const v of [...candidates].sort((a, b) => a - b)) {
    const meta = neighbours(v, nb);
    const m = meta >> 4, long = meta & 15;
    latticePos(v, pa);
    let best = -1, bd = Infinity;
    for (let q = 0; q < m; q++) {
      const ci = cutIndex.get(ekey(v, nb[q]));
      if (ci === undefined) continue;
      latticePos(nb[q], pb);
      const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
      const d = Math.hypot(cutPos[ci * 3] - pa[0], cutPos[ci * 3 + 1] - pa[1], cutPos[ci * 3 + 2] - pa[2]);
      if (d < (q < long ? ALPHA_LONG : ALPHA_SHORT) * L && d < bd) { bd = d; best = ci; }
    }
    if (best < 0) continue;
    warped.set(v, { p: [cutPos[best * 3], cutPos[best * 3 + 1], cutPos[best * 3 + 2]], tri: cutTri[best] });
    sign[v] = 0;
    for (let q = 0; q < m; q++) cutIndex.delete(ekey(v, nb[q]));
  }

  // ---- stuff the lattice tetrahedra ----
  progress('Filling', 0.4);
  // Node references: lattice points (< NV), cut points (NV + cut), Steiner points (NV + cuts + s).
  const NC = cutTri.length;
  const steiner: number[] = [];
  const out: number[] = [];
  let coned = 0;
  const refPos = (r: number, dst: number[], at: number) => {
    if (r < NV) {
      const w = warped.get(r);
      if (w) { dst[at] = w.p[0]; dst[at + 1] = w.p[1]; dst[at + 2] = w.p[2]; return; }
      latticePos(r, pa);
      dst[at] = pa[0]; dst[at + 1] = pa[1]; dst[at + 2] = pa[2];
    } else if (r < NV + NC) {
      const c = r - NV;
      dst[at] = cutPos[c * 3]; dst[at + 1] = cutPos[c * 3 + 1]; dst[at + 2] = cutPos[c * 3 + 2];
    } else {
      const s = r - NV - NC;
      dst[at] = steiner[s * 3]; dst[at + 1] = steiner[s * 3 + 1]; dst[at + 2] = steiner[s * 3 + 2];
    }
  };
  const tmp = new Array(12).fill(0);
  const vol4 = (a: number, b: number, c: number, d: number) => {
    refPos(a, tmp, 0); refPos(b, tmp, 3); refPos(c, tmp, 6); refPos(d, tmp, 9);
    return tetVolume(tmp, 0, 1, 2, 3);
  };
  const cut = (p: number, m: number) => {
    const c = cutIndex.get(ekey(p, m));
    if (c === undefined) throw new MeshError('The mesher lost a boundary crossing.');
    return NV + c;
  };
  /** Emits sub-tetrahedra of one convex piece; they must all have one orientation, else the piece is coned from its centroid. */
  const emit = (tets: number[][], faces: number[][] | null) => {
    const vols = tets.map((t) => vol4(t[0], t[1], t[2], t[3]));
    const scale = Math.max(...vols.map(Math.abs));
    const pos = vols.every((v) => v > 1e-9 * scale), neg = vols.every((v) => v < -1e-9 * scale);
    if (pos || neg || !faces) {
      tets.forEach((t, i) => { if (vols[i] < 0) out.push(t[0], t[2], t[1], t[3]); else if (vols[i] > 0) out.push(t[0], t[1], t[2], t[3]); });
      return;
    }
    // Cone the faces from the centroid of the piece's corners.
    const corners = [...new Set(faces.flat())];
    const c = [0, 0, 0];
    for (const r of corners) { refPos(r, tmp, 0); c[0] += tmp[0]; c[1] += tmp[1]; c[2] += tmp[2]; }
    const s = NV + NC + steiner.length / 3;
    steiner.push(c[0] / corners.length, c[1] / corners.length, c[2] / corners.length);
    const cone = faces.map((f) => [f[0], f[1], f[2], s]);
    const cv = cone.map((t) => vol4(t[0], t[1], t[2], t[3]));
    coned++;
    cone.forEach((t, i) => { if (cv[i] < 0) out.push(t[0], t[2], t[1], t[3]); else if (cv[i] > 0) out.push(t[0], t[1], t[2], t[3]); });
  };
  /** A quadrilateral (cyclic) as two triangles split through its lowest reference. */
  const quad = (q: number[]): number[][] => {
    const m = q.indexOf(Math.min(...q));
    return m % 2 === 0 ? [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] : [[q[1], q[2], q[3]], [q[1], q[3], q[0]]];
  };
  const prism = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    // Rotate and turn over until the lowest reference is a (Dompierre et al. 1999).
    let P = [a, b, c, d, e, f];
    const m = P.indexOf(Math.min(...P));
    if (m >= 3) P = [P[3], P[4], P[5], P[0], P[1], P[2]];
    const r = m % 3;
    P = [P[r], P[(r + 1) % 3], P[(r + 2) % 3], P[3 + r], P[3 + (r + 1) % 3], P[3 + (r + 2) % 3]];
    const [A, B, C, D, E, F] = P;
    const tets = Math.min(B, F) < Math.min(C, E) ? [[A, B, C, F], [A, B, F, E], [A, E, F, D]] : [[A, B, C, E], [A, E, C, F], [A, E, F, D]];
    const faces = [[A, B, C], [D, E, F], ...quad([A, B, E, D]), ...quad([B, C, F, E]), ...quad([C, A, D, F])];
    emit(tets, faces);
  };
  const pyramid = (q: number[], apex: number) => {
    const base = quad(q);
    emit(base.map((t) => [t[0], t[1], t[2], apex]), [...base, [q[0], q[1], apex], [q[1], q[2], apex], [q[2], q[3], apex], [q[3], q[0], apex]]);
  };
  const centroid = [0, 0, 0];
  const stuff = (t: number[]) => {
    const P: number[] = [], Z: number[] = [], M: number[] = [];
    for (const v of t) (sign[v] > 0 ? P : sign[v] < 0 ? M : Z).push(v);
    if (!P.length) {
      if (Z.length !== 4) return;
      // Four boundary points: inside if its middle is.
      centroid[0] = centroid[1] = centroid[2] = 0;
      for (const v of t) { refPos(v, tmp, 0); centroid[0] += tmp[0] / 4; centroid[1] += tmp[1] / 4; centroid[2] += tmp[2] / 4; }
      if (surf.inside(centroid)) emit([t], null);
      return;
    }
    if (!M.length) { emit([t], null); return; }
    if (P.length === 1) {
      const p = P[0];
      if (M.length === 3) emit([[p, cut(p, M[0]), cut(p, M[1]), cut(p, M[2])]], null);
      else if (M.length === 2) emit([[p, Z[0], cut(p, M[0]), cut(p, M[1])]], null);
      else emit([[p, Z[0], Z[1], cut(p, M[0])]], null);
    } else if (P.length === 2) {
      const [p0, p1] = P;
      if (M.length === 2) prism(p0, cut(p0, M[0]), cut(p0, M[1]), p1, cut(p1, M[0]), cut(p1, M[1]));
      else pyramid([p0, p1, cut(p1, M[0]), cut(p0, M[0])], Z[0]);
    } else {
      const m = M[0];
      prism(P[0], P[1], P[2], cut(P[0], m), cut(P[1], m), cut(P[2], m));
    }
  };
  const four = [0, 0, 0, 0];
  const cells = [[0, 0], [-1, 0], [-1, -1], [0, -1]];
  for (let d = 0; d < 3; d++) {
    const d1 = (d + 1) % 3, d2 = (d + 2) % 3;
    const lim = [nx, ny, nz];
    for (let k = 0; k <= nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const idx = [i, j, k];
      if (idx[d] >= lim[d]) continue;
      const b0 = bId(i, j, k);
      const e = [i, j, k]; e[d]++;
      const b1 = bId(e[0], e[1], e[2]);
      const r: number[] = [];
      for (const [a, b] of cells) {
        const c = [i, j, k]; c[d1] += a; c[d2] += b;
        if (c[0] < 0 || c[1] < 0 || c[2] < 0 || c[0] >= nx || c[1] >= ny || c[2] >= nz) break;
        r.push(rId(c[0], c[1], c[2]));
      }
      if (r.length < 4) continue;
      if (sign[b0] < 0 && sign[b1] < 0 && r.every((v) => sign[v] < 0)) continue;
      for (let q = 0; q < 4; q++) {
        four[0] = b0; four[1] = b1; four[2] = r[q]; four[3] = r[(q + 1) % 4];
        stuff(four);
      }
    }
  }
  if (!out.length) throw new MeshError('The mesh is empty: the elements are too large for this part. Choose a finer mesh.');

  // ---- compact the nodes ----
  progress('Recovering edges', 0.55);
  const refMap = new Map<number, number>();
  const tets = new Int32Array(out.length);
  const posList: number[] = [];
  const triOf: number[] = [];
  for (let q = 0; q < out.length; q++) {
    const r = out[q];
    let id = refMap.get(r);
    if (id === undefined) {
      id = triOf.length;
      refMap.set(r, id);
      refPos(r, tmp, 0);
      posList.push(tmp[0], tmp[1], tmp[2]);
      triOf.push(r < NV ? (warped.get(r)?.tri ?? -1) : r < NV + NC ? cutTri[r - NV] : -1);
    }
    tets[q] = id;
  }
  const W = new WorkMesh(posList, Array.from(tets), h);
  const qstat = (label: string) => {
    if (!opts.debug) return;
    let mq = Infinity, bad = 0;
    for (let t = 0; t < W.nt; t++) { const q = W.quality(t); mq = Math.min(mq, q); if (q < 0.2) bad++; }
    opts.debug(`${label}: min quality ${mq.toFixed(3)}, below 0.2: ${bad} of ${W.nt}, coned ${coned}, nodes ${W.nn}`);
  };
  qstat('stuffed');
  {
    const bt = boundaryOf(W.typed());
    for (const v of bt.tris) W.onB[v] = 1;
  }
  // Labels: the faces a boundary vertex is on.
  for (let v = 0; v < W.nn; v++) {
    if (!W.onB[v]) continue;
    if (triOf[v] >= 0) { W.labels[v] = [surf.face[triOf[v]]]; continue; }
    const c = surf.closest(W.pos(v), h);
    W.labels[v] = c ? [surf.face[c.tri]] : [];
  }

  // ---- corners ----
  const bverts: number[] = [];
  for (let v = 0; v < W.nn; v++) if (W.onB[v]) bverts.push(v);
  const vgrid = new PointGrid(W.P, bverts, h);
  for (const c of surf.corners) {
    const cp = surf.vertex(c.v);
    const near = vgrid.near(cp, h * 0.9).filter((v) => !W.locked[v] && W.labels[v].some((f) => c.faces.includes(f)));
    near.sort((a, b) => dist2(W.P, a, cp) - dist2(W.P, b, cp));
    for (const v of near.slice(0, 4)) {
      if (W.move(v, cp, 0.1)) { W.locked[v] = 1; W.labels[v] = [...c.faces]; break; }
    }
  }

  // ---- edges between faces ----
  const disjoint = (a: number[], b: number[]) => !a.some((x) => b.includes(x));
  /** Faces a, b of two vertices' labels that meet along an edge of the part. */
  const seamOf = (u: number, w: number): [number, number] | null => {
    for (const fa of W.labels[u]) for (const fb of W.labels[w]) if (fa >= 0 && fb >= 0 && fa !== fb && surf.adjacent(fa, fb)) return [fa, fb];
    return null;
  };
  for (let pass = 0; pass < 6; pass++) {
    const edges: { u: number; w: number; a: number; b: number; d2: number }[] = [];
    forBoundaryEdges(boundaryOf(W.typed()).tris, (u, w) => {
      if (!disjoint(W.labels[u], W.labels[w])) return;
      const s = seamOf(u, w);
      if (!s) return;
      const m = [(W.P[u * 3] + W.P[w * 3]) / 2, (W.P[u * 3 + 1] + W.P[w * 3 + 1]) / 2, (W.P[u * 3 + 2] + W.P[w * 3 + 2]) / 2];
      const q = surf.closestOnSeam(s[0], s[1], m);
      if (q && q.d2 < h * h) edges.push({ u, w, a: s[0], b: s[1], d2: q.d2 });
    });
    if (!edges.length) break;
    edges.sort((p, q) => p.d2 - q.d2);
    let moved = 0, split = 0, refused = 0;
    for (const e of edges) {
      const { u, w, a, b } = e;
      // Still a crossing edge (an earlier move may have settled it)?
      if (!disjoint(W.labels[u], W.labels[w]) || !W.hasEdge(u, w)) continue;
      // Move the end nearer the seam onto it, else the other end.
      const ends = [u, w].filter((v) => !W.locked[v]).map((v) => ({ v, q: surf.closestOnSeam(a, b, W.pos(v))! })).filter((x) => x.q && x.q.d2 < h * h).sort((p, q) => p.q.d2 - q.q.d2);
      let done = false;
      for (const x of ends) {
        if (W.move(x.v, x.q.p, 0.12)) { W.locked[x.v] = 1; W.labels[x.v] = [a, b]; moved++; done = true; break; }
      }
      if (done) continue;
      // Neither end can go: split the edge and put the new vertex on the seam.
      const m = [(W.P[u * 3] + W.P[w * 3]) / 2, (W.P[u * 3 + 1] + W.P[w * 3 + 1]) / 2, (W.P[u * 3 + 2] + W.P[w * 3 + 2]) / 2];
      const q = surf.closestOnSeam(a, b, m);
      if (!q) continue;
      const x = W.split(u, w);
      W.onB[x] = 1;
      if (W.move(x, q.p, 0.05)) { W.locked[x] = 1; W.labels[x] = [a, b]; split++; continue; }
      // Partly there is still better than across the corner.
      const half = [(m[0] + q.p[0]) / 2, (m[1] + q.p[1]) / 2, (m[2] + q.p[2]) / 2];
      W.move(x, half, 0.05);
      const c = surf.closest(W.pos(x), h, new Set([a, b]));
      W.labels[x] = c ? [surf.face[c.tri]] : [a];
      refused++;
    }
    opts.debug?.(`pass ${pass}: ${edges.length} crossing edges, ${moved} moved, ${split} split, ${refused} left`);
    if (!moved && !split) break;
  }

  qstat('snapped');
  if (opts.debug) {
    let open = 0;
    forBoundaryEdges(boundaryOf(W.typed()).tris, (u, w) => { if (disjoint(W.labels[u], W.labels[w])) open++; });
    opts.debug(`crossing edges left: ${open}`);
  }
  // ---- smooth interior vertices ----
  progress('Improving elements', 0.65);
  W.smooth(4);
  qstat('smoothed');

  // Elements that ended up flat are dropped.
  const ideal = (h ** 3) / 12;
  const lin = W.typed();
  const P = lin.P, nn = lin.nn, labels = W.labels;
  const keep: number[] = [];
  for (let t = 0; t < lin.nt; t++) if (tetVolume(P, lin.tets[t * 4], lin.tets[t * 4 + 1], lin.tets[t * 4 + 2], lin.tets[t * 4 + 3]) > 1e-9 * ideal) keep.push(t);
  let T4 = lin.tets;
  if (keep.length < lin.nt) {
    T4 = new Int32Array(keep.length * 4);
    keep.forEach((t, i) => T4.set(lin.tets.subarray(t * 4, t * 4 + 4), i * 4));
  }
  const bnd = boundaryOf({ P, tets: T4, nn, nt: T4.length / 4 });
  const NT = T4.length / 4;

  // ---- faces of boundary triangles ----
  const B = bnd.tris;
  const nb3 = B.length / 3;
  const triFace = new Int32Array(nb3).fill(-1);
  let unassigned = 0;
  for (let f = 0; f < nb3; f++) {
    const a = B[f * 3], b = B[f * 3 + 1], c = B[f * 3 + 2];
    for (const v of [a, b, c]) if (!labels[v].length) { const q = surf.closest([P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], h * 2); labels[v] = q ? [surf.face[q.tri]] : [-1]; }
    const common = labels[a].filter((x) => x >= 0 && labels[b].includes(x) && labels[c].includes(x));
    if (common.length === 1) { triFace[f] = common[0]; continue; }
    const cen = [(P[a * 3] + P[b * 3] + P[c * 3]) / 3, (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3, (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3];
    const q = surf.closest(cen, h * 2, common.length ? new Set(common) : null) ?? surf.closest(cen, h * 4);
    triFace[f] = q ? surf.face[q.tri] : -1;
    if (!common.length) unassigned++;
  }

  // ---- quadratic nodes ----
  progress('Adding midside nodes', 0.75);
  const edgeMap = new Map<number, number>();
  const mid: number[] = [];
  const T10 = new Int32Array(NT * 10);
  const eKey = (a: number, b: number) => (a < b ? a * nn + b : b * nn + a);
  for (let t = 0; t < NT; t++) {
    for (let k = 0; k < 4; k++) T10[t * 10 + k] = T4[t * 4 + k];
    TET_EDGES.forEach(([i, j], e) => {
      const a = T4[t * 4 + i], b = T4[t * 4 + j];
      const key = eKey(a, b);
      let m = edgeMap.get(key);
      if (m === undefined) {
        m = nn + mid.length / 3;
        edgeMap.set(key, m);
        mid.push((P[a * 3] + P[b * 3]) / 2, (P[a * 3 + 1] + P[b * 3 + 1]) / 2, (P[a * 3 + 2] + P[b * 3 + 2]) / 2);
      }
      T10[t * 10 + 4 + e] = m;
    });
  }
  const N = new Float64Array(P.length + mid.length);
  N.set(P);
  N.set(mid, P.length);
  const straight = new Float64Array(mid);
  // Boundary midside nodes onto the curved surface: the faces of the triangles beside the edge.
  const edgeFaces = new Map<number, number[]>();
  for (let f = 0; f < nb3; f++) {
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
      const key = eKey(B[f * 3 + i], B[f * 3 + j]);
      let l = edgeFaces.get(key);
      if (!l) edgeFaces.set(key, (l = []));
      if (triFace[f] >= 0 && !l.includes(triFace[f])) l.push(triFace[f]);
    }
  }
  const movedMid: number[] = [];
  for (const [key, faces] of edgeFaces) {
    const m = edgeMap.get(key);
    if (m === undefined || !faces.length) continue;
    const a = Math.floor(key / nn), b = key - a * nn;
    const p = [N[m * 3], N[m * 3 + 1], N[m * 3 + 2]];
    const len = Math.sqrt(dist2(N, a, [N[b * 3], N[b * 3 + 1], N[b * 3 + 2]]));
    let q: number[] | null = null;
    // An edge along the seam of two faces stays on the seam (both its ends are on it).
    const seam = faces.length === 2 ? faces : [];
    if (seam.length === 2 && labels[a].includes(seam[0]) && labels[a].includes(seam[1]) && labels[b].includes(seam[0]) && labels[b].includes(seam[1])) {
      const s = surf.closestOnSeam(seam[0], seam[1], p);
      if (s && s.d2 < (len * 0.5) ** 2) q = s.p;
    }
    if (!q && faces.length === 1) {
      const c = surf.closest(p, len * 0.5, new Set(faces));
      if (c) q = c.p;
    }
    if (!q) continue;
    N[m * 3] = q[0]; N[m * 3 + 1] = q[1]; N[m * 3 + 2] = q[2];
    movedMid.push(m);
  }
  // Curved elements must stay valid: straighten those with a non-positive Jacobian anywhere.
  progress('Checking elements', 0.85);
  let straightened = 0;
  for (let pass = 0; pass < 4; pass++) {
    let bad = 0;
    for (let t = 0; t < NT; t++) {
      if (quadraticValid(N, T10, t)) continue;
      bad++;
      for (let k = 4; k < 10; k++) {
        const m = T10[t * 10 + k], s = (m - nn) * 3;
        N[m * 3] = straight[s]; N[m * 3 + 1] = straight[s + 1]; N[m * 3 + 2] = straight[s + 2];
      }
    }
    straightened += bad;
    if (!bad) break;
  }

  // Boundary triangles with their midside nodes.
  const tris = new Int32Array(nb3 * 6);
  for (let f = 0; f < nb3; f++) {
    const a = B[f * 3], b = B[f * 3 + 1], c = B[f * 3 + 2];
    tris.set([a, b, c, edgeMap.get(eKey(a, b))!, edgeMap.get(eKey(b, c))!, edgeMap.get(eKey(c, a))!], f * 6);
  }

  // ---- statistics ----
  progress('Statistics', 0.95);
  let minQ = Infinity, sumQ = 0, minD = 180, maxD = 0;
  for (let t = 0; t < NT; t++) {
    const n4 = [T4[t * 4], T4[t * 4 + 1], T4[t * 4 + 2], T4[t * 4 + 3]];
    const q = tetQuality(P, n4[0], n4[1], n4[2], n4[3]);
    minQ = Math.min(minQ, q); sumQ += q;
    for (const d of dihedrals(P, n4)) { minD = Math.min(minD, d); maxD = Math.max(maxD, d); }
  }
  let volume = 0;
  for (let t = 0; t < NT; t++) volume += quadraticVolume(N, T10, t);
  return {
    nodes: N, corners: nn, tets: T10, tris, triFace,
    stats: {
      size: h, nodes: N.length / 3, elements: NT, volume, surfaceVolume: surf.volume(), minQuality: minQ, meanQuality: sumQ / NT,
      minDihedral: minD, maxDihedral: maxD, straightened, unassigned, pieces: countPieces(T4, nn),
    },
  };
}

// ---------- helpers ----------

function dist2(P: ArrayLike<number>, v: number, p: ArrayLike<number>): number {
  return (P[v * 3] - p[0]) ** 2 + (P[v * 3 + 1] - p[1]) ** 2 + (P[v * 3 + 2] - p[2]) ** 2;
}

interface LinearMesh { P: Float64Array; tets: Int32Array; nn: number; nt: number }

/** Boundary triangles (faces of one tetrahedron only), oriented outward. */
function boundaryOf(m: LinearMesh): { tris: Int32Array } {
  const { tets, nn } = m;
  const nt = tets.length / 4;
  const faces = new Map<number, number[]>();
  // Faces opposite each corner, ordered so their normal points out of a positive tetrahedron.
  const F = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]];
  const out: number[] = [];
  const seen = new Map<string, number>();
  void faces;
  for (let t = 0; t < nt; t++) {
    for (const f of F) {
      const a = tets[t * 4 + f[0]], b = tets[t * 4 + f[1]], c = tets[t * 4 + f[2]];
      const s = [a, b, c].sort((x, y) => x - y);
      const key = `${s[0]},${s[1]},${s[2]}`;
      const prev = seen.get(key);
      if (prev === undefined) seen.set(key, out.length / 3);
      else seen.set(key, -1);
      out.push(a, b, c);
    }
  }
  void nn;
  const tris: number[] = [];
  for (const idx of seen.values()) if (idx >= 0) tris.push(out[idx * 3], out[idx * 3 + 1], out[idx * 3 + 2]);
  return { tris: Int32Array.from(tris) };
}

function forBoundaryEdges(tris: Int32Array, fn: (a: number, b: number) => void) {
  const seen = new Set<string>();
  for (let f = 0; f < tris.length; f += 3) {
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
      const a = tris[f + i], b = tris[f + j];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fn(a, b);
    }
  }
}

export function vertexTets(m: LinearMesh): { start: Int32Array; items: Int32Array } {
  const { tets, nn } = m;
  const nt = tets.length / 4;
  const start = new Int32Array(nn + 1);
  for (let q = 0; q < tets.length; q++) start[tets[q] + 1]++;
  for (let i = 0; i < nn; i++) start[i + 1] += start[i];
  const fill = start.slice();
  const items = new Int32Array(tets.length);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 4; k++) items[fill[tets[t * 4 + k]]++] = t;
  return { start, items };
}

function countPieces(tets: Int32Array, nn: number): number {
  const parent = new Int32Array(nn).map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const used = new Uint8Array(nn);
  for (let t = 0; t < tets.length; t += 4) {
    for (let k = 0; k < 4; k++) used[tets[t + k]] = 1;
    const a = find(tets[t]);
    for (let k = 1; k < 4; k++) { const b = find(tets[t + k]); if (a !== b) parent[b] = a; }
  }
  let n = 0;
  for (let i = 0; i < nn; i++) if (used[i] && find(i) === i) n++;
  return n;
}

/** Derivatives of the 10-node shape functions in volume coordinates (L1, L2, L3; L0 = 1 - L1 - L2 - L3) at a point. */
export function quadDerivs(l1: number, l2: number, l3: number, out: Float64Array) {
  const l0 = 1 - l1 - l2 - l3;
  // dN/dL1, dN/dL2, dN/dL3 for each node (3 per node).
  // Corners: N0 = L0(2L0-1), Ni = Li(2Li-1).
  const d0 = 1 - 4 * l0;
  out.fill(0);
  out[0] = d0; out[1] = d0; out[2] = d0;
  out[3] = 4 * l1 - 1;
  out[7] = 4 * l2 - 1;
  out[11] = 4 * l3 - 1;
  // Edges 01, 12, 20, 03, 13, 23: N = 4 La Lb.
  // 01: 4 L0 L1
  out[12] = 4 * (l0 - l1); out[13] = -4 * l1; out[14] = -4 * l1;
  // 12: 4 L1 L2
  out[15] = 4 * l2; out[16] = 4 * l1; out[17] = 0;
  // 20: 4 L2 L0
  out[18] = -4 * l2; out[19] = 4 * (l0 - l2); out[20] = -4 * l2;
  // 03: 4 L0 L3
  out[21] = -4 * l3; out[22] = -4 * l3; out[23] = 4 * (l0 - l3);
  // 13: 4 L1 L3
  out[24] = 4 * l3; out[25] = 0; out[26] = 4 * l1;
  // 23: 4 L2 L3
  out[27] = 0; out[28] = 4 * l3; out[29] = 4 * l2;
}

/** 4-point Gauss rule on the tetrahedron (degree 2): volume coordinates (L1, L2, L3) and weight (of the unit tetrahedron, volume 1/6). */
const GA = 0.5854101966249685, GB = 0.1381966011250105;
export const GAUSS4: [number, number, number, number][] = [[GB, GB, GB, 1 / 24], [GA, GB, GB, 1 / 24], [GB, GA, GB, 1 / 24], [GB, GB, GA, 1 / 24]];

const dN = new Float64Array(30);

/** Jacobian determinant of element t at volume coordinates (l1, l2, l3). */
export function quadJacobian(N: ArrayLike<number>, T: ArrayLike<number>, t: number, l1: number, l2: number, l3: number): number {
  quadDerivs(l1, l2, l3, dN);
  let j00 = 0, j01 = 0, j02 = 0, j10 = 0, j11 = 0, j12 = 0, j20 = 0, j21 = 0, j22 = 0;
  for (let a = 0; a < 10; a++) {
    const n = T[t * 10 + a] * 3;
    const x = N[n], y = N[n + 1], z = N[n + 2];
    const g0 = dN[a * 3], g1 = dN[a * 3 + 1], g2 = dN[a * 3 + 2];
    j00 += g0 * x; j01 += g0 * y; j02 += g0 * z;
    j10 += g1 * x; j11 += g1 * y; j12 += g1 * z;
    j20 += g2 * x; j21 += g2 * y; j22 += g2 * z;
  }
  return j00 * (j11 * j22 - j12 * j21) - j01 * (j10 * j22 - j12 * j20) + j02 * (j10 * j21 - j11 * j20);
}

const CHECK_POINTS: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0], [0, 0, 0.5], [0.5, 0, 0.5], [0, 0.5, 0.5],
  ...GAUSS4.map(([a, b, c]) => [a, b, c] as [number, number, number]),
];

/** Whether a curved element's Jacobian is positive at its nodes and quadrature points (and not much smaller than its straight value). */
function quadraticValid(N: ArrayLike<number>, T: ArrayLike<number>, t: number): boolean {
  const lin = 6 * tetVolume(N, T[t * 10], T[t * 10 + 1], T[t * 10 + 2], T[t * 10 + 3]);
  for (const [a, b, c] of CHECK_POINTS) if (!(quadJacobian(N, T, t, a, b, c) > 0.1 * lin)) return false;
  return true;
}

export function quadraticVolume(N: ArrayLike<number>, T: ArrayLike<number>, t: number): number {
  let v = 0;
  for (const [a, b, c, w] of GAUSS4) v += quadJacobian(N, T, t, a, b, c) * w;
  return v;
}

/** Points near a point, by bins. */
class PointGrid {
  private bins = new Map<string, number[]>();
  constructor(private P: ArrayLike<number>, ids: number[], private c: number) {
    for (const v of ids) {
      const k = this.key(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      let l = this.bins.get(k);
      if (!l) this.bins.set(k, (l = []));
      l.push(v);
    }
  }
  private key(x: number, y: number, z: number) {
    return `${Math.floor(x / this.c)},${Math.floor(y / this.c)},${Math.floor(z / this.c)}`;
  }
  near(p: ArrayLike<number>, r: number): number[] {
    const out: number[] = [];
    const lo = [0, 1, 2].map((d) => Math.floor((p[d] - r) / this.c)), hi = [0, 1, 2].map((d) => Math.floor((p[d] + r) / this.c));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      for (const v of this.bins.get(`${x},${y},${z}`) ?? []) if (dist2(this.P, v, p) <= r * r) out.push(v);
    }
    return out;
  }
}

/** A tetrahedral mesh being edited: vertices move, edges split. */
class WorkMesh {
  P: number[];
  T: number[];
  vt: number[][];
  onB: number[] = [];
  labels: number[][] = [];
  locked: number[] = [];
  constructor(P: number[], T: number[], private h: number) {
    this.P = P;
    this.T = T;
    this.vt = Array.from({ length: P.length / 3 }, () => []);
    for (let t = 0; t < T.length / 4; t++) for (let k = 0; k < 4; k++) this.vt[T[t * 4 + k]].push(t);
    const n = P.length / 3;
    this.onB = new Array(n).fill(0);
    this.locked = new Array(n).fill(0);
    this.labels = Array.from({ length: n }, () => []);
  }
  get nn() { return this.P.length / 3; }
  get nt() { return this.T.length / 4; }
  pos(v: number): number[] { return [this.P[v * 3], this.P[v * 3 + 1], this.P[v * 3 + 2]]; }
  quality(t: number) { const T = this.T; return tetQuality(this.P, T[t * 4], T[t * 4 + 1], T[t * 4 + 2], T[t * 4 + 3]); }
  worst(v: number) { let w = Infinity; for (const t of this.vt[v]) w = Math.min(w, this.quality(t)); return w; }
  hasEdge(u: number, w: number) { return this.vt[u].some((t) => this.vt[w].includes(t)); }
  /** Moves v to p unless an element around it would get worse than minQ (or than the worst it had). */
  move(v: number, p: ArrayLike<number>, minQ: number): boolean {
    const old = this.pos(v);
    const before = this.worst(v);
    this.P[v * 3] = p[0]; this.P[v * 3 + 1] = p[1]; this.P[v * 3 + 2] = p[2];
    if (this.worst(v) >= Math.min(minQ, before)) return true;
    this.P[v * 3] = old[0]; this.P[v * 3 + 1] = old[1]; this.P[v * 3 + 2] = old[2];
    return false;
  }
  /** Splits edge u-w at its middle; returns the new vertex. */
  split(u: number, w: number): number {
    const x = this.nn;
    this.P.push((this.P[u * 3] + this.P[w * 3]) / 2, (this.P[u * 3 + 1] + this.P[w * 3 + 1]) / 2, (this.P[u * 3 + 2] + this.P[w * 3 + 2]) / 2);
    this.vt.push([]);
    this.onB.push(0);
    this.locked.push(0);
    this.labels.push([]);
    const shared = this.vt[u].filter((t) => this.vt[w].includes(t));
    for (const t of shared) {
      // t keeps u (w becomes x); the copy keeps w (u becomes x): both keep the orientation.
      const nt = this.nt;
      const copy = this.T.slice(t * 4, t * 4 + 4);
      for (let k = 0; k < 4; k++) {
        if (this.T[t * 4 + k] === w) this.T[t * 4 + k] = x;
        if (copy[k] === u) copy[k] = x;
      }
      this.T.push(...copy);
      this.vt[w] = this.vt[w].filter((q) => q !== t);
      this.vt[w].push(nt);
      this.vt[x].push(t, nt);
      for (const c of copy) if (c !== x && c !== w) this.vt[c].push(nt);
    }
    return x;
  }
  /** Moves interior vertices where that raises the worst element around them. */
  smooth(passes: number) {
    for (let pass = 0; pass < passes; pass++) {
      for (let v = 0; v < this.nn; v++) {
        if (this.onB[v]) continue;
        const worst = this.worst(v);
        if (worst > 0.45) continue;
        const nb = new Set<number>();
        for (const t of this.vt[v]) for (let k = 0; k < 4; k++) if (this.T[t * 4 + k] !== v) nb.add(this.T[t * 4 + k]);
        const c = [0, 0, 0];
        for (const w of nb) { c[0] += this.P[w * 3] / nb.size; c[1] += this.P[w * 3 + 1] / nb.size; c[2] += this.P[w * 3 + 2] / nb.size; }
        const old = this.pos(v);
        let best = worst, bestP = old;
        // The middle of the neighbours, part way there, and small steps along the axes.
        const step = this.h * 0.08;
        const tries = [c, [0, 1, 2].map((d) => old[d] + (c[d] - old[d]) * 0.5)];
        for (let d = 0; d < 3; d++) for (const sgn of [-1, 1]) { const p = old.slice(); p[d] += sgn * step; tries.push(p); }
        for (const p of tries) {
          this.P[v * 3] = p[0]; this.P[v * 3 + 1] = p[1]; this.P[v * 3 + 2] = p[2];
          const q = this.worst(v);
          if (q > best) { best = q; bestP = p; }
        }
        this.P[v * 3] = bestP[0]; this.P[v * 3 + 1] = bestP[1]; this.P[v * 3 + 2] = bestP[2];
      }
    }
  }
  typed(): LinearMesh {
    return { P: Float64Array.from(this.P), tets: Int32Array.from(this.T), nn: this.nn, nt: this.nt };
  }
}
