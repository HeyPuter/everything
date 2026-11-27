// What the interface gets from the analysis: the mesh's boundary (the
// surface the results are drawn on, with its own node numbering), the
// fields at those nodes, and a summary over the whole mesh. Also the
// helpers that turn fields into colours and values at a point.

import type { MeshStats, TetMesh } from './mesher';
import type { StaticInput, StaticResult, Vec3 } from './static';

export interface FeaMeshInfo {
  stats: MeshStats;
  /** xyz of the boundary nodes (corner and midside). */
  nodes: Float32Array;
  /** 6 boundary nodes per triangle: corners, then midside nodes of edges 01, 12, 20. */
  tris: Uint32Array;
  /** B-rep face of each triangle. */
  triFace: Int32Array;
  /** Element edges on the boundary as segments (each edge through its midside node), for showing the mesh. */
  lines: Float32Array;
}

export type FieldName = 'vonMises' | 'p1' | 'p2' | 'p3' | 'disp' | 'ux' | 'uy' | 'uz' | 'strain' | 'fos';

export interface Extreme {
  value: number;
  at: Vec3;
}

export interface FeaSummary {
  maxVonMises: Extreme;
  maxDisplacement: Extreme;
  maxP1: Extreme;
  minP3: Extreme;
  maxStrain: Extreme;
  reactions: Vec3[];
  applied: Vec3;
  loadAreas: number[];
  dofs: number;
  iterations: number;
  residual: number;
  solver: string;
  ms: StaticResult['ms'];
  /** Mass of the part (kg) when gravity is applied, else 0. */
  mass: number;
  warnings: string[];
}

export interface FeaSolution {
  /** Per boundary node: displacement (3 per node), von Mises, principal stresses 1-3, equivalent strain. */
  fields: Float32Array[];
  summary: FeaSummary;
}

/** The boundary of a mesh with its nodes renumbered; `map` gives each boundary node's mesh node. */
export function meshView(mesh: TetMesh): { info: FeaMeshInfo; map: Int32Array } {
  const remap = new Map<number, number>();
  const map: number[] = [];
  const tris = new Uint32Array(mesh.tris.length);
  for (let q = 0; q < mesh.tris.length; q++) {
    const v = mesh.tris[q];
    let id = remap.get(v);
    if (id === undefined) { id = map.length; remap.set(v, id); map.push(v); }
    tris[q] = id;
  }
  const nodes = new Float32Array(map.length * 3);
  map.forEach((v, i) => { nodes[i * 3] = mesh.nodes[v * 3]; nodes[i * 3 + 1] = mesh.nodes[v * 3 + 1]; nodes[i * 3 + 2] = mesh.nodes[v * 3 + 2]; });
  const seen = new Set<number>();
  const lines: number[] = [];
  const nt = tris.length / 6;
  for (let f = 0; f < nt; f++) {
    for (const [a, b, m] of [[0, 1, 3], [1, 2, 4], [2, 0, 5]]) {
      const key = tris[f * 6 + m];
      if (seen.has(key)) continue;
      seen.add(key);
      for (const [p, q] of [[a, m], [m, b]]) {
        const i = tris[f * 6 + p] * 3, j = tris[f * 6 + q] * 3;
        lines.push(nodes[i], nodes[i + 1], nodes[i + 2], nodes[j], nodes[j + 1], nodes[j + 2]);
      }
    }
  }
  return { info: { stats: mesh.stats, nodes, tris, triFace: Int32Array.from(mesh.triFace), lines: Float32Array.from(lines) }, map: Int32Array.from(map) };
}

function extreme(mesh: TetMesh, values: ArrayLike<number>, sign = 1): Extreme {
  let best = 0, bv = -Infinity;
  for (let v = 0; v < values.length; v++) if (sign * values[v] > bv) { bv = sign * values[v]; best = v; }
  return { value: values[best] ?? 0, at: [mesh.nodes[best * 3], mesh.nodes[best * 3 + 1], mesh.nodes[best * 3 + 2]] };
}

export function solutionOf(mesh: TetMesh, map: Int32Array, r: StaticResult, input: StaticInput): FeaSolution {
  const n = map.length;
  const U = new Float32Array(n * 3);
  const pick = (src: Float64Array) => { const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = src[map[i]]; return out; };
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) U[i * 3 + k] = r.U[map[i] * 3 + k];
  const N = r.vonMises.length;
  const disp = new Float64Array(N);
  for (let v = 0; v < N; v++) disp[v] = Math.hypot(r.U[v * 3], r.U[v * 3 + 1], r.U[v * 3 + 2]);
  const gravity = input.loads.find((l) => l.kind === 'gravity');
  const g = gravity && gravity.kind === 'gravity' ? Math.hypot(...gravity.accel) : 0;
  return {
    fields: [U, pick(r.vonMises), pick(r.p1), pick(r.p2), pick(r.p3), pick(r.strain)],
    summary: {
      maxVonMises: extreme(mesh, r.vonMises), maxDisplacement: extreme(mesh, disp), maxP1: extreme(mesh, r.p1), minP3: extreme(mesh, r.p3, -1), maxStrain: extreme(mesh, r.strain),
      reactions: r.reactions, applied: r.applied, loadAreas: r.loadAreas, dofs: r.dofs, iterations: r.iterations, residual: r.residual, solver: r.solver, ms: r.ms,
      mass: g > 0 ? mesh.stats.volume * input.density * 1000 : 0, warnings: r.warnings,
    },
  };
}

/** Values of a field at the boundary nodes (factor of safety needs the yield strength). */
export function fieldValues(sol: FeaSolution, field: FieldName, yieldStrength: number): Float32Array {
  const [U, vm, p1, p2, p3, strain] = sol.fields;
  const n = vm.length;
  if (field === 'vonMises') return vm;
  if (field === 'p1') return p1;
  if (field === 'p2') return p2;
  if (field === 'p3') return p3;
  if (field === 'strain') return strain;
  const out = new Float32Array(n);
  if (field === 'fos') { for (let i = 0; i < n; i++) out[i] = vm[i] > 0 ? yieldStrength / vm[i] : Infinity; return out; }
  if (field === 'disp') { for (let i = 0; i < n; i++) out[i] = Math.hypot(U[i * 3], U[i * 3 + 1], U[i * 3 + 2]); return out; }
  const k = field === 'ux' ? 0 : field === 'uy' ? 1 : 2;
  for (let i = 0; i < n; i++) out[i] = U[i * 3 + k];
  return out;
}

/** Rainbow colour map (blue low, red high), t in 0..1, as RGB 0..255. */
export function colorAt(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  // Blue, cyan, green, yellow, red.
  const stops: [number, number, number][] = [[20, 60, 220], [0, 190, 230], [40, 200, 80], [250, 220, 30], [225, 40, 30]];
  const s = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(s));
  const f = s - i;
  return [0, 1, 2].map((k) => Math.round(stops[i][k] + (stops[i + 1][k] - stops[i][k]) * f)) as [number, number, number];
}

/**
 * Where a ray first meets the (possibly deformed) result surface: the triangle,
 * its barycentric coordinates on the flat corner triangle, and the point.
 */
export function rayHit(positions: Float32Array, tris: Uint32Array, o: Vec3, d: Vec3): { tri: number; u: number; v: number; t: number } | null {
  let best: { tri: number; u: number; v: number; t: number } | null = null;
  const nt = tris.length / 6;
  for (let f = 0; f < nt; f++) {
    // The six-node triangle as four flat ones (corners and midside nodes).
    for (const [a, b, c, map] of SUB) {
      const ia = tris[f * 6 + a] * 3, ib = tris[f * 6 + b] * 3, ic = tris[f * 6 + c] * 3;
      const e1 = [positions[ib] - positions[ia], positions[ib + 1] - positions[ia + 1], positions[ib + 2] - positions[ia + 2]];
      const e2 = [positions[ic] - positions[ia], positions[ic + 1] - positions[ia + 1], positions[ic + 2] - positions[ia + 2]];
      const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
      if (Math.abs(det) < 1e-12) continue;
      const s = [o[0] - positions[ia], o[1] - positions[ia + 1], o[2] - positions[ia + 2]];
      const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
      if (v < 0 || u + v > 1) continue;
      const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (t <= 0 || (best && t >= best.t)) continue;
      // Back to the parent triangle's coordinates.
      const L = map(1 - u - v, u, v);
      best = { tri: f, u: L[1], v: L[2], t };
    }
  }
  return best;
}

/** Sub-triangles of a six-node triangle (slots), with the map from their barycentric coordinates to the parent's (r, s, t). */
export const SUB: [number, number, number, (a: number, b: number, c: number) => [number, number, number]][] = [
  [0, 3, 5, (a, b, c) => [a + b / 2 + c / 2, b / 2, c / 2]],
  [3, 1, 4, (a, b, c) => [a / 2, a / 2 + b + c / 2, c / 2]],
  [5, 4, 2, (a, b, c) => [a / 2, b / 2, a / 2 + b / 2 + c]],
  [3, 4, 5, (a, b, c) => [a / 2 + c / 2, a / 2 + b / 2, b / 2 + c / 2]],
];

/** Value of a node field at (s, t) on six-node triangle f (quadratic interpolation). */
export function interpolate(values: ArrayLike<number>, tris: Uint32Array, f: number, s: number, t: number, stride = 1, comp = 0): number {
  const r = 1 - s - t;
  const N = [r * (2 * r - 1), s * (2 * s - 1), t * (2 * t - 1), 4 * r * s, 4 * s * t, 4 * t * r];
  let out = 0;
  for (let a = 0; a < 6; a++) out += N[a] * values[tris[f * 6 + a] * stride + comp];
  return out;
}
