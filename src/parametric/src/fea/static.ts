// Linear static analysis on a quadratic tetrahedral mesh: assembly of the
// stiffness matrix, loads, fixtures (as constraints in each node's own
// directions), the check that the fixtures hold the part, the solve, and the
// stresses, strains and reactions that come out of it.
//
// Units: millimetres, newtons, megapascals (N/mm^2), tonnes per cubic
// millimetre for density (so density times mm/s^2 is N/mm^3).

import { type Preconditioner, blockAt, blockJacobi, meshPattern, pcg, smoothedAggregation } from './amg';
import { addBodyForce, elementNodeStrains, elementStiffness, integrateTriangle, lame, principal } from './elements';
import type { TetMesh } from './mesher';

export type Vec3 = [number, number, number];

export type FixtureInput =
  | { kind: 'fixed'; faces: number[] }
  /** No motion normal to the faces (each node: the mesh normal there). */
  | { kind: 'roller'; faces: number[] }
  /** A cylindrical face that may only turn about its axis (no radial or axial motion). */
  | { kind: 'hinge'; faces: number[]; axis: { p: Vec3; d: Vec3 } };

export type LoadInput =
  /** Total force spread evenly over the faces' area: along dir, or (dir null) pressing on the faces as a pressure would. */
  | { kind: 'force'; faces: number[]; total: number; dir: Vec3 | null }
  /** Pressure (MPa), pushing into the faces. */
  | { kind: 'pressure'; faces: number[]; value: number }
  /** Acceleration of gravity (mm/s^2): the part's weight acts along it. */
  | { kind: 'gravity'; accel: Vec3 };

export interface StaticInput {
  /** Elastic modulus (MPa), Poisson's ratio, density (t/mm^3). */
  E: number;
  nu: number;
  density: number;
  fixtures: FixtureInput[];
  loads: LoadInput[];
}

export interface StaticResult {
  /** Displacement per node (x, y, z). */
  U: Float64Array;
  /** Per node: von Mises stress, principal stresses (largest first), equivalent strain. */
  vonMises: Float64Array;
  p1: Float64Array;
  p2: Float64Array;
  p3: Float64Array;
  strain: Float64Array;
  /** Stress components per node (xx, yy, zz, xy, yz, zx). */
  stress: Float64Array;
  /** Reaction force of each fixture, and the sum of the applied loads (N). */
  reactions: Vec3[];
  applied: Vec3;
  /** Area each load acts on, as meshed (mm^2): 0 for gravity. */
  loadAreas: number[];
  dofs: number;
  /** Things the user should know about the solution (a free motion held by weak springs). */
  warnings: string[];
  iterations: number;
  residual: number;
  solver: string;
  ms: { assemble: number; setup: number; solve: number; stress: number };
}

/** A study the solver cannot run, with a message for the user. */
export class StudyError extends Error {}

const AXES = ['X', 'Y', 'Z'];

/**
 * Whether the fixtures hold every piece of the mesh: rigid motions they do
 * not stop are described ('free to move along X', 'free to turn about ...').
 */
export function rigidMotions(mesh: TetMesh, constrained: Map<number, Vec3[]>): string[] {
  return freeMotions(mesh, constrained).map((m) => m.text);
}

/** A rigid motion the fixtures allow: u = t + w x (x - c) / L on the nodes of one piece. */
export interface FreeMotion {
  text: string;
  v: number[];
  c: Vec3;
  L: number;
  /** Whether a node belongs to the piece. */
  has: (node: number) => boolean;
}

export function freeMotions(mesh: TetMesh, constrained: Map<number, Vec3[]>): FreeMotion[] {
  const X = mesh.nodes, nn = mesh.nodes.length / 3;
  // Pieces of the mesh (connected through elements).
  const parent = new Int32Array(nn).map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const T = mesh.tets;
  for (let e = 0; e < T.length; e += 10) { const a = find(T[e]); for (let k = 1; k < 10; k++) { const b = find(T[e + k]); if (a !== b) parent[b] = a; } }
  const pieces = new Map<number, { c: Vec3; n: number; M: number[] }>();
  for (let e = 0; e < T.length; e += 10) {
    for (let k = 0; k < 10; k++) {
      const v = T[e + k], r = find(v);
      let p = pieces.get(r);
      if (!p) pieces.set(r, (p = { c: [0, 0, 0], n: 0, M: new Array(36).fill(0) }));
    }
  }
  const seen = new Uint8Array(nn);
  for (let e = 0; e < T.length; e++) {
    const v = T[e];
    if (seen[v]) continue;
    seen[v] = 1;
    const p = pieces.get(find(v))!;
    p.c[0] += X[v * 3]; p.c[1] += X[v * 3 + 1]; p.c[2] += X[v * 3 + 2]; p.n++;
  }
  let L = 0;
  for (const p of pieces.values()) { p.c = [p.c[0] / p.n, p.c[1] / p.n, p.c[2] / p.n]; }
  for (let v = 0; v < nn; v++) if (seen[v]) { const p = pieces.get(find(v))!; L = Math.max(L, Math.hypot(X[v * 3] - p.c[0], X[v * 3 + 1] - p.c[1], X[v * 3 + 2] - p.c[2])); }
  L = L || 1;
  // Each constrained direction d at x stops the rigid motions (t, w) with d.t + ((x - c) x d).w != 0.
  for (const [v, dirs] of constrained) {
    const p = pieces.get(find(v));
    if (!p) continue;
    const r = [(X[v * 3] - p.c[0]) / L, (X[v * 3 + 1] - p.c[1]) / L, (X[v * 3 + 2] - p.c[2]) / L];
    for (const d of dirs) {
      const row = [d[0], d[1], d[2], r[1] * d[2] - r[2] * d[1], r[2] * d[0] - r[0] * d[2], r[0] * d[1] - r[1] * d[0]];
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) p.M[i * 6 + j] += row[i] * row[j];
    }
  }
  const free: FreeMotion[] = [];
  const several = pieces.size > 1;
  let k = 0;
  for (const [root, p] of pieces) {
    k++;
    const motion = (text: string, v: number[]): FreeMotion => ({ text, v, c: p.c, L, has: (node) => find(node) === root });
    const { values, vectors } = jacobiEigen(p.M, 6);
    const top = Math.max(...values, 0);
    // The free motions: eigenvectors of (nearly) zero eigenvalues.
    const nul: number[][] = [];
    values.forEach((lam, i) => { if (!(top > 0) || lam <= 1e-9 * top) nul.push(vectors.slice(i * 6, i * 6 + 6)); });
    if (!nul.length) continue;
    const where = several ? ` (piece ${k} of ${pieces.size})` : '';
    // Name them along the axes where they are: a motion along X is free if its projection on the free motions is whole.
    const inNull = (v: number[]) => { let s = 0; for (const n of nul) { let d = 0; for (let q = 0; q < 6; q++) d += n[q] * v[q]; s += d * d; } return s; };
    const named: string[] = [];
    for (let a = 0; a < 3; a++) { const v = [0, 0, 0, 0, 0, 0]; v[a] = 1; if (inNull(v) > 0.98) named.push(`free to move along ${AXES[a]}`); }
    // Turning about an axis along X (through any point): some free motion has a rotation part along X alone.
    for (let a = 0; a < 3; a++) {
      // Largest |w_a| / |w| over the free motions' span: the rotation parts' Gram matrix.
      const W = nul.map((n) => [n[3], n[4], n[5]]);
      const G = W.map((x) => W.map((y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2]));
      const g = W.map((x) => x[a]);
      // Best combination c maximising (g.c)^2 / (c.G.c): solve G c = g (least squares by Jacobi eigen).
      const m = W.length;
      const { values: gv, vectors: gV } = jacobiEigen(G.flat(), m);
      let ratio = 0;
      const gmax = Math.max(...gv, 0);
      gv.forEach((lam, i) => { if (lam > 1e-9 * gmax && gmax > 0) { let d = 0; for (let q = 0; q < m; q++) d += gV[i * m + q] * g[q]; ratio += (d * d) / lam; } });
      if (ratio > 0.98) named.push(`free to turn about ${AXES[a]}`);
    }
    if (named.length >= nul.length) { named.forEach((n, i) => free.push(motion(n + where, nul[Math.min(i, nul.length - 1)]))); for (let i = named.length; i < nul.length; i++) free.push(motion('', nul[i])); continue; }
    // Otherwise the eigenvectors as they are.
    for (const v of nul) {
      const t = Math.hypot(v[0], v[1], v[2]), w = Math.hypot(v[3], v[4], v[5]);
      if (w < 0.05 * t) free.push(motion(`free to move ${describeDir([v[0], v[1], v[2]])}${where}`, v));
      else free.push(motion(`free to turn ${describeDir([v[3] / w, v[4] / w, v[5] / w], 'about')}${where}`, v));
    }
  }
  return free;
}

function describeDir(d: number[], prep = 'along'): string {
  const n = Math.hypot(d[0], d[1], d[2]) || 1;
  const u = d.map((x) => x / n);
  const i = [0, 1, 2].reduce((b, k) => (Math.abs(u[k]) > Math.abs(u[b]) ? k : b), 0);
  if (Math.abs(u[i]) > 0.999) return `${prep} ${AXES[i]}`;
  return `${prep} (${u.map((x) => x.toFixed(2)).join(', ')})`;
}

/** Eigenvalues and vectors (rows of `vectors`) of a symmetric n x n matrix (cyclic Jacobi). */
export function jacobiEigen(Ain: number[], n: number): { values: number[]; vectors: number[] } {
  const A = Ain.slice();
  const V = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i * n + j] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = A[p * n + q];
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (A[q * n + q] - A[p * n + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = A[k * n + p], akq = A[k * n + q];
        A[k * n + p] = c * akp - s * akq; A[k * n + q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = A[p * n + k], aqk = A[q * n + k];
        A[p * n + k] = c * apk - s * aqk; A[q * n + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k * n + p], vkq = V[k * n + q];
        V[k * n + p] = c * vkp - s * vkq; V[k * n + q] = s * vkp + c * vkq;
      }
    }
  }
  const values = Array.from({ length: n }, (_, i) => A[i * n + i]);
  const vectors: number[] = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) vectors.push(V[k * n + i]);
  return { values, vectors };
}

/** Nodes of the boundary triangles on the given faces. */
function faceNodes(mesh: TetMesh, faces: Set<number>): number[] {
  const out = new Set<number>();
  for (let f = 0; f < mesh.triFace.length; f++) if (faces.has(mesh.triFace[f])) for (let a = 0; a < 6; a++) out.add(mesh.tris[f * 6 + a]);
  return [...out];
}

/** The constrained directions of each node (global unit vectors); `by` gets the fixture of each direction. */
export function constraintsOf(mesh: TetMesh, fixtures: FixtureInput[], by?: Map<number, number[]>): Map<number, Vec3[]> {
  const X = mesh.nodes;
  const out = new Map<number, Vec3[]>();
  let fixture = 0;
  const add = (v: number, d: Vec3) => {
    let l = out.get(v); if (!l) out.set(v, (l = [])); l.push(d);
    if (by) { let w = by.get(v); if (!w) by.set(v, (w = [])); w.push(fixture); }
  };
  fixtures.forEach((fx, i) => {
    fixture = i;
    const faces = new Set(fx.faces);
    const nodes = faceNodes(mesh, faces);
    if (!nodes.length) throw new StudyError(`Fixture ${i + 1}: its faces are not in the mesh.`);
    if (fx.kind === 'fixed') { for (const v of nodes) { add(v, [1, 0, 0]); add(v, [0, 1, 0]); add(v, [0, 0, 1]); } return; }
    if (fx.kind === 'roller') {
      // The surface normal at each node on each face: the (area weighted) normals of the face's triangles around it.
      const nrm = new Map<number, Map<number, Vec3>>();
      for (let f = 0; f < mesh.triFace.length; f++) {
        const face = mesh.triFace[f];
        if (!faces.has(face)) continue;
        const a = mesh.tris[f * 6] * 3, b = mesh.tris[f * 6 + 1] * 3, c = mesh.tris[f * 6 + 2] * 3;
        const ux = X[b] - X[a], uy = X[b + 1] - X[a + 1], uz = X[b + 2] - X[a + 2], wx = X[c] - X[a], wy = X[c + 1] - X[a + 1], wz = X[c + 2] - X[a + 2];
        const fn: Vec3 = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
        for (let q = 0; q < 6; q++) {
          const v = mesh.tris[f * 6 + q];
          let byFace = nrm.get(v);
          if (!byFace) nrm.set(v, (byFace = new Map()));
          let n = byFace.get(face);
          if (!n) byFace.set(face, (n = [0, 0, 0]));
          n[0] += fn[0]; n[1] += fn[1]; n[2] += fn[2];
        }
      }
      // A node on the edge between two of the faces is held normal to each (to their average where they meet
      // nearly tangent, as a fillet meets a flat face).
      for (const [v, byFace] of nrm) {
        const dirs: Vec3[] = [];
        for (const n of byFace.values()) {
          const l = Math.hypot(n[0], n[1], n[2]);
          if (!(l > 0)) continue;
          const u: Vec3 = [n[0] / l, n[1] / l, n[2] / l];
          const near = dirs.find((d) => (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / Math.hypot(d[0], d[1], d[2]) > 0.85);
          if (near) { near[0] += u[0]; near[1] += u[1]; near[2] += u[2]; } else dirs.push(u);
        }
        for (const d of dirs) { const l = Math.hypot(d[0], d[1], d[2]); add(v, [d[0] / l, d[1] / l, d[2] / l]); }
      }
      return;
    }
    const { p, d } = fx.axis;
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    const ax: Vec3 = [d[0] / dl, d[1] / dl, d[2] / dl];
    for (const v of nodes) {
      const r = [X[v * 3] - p[0], X[v * 3 + 1] - p[1], X[v * 3 + 2] - p[2]];
      const t = r[0] * ax[0] + r[1] * ax[1] + r[2] * ax[2];
      const rad: Vec3 = [r[0] - t * ax[0], r[1] - t * ax[1], r[2] - t * ax[2]];
      const rl = Math.hypot(rad[0], rad[1], rad[2]);
      add(v, ax);
      if (rl > 1e-9) add(v, [rad[0] / rl, rad[1] / rl, rad[2] / rl]);
      else { add(v, [1, 0, 0]); add(v, [0, 1, 0]); add(v, [0, 0, 1]); }
    }
  });
  return out;
}

/** Orthonormal basis (columns of a 3 x 3 rotation, row-major) whose first k columns span the directions; returns k. */
function constraintBasis(dirs: Vec3[], R: Float64Array, off: number): number {
  const basis: Vec3[] = [];
  for (const d of dirs) {
    const v: Vec3 = [d[0], d[1], d[2]];
    for (const b of basis) { const s = v[0] * b[0] + v[1] * b[1] + v[2] * b[2]; v[0] -= s * b[0]; v[1] -= s * b[1]; v[2] -= s * b[2]; }
    const l = Math.hypot(v[0], v[1], v[2]);
    if (l > 1e-3) basis.push([v[0] / l, v[1] / l, v[2] / l]);
    if (basis.length === 3) break;
  }
  const k = basis.length;
  // Complete to a right-handed frame.
  for (const e of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]) {
    if (basis.length === 3) break;
    const v: Vec3 = [e[0], e[1], e[2]];
    for (const b of basis) { const s = v[0] * b[0] + v[1] * b[1] + v[2] * b[2]; v[0] -= s * b[0]; v[1] -= s * b[1]; v[2] -= s * b[2]; }
    const l = Math.hypot(v[0], v[1], v[2]);
    if (l > 0.3) basis.push([v[0] / l, v[1] / l, v[2] / l]);
  }
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) R[off + r * 3 + c] = basis[c][r];
  return k;
}

/** The loads as nodal forces; also the total applied force and each load's meshed area. */
export function loadVector(mesh: TetMesh, input: StaticInput): { F: Float64Array; applied: Vec3; areas: number[] } {
  const X = mesh.nodes, N = X.length / 3;
  const F = new Float64Array(N * 3);
  const areas: number[] = [];
  input.loads.forEach((ld, i) => {
    if (ld.kind === 'gravity') {
      const b = [input.density * ld.accel[0], input.density * ld.accel[1], input.density * ld.accel[2]];
      for (let e = 0; e < mesh.tets.length / 10; e++) addBodyForce(X, mesh.tets, e, b, F);
      areas.push(0);
      return;
    }
    const faces = new Set(ld.faces);
    const tris: number[] = [];
    for (let f = 0; f < mesh.triFace.length; f++) if (faces.has(mesh.triFace[f])) tris.push(f);
    if (!tris.length) throw new StudyError(`Load ${i + 1}: its faces are not in the mesh.`);
    let area = 0;
    for (const f of tris) area += integrateTriangle(X, mesh.tris, f);
    areas.push(area);
    if (ld.kind === 'force' && ld.dir) {
      const l = Math.hypot(ld.dir[0], ld.dir[1], ld.dir[2]) || 1;
      const t = [(ld.total * ld.dir[0]) / l / area, (ld.total * ld.dir[1]) / l / area, (ld.total * ld.dir[2]) / l / area];
      for (const f of tris) integrateTriangle(X, mesh.tris, f, (a, w) => { const n = mesh.tris[f * 6 + a] * 3; F[n] += t[0] * w; F[n + 1] += t[1] * w; F[n + 2] += t[2] * w; });
      return;
    }
    // Pressure (or a normal force as the pressure that adds up to it on a flat face): along the inward normal.
    const p = ld.kind === 'pressure' ? ld.value : ld.total / area;
    for (const f of tris) integrateTriangle(X, mesh.tris, f, (a, _w, nx, ny, nz) => { const n = mesh.tris[f * 6 + a] * 3; F[n] -= p * nx; F[n + 1] -= p * ny; F[n + 2] -= p * nz; });
  });
  const applied: Vec3 = [0, 0, 0];
  for (let v = 0; v < N; v++) { applied[0] += F[v * 3]; applied[1] += F[v * 3 + 1]; applied[2] += F[v * 3 + 2]; }
  return { F, applied, areas };
}

export function solveStatic(mesh: TetMesh, input: StaticInput, progress: (stage: string, f: number) => void = () => {}, debug?: (m: string) => void): StaticResult {
  const t0 = performance.now();
  const X = mesh.nodes, N = X.length / 3;
  if (!(input.E > 0) || !(input.nu >= 0 && input.nu < 0.5)) throw new StudyError('The material\'s elastic properties are not valid.');
  if (!input.fixtures.length) throw new StudyError('The study has no fixtures: the part is free to move. Add a fixture to hold it.');
  if (!input.loads.length) throw new StudyError('The study has no loads. Add a force, pressure or gravity.');
  const fixtureOf = new Map<number, number[]>();
  const constrained = constraintsOf(mesh, input.fixtures, fixtureOf);
  const free = freeMotions(mesh, constrained);
  const { F, applied, areas } = loadVector(mesh, input);
  const warnings: string[] = [];
  // A free rigid motion is acceptable only if the loads do no work on it (a pinned link pulled along its
  // length): it is then held by springs too weak to change the result. Otherwise the part would accelerate.
  const texts = () => [...new Set(free.map((m) => m.text).filter(Boolean))].join(', ');
  if (free.length) {
    const modeAt = (m: FreeMotion, v: number) => {
      const r = [(X[v * 3] - m.c[0]) / m.L, (X[v * 3 + 1] - m.c[1]) / m.L, (X[v * 3 + 2] - m.c[2]) / m.L];
      return [m.v[0] + m.v[4] * r[2] - m.v[5] * r[1], m.v[1] + m.v[5] * r[0] - m.v[3] * r[2], m.v[2] + m.v[3] * r[1] - m.v[4] * r[0]];
    };
    // The loads' work on the motion against what they could do at most (all of them along it where they act).
    const unbalanced = free.some((m) => {
      let work = 0, most = 0;
      for (let v = 0; v < N; v++) {
        if (!m.has(v)) continue;
        const f = Math.hypot(F[v * 3], F[v * 3 + 1], F[v * 3 + 2]);
        if (!f) continue;
        const u = modeAt(m, v);
        work += F[v * 3] * u[0] + F[v * 3 + 1] * u[1] + F[v * 3 + 2] * u[2];
        most += f * Math.hypot(u[0], u[1], u[2]);
      }
      return Math.abs(work) > 1e-3 * most;
    });
    if (unbalanced) throw new StudyError(`The fixtures do not hold the part against its loads: it is ${texts()}, and the loads would move it that way (an unstable study). Add fixtures (or change them) so that it cannot move or turn as a rigid body.`);
    // What is left of that work comes from the mesh not being exactly symmetric: take it out of the loads.
    for (let pass = 0; pass < 2; pass++) for (const m of free) {
      let fu = 0, uu = 0;
      for (let v = 0; v < N; v++) { if (!m.has(v)) continue; const u = modeAt(m, v); fu += F[v * 3] * u[0] + F[v * 3 + 1] * u[1] + F[v * 3 + 2] * u[2]; uu += u[0] ** 2 + u[1] ** 2 + u[2] ** 2; }
      if (!(uu > 0)) continue;
      for (let v = 0; v < N; v++) { if (!m.has(v)) continue; const u = modeAt(m, v); for (let c = 0; c < 3; c++) F[v * 3 + c] -= (fu / uu) * u[c]; }
    }
    applied[0] = applied[1] = applied[2] = 0;
    for (let v = 0; v < N; v++) for (let c = 0; c < 3; c++) applied[c] += F[v * 3 + c];
    warnings.push(`The fixtures leave the part ${texts()}; the loads do not push it that way, so it was solved with weak springs holding that motion. Check that this is intended.`);
  }

  // ---- assembly ----
  progress('Assembling', 0);
  const A = meshPattern(N, mesh.tets, 10);
  const { lambda, mu } = lame(input.E, input.nu);
  const Ke = new Float64Array(900);
  const ne = mesh.tets.length / 10;
  const slot = new Int32Array(100);
  for (let e = 0; e < ne; e++) {
    if (!elementStiffness(X, mesh.tets, e, lambda, mu, Ke)) throw new StudyError('The mesh has an inverted element. Try another mesh size.');
    for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) slot[a * 10 + b] = blockAt(A, mesh.tets[e * 10 + a], mesh.tets[e * 10 + b]);
    for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) {
      const q = slot[a * 10 + b] * 9;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) A.val[q + i * 3 + j] += Ke[(a * 3 + i) * 30 + b * 3 + j];
    }
    if ((e & 4095) === 0) progress('Assembling', e / ne);
  }
  // Rows of the constrained nodes as assembled, for the reactions.
  const reactionRows = new Map<number, { cols: Int32Array; vals: Float64Array }>();
  for (const v of constrained.keys()) reactionRows.set(v, { cols: A.col.slice(A.rowPtr[v], A.rowPtr[v + 1]), vals: A.val.slice(A.rowPtr[v] * 9, A.rowPtr[v + 1] * 9) });
  const Forig = F.slice();

  // ---- constraints: each constrained node in its own frame, the constrained directions removed ----
  const R = new Float64Array(N * 9);
  const k = new Int8Array(N);
  for (let v = 0; v < N; v++) { R[v * 9] = R[v * 9 + 4] = R[v * 9 + 8] = 1; }
  for (const [v, dirs] of constrained) k[v] = constraintBasis(dirs, R, v * 9);
  const rotated = new Uint8Array(N);
  for (const v of constrained.keys()) rotated[v] = k[v] < 3 ? 1 : 0;
  const tmp = new Float64Array(9);
  for (let i = 0; i < N; i++) {
    for (let q = A.rowPtr[i]; q < A.rowPtr[i + 1]; q++) {
      const j = A.col[q];
      if (!rotated[i] && !rotated[j] && !k[i] && !k[j]) continue;
      const o = q * 9;
      if (rotated[i] || rotated[j]) {
        // R_i^T A_ij R_j
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let m = 0; m < 3; m++) for (let l = 0; l < 3; l++) s += R[i * 9 + m * 3 + r] * A.val[o + m * 3 + l] * R[j * 9 + l * 3 + c];
          tmp[r * 3 + c] = s;
        }
        A.val.set(tmp, o);
      }
      for (let r = 0; r < k[i]; r++) for (let c = 0; c < 3; c++) A.val[o + r * 3 + c] = 0;
      for (let c = 0; c < k[j]; c++) for (let r = 0; r < 3; r++) A.val[o + r * 3 + c] = 0;
    }
  }
  const diagScale = (() => { let s = 0; for (let i = 0; i < N; i++) { const q = blockAt(A, i, i) * 9; s = Math.max(s, A.val[q], A.val[q + 4], A.val[q + 8]); } return s; })();
  if (free.length) {
    // Weak springs hold the free motions: on the free directions of the held nodes (they hardly move there),
    // or on every node of a piece nothing holds.
    const held = (m: FreeMotion) => { for (const v of constrained.keys()) if (m.has(v)) return true; return false; };
    const onHeld = free.every(held);
    const ks = diagScale * (onHeld ? 1e-6 : 1e-10);
    for (let i = 0; i < N; i++) {
      if (onHeld ? !k[i] : false) continue;
      const q = blockAt(A, i, i) * 9;
      for (let r = k[i]; r < 3; r++) A.val[q + r * 4] += ks;
    }
  }
  for (let i = 0; i < N; i++) {
    if (!k[i]) continue;
    const q = blockAt(A, i, i) * 9;
    for (let r = 0; r < k[i]; r++) A.val[q + r * 4] = diagScale;
    const f = [F[i * 3], F[i * 3 + 1], F[i * 3 + 2]];
    for (let r = 0; r < 3; r++) F[i * 3 + r] = r < k[i] ? 0 : R[i * 9 + r] * f[0] + R[i * 9 + 3 + r] * f[1] + R[i * 9 + 6 + r] * f[2];
  }
  const tAsm = performance.now();

  // ---- solve ----
  progress('Preparing the solver', 0);
  let M: Preconditioner;
  try {
    M = smoothedAggregation(A, X, { progress: (f) => progress('Preparing the solver', f), debug, frames: R, held: k });
  } catch {
    M = blockJacobi(A);
  }
  const tSetup = performance.now();
  const Ul = new Float64Array(N * 3);
  // Progress: the residual's fall from 1 to the tolerance (it may first rise above 1).
  const solved = (rel: number) => Math.max(0, Math.min(0.99, Math.log10(1 / Math.max(rel, 1e-12)) / 9));
  const maxIter = 800;
  let res = pcg(A, F, Ul, M, { tol: 1e-9, maxIter, progress: (it, rel) => { if (it % 5 === 0) progress('Solving', solved(rel)); } });
  if (!res.converged && M.levels > 1 && res.iterations < maxIter) {
    // The multigrid broke down: fall back on the simple preconditioner (slow, but it does not depend on the
    // aggregation). Not when it merely converged slowly: block Jacobi would take far longer to fail too.
    M = blockJacobi(A);
    res = pcg(A, F, Ul, M, { tol: 1e-9, maxIter: 20000, progress: (it, rel) => { if (it % 25 === 0) progress('Solving', solved(rel)); } });
  }
  if (!res.converged && !(res.residual < 1e-5)) {
    throw new StudyError(input.nu > 0.49
      ? `The solver did not converge: the material's Poisson's ratio (${input.nu}) is so close to 0.5 that it is nearly incompressible, which this solver cannot handle. Use a Poisson's ratio of 0.49 or less.`
      : 'The solver did not converge. The study may be poorly constrained, or the mesh may have very poor elements: try another mesh size.');
  }
  const tSolve = performance.now();
  // Back to global directions.
  const U = new Float64Array(N * 3);
  for (let v = 0; v < N; v++) {
    for (let r = 0; r < 3; r++) U[v * 3 + r] = R[v * 9 + r * 3] * Ul[v * 3] + R[v * 9 + r * 3 + 1] * Ul[v * 3 + 1] + R[v * 9 + r * 3 + 2] * Ul[v * 3 + 2];
  }

  // ---- reactions ----
  const reactions: Vec3[] = input.fixtures.map(() => [0, 0, 0]);
  for (const [v, row] of reactionRows) {
    const r = [-Forig[v * 3], -Forig[v * 3 + 1], -Forig[v * 3 + 2]];
    for (let q = 0; q < row.cols.length; q++) {
      const j = row.cols[q] * 3, o = q * 9;
      for (let a = 0; a < 3; a++) r[a] += row.vals[o + a * 3] * U[j] + row.vals[o + a * 3 + 1] * U[j + 1] + row.vals[o + a * 3 + 2] * U[j + 2];
    }
    // A node held by several fixtures: each gets the part of the reaction along the directions it holds
    // (as the constraint frame takes them), the first one what is left (the weak springs' share).
    const dirs = constrained.get(v)!, who = fixtureOf.get(v)!;
    const basis: Vec3[] = [];
    for (let q = 0; q < dirs.length && basis.length < 3; q++) {
      const d: Vec3 = [dirs[q][0], dirs[q][1], dirs[q][2]];
      for (const e of basis) { const s = d[0] * e[0] + d[1] * e[1] + d[2] * e[2]; d[0] -= s * e[0]; d[1] -= s * e[1]; d[2] -= s * e[2]; }
      const l = Math.hypot(d[0], d[1], d[2]);
      if (!(l > 1e-3)) continue;
      const e: Vec3 = [d[0] / l, d[1] / l, d[2] / l];
      basis.push(e);
      const c = r[0] * e[0] + r[1] * e[1] + r[2] * e[2];
      for (let a = 0; a < 3; a++) { reactions[who[q]][a] += c * e[a]; r[a] -= c * e[a]; }
    }
    for (let a = 0; a < 3; a++) reactions[who[0]][a] += r[a];
  }

  // ---- stresses ----
  progress('Computing stresses', 0);
  const S = new Float64Array(N * 6), Eps = new Float64Array(N * 6), count = new Float64Array(N);
  const strains = new Float64Array(60);
  for (let e = 0; e < ne; e++) {
    elementNodeStrains(X, mesh.tets, e, U, strains);
    for (let a = 0; a < 10; a++) {
      const v = mesh.tets[e * 10 + a];
      count[v]++;
      for (let c = 0; c < 6; c++) Eps[v * 6 + c] += strains[a * 6 + c];
    }
  }
  const vonMises = new Float64Array(N), p1 = new Float64Array(N), p2 = new Float64Array(N), p3 = new Float64Array(N), strain = new Float64Array(N);
  for (let v = 0; v < N; v++) {
    const n = count[v] || 1;
    const exx = Eps[v * 6] / n, eyy = Eps[v * 6 + 1] / n, ezz = Eps[v * 6 + 2] / n, exy = Eps[v * 6 + 3] / n, eyz = Eps[v * 6 + 4] / n, ezx = Eps[v * 6 + 5] / n;
    const tr = exx + eyy + ezz;
    const sxx = lambda * tr + 2 * mu * exx, syy = lambda * tr + 2 * mu * eyy, szz = lambda * tr + 2 * mu * ezz;
    const sxy = 2 * mu * exy, syz = 2 * mu * eyz, szx = 2 * mu * ezx;
    S.set([sxx, syy, szz, sxy, syz, szx], v * 6);
    vonMises[v] = Math.sqrt(0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) + 3 * (sxy * sxy + syz * syz + szx * szx));
    const pr = principal(sxx, syy, szz, sxy, syz, szx);
    p1[v] = pr[0]; p2[v] = pr[1]; p3[v] = pr[2];
    const m = tr / 3;
    const dev = (exx - m) ** 2 + (eyy - m) ** 2 + (ezz - m) ** 2 + 2 * (exy * exy + eyz * eyz + ezx * ezx);
    strain[v] = Math.sqrt((2 / 3) * dev);
  }
  const tEnd = performance.now();
  return {
    U, vonMises, p1, p2, p3, strain, stress: S, reactions, applied, loadAreas: areas, dofs: N * 3, warnings,
    iterations: res.iterations, residual: res.residual, solver: M.description,
    ms: { assemble: tAsm - t0, setup: tSetup - tAsm, solve: tSolve - tSetup, stress: tEnd - tSolve },
  };
}

