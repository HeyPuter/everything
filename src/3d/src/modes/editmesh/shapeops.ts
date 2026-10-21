// Shaping tools for edge loops and regions: To Circle (mesh.circularize), Flatten (mesh.flatten) and
// Space Evenly (mesh.space_edge_loops_evenly). The kernels are pure functions on MeshEdit; loops come
// from the selected edges, or from the boundary of the selected faces.
import { Vector3 } from 'three';
import { app, registerOperators, type PropDef } from '../../app/app';
import { activeView3D } from '../../editors/view3d/view3d';
import { MeshEdit, edgeKey } from './meshedit';
import { withEdit, worldMatrix } from './context';
import { editPoll } from './ops-basic';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));

export interface Loop {
  verts: number[];
  closed: boolean;
}

/**
 * Edge loops / chains of the selection: the boundary of the selected faces when faces are selected,
 * otherwise the selected edges. Components that branch are skipped.
 */
export function selectedLoops(m: MeshEdit): Loop[] {
  const faces = m.selectedFaces();
  let edges: [number, number][];
  if (faces.length) {
    const count = new Map<string, number>();
    const pair = new Map<string, [number, number]>();
    for (const fi of faces) {
      const f = m.faces[fi].verts;
      f.forEach((v, i) => {
        const w = f[(i + 1) % f.length];
        const k = edgeKey(v, w);
        count.set(k, (count.get(k) ?? 0) + 1);
        pair.set(k, [v, w]);
      });
    }
    edges = [...count].filter(([, c]) => c === 1).map(([k]) => pair.get(k)!);
  } else edges = m.selectedEdges();
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set<number>();
  const loops: Loop[] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    // the component
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const v = stack.pop()!;
      comp.push(v);
      for (const w of adj.get(v)!) if (!seen.has(w)) (seen.add(w), stack.push(w));
    }
    const deg = (v: number) => adj.get(v)!.length;
    if (comp.some((v) => deg(v) > 2) || comp.length < 2) continue;
    const ends = comp.filter((v) => deg(v) === 1);
    const closed = ends.length === 0;
    // walk the chain (closed loops start at their lowest index)
    const first = closed ? Math.min(...comp) : Math.min(...ends);
    const order = [first];
    let prev = -1,
      cur = first;
    for (;;) {
      const next = adj.get(cur)!.find((w) => w !== prev && (order.length < 2 || w !== order[order.length - 2]));
      if (next === undefined || next === first) break;
      order.push(next);
      prev = cur;
      cur = next;
    }
    if (closed && order.length < 3) continue;
    // closed loops run so that their winding follows the faces they bound
    if (closed && faces.length) {
      const fset = faces.map((fi) => m.faces[fi].verts);
      const [a, b] = [order[0], order[1]];
      const forward = fset.some((f) => f.some((v, i) => v === a && f[(i + 1) % f.length] === b));
      if (!forward) order.reverse();
    }
    loops.push({ verts: order, closed });
  }
  return loops;
}

/** Normal of a polygon through the points (sum of cross products; the open chain is closed). */
export function newellNormal(pts: V3[]): V3 {
  let n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) n = add(n, cross(pts[i], pts[(i + 1) % pts.length]));
  return norm(n);
}

/** Circle through 2D points minimising the squared distances to it (algebraic start, Gauss-Newton refinement). */
export function fitCircle2D(q: [number, number][]): { cx: number; cy: number; r: number } {
  const n = q.length;
  // algebraic (Kåsa) fit: solve 2x·cx + 2y·cy + c = x² + y²
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rhs = [0, 0, 0];
  for (const [x, y] of q) {
    const row = [2 * x, 2 * y, 1];
    const b = x * x + y * y;
    for (let i = 0; i < 3; i++) {
      rhs[i] += row[i] * b;
      for (let j = 0; j < 3; j++) M[i][j] += row[i] * row[j];
    }
  }
  const s = solve3(M, rhs);
  let cx = s ? s[0] : q.reduce((a, p) => a + p[0], 0) / n,
    cy = s ? s[1] : q.reduce((a, p) => a + p[1], 0) / n;
  for (let it = 0; it < 100; it++) {
    const d = q.map(([x, y]) => Math.hypot(x - cx, y - cy) || 1e-12);
    const R = d.reduce((a, b) => a + b, 0) / n;
    const ux = q.map(([x], i) => (x - cx) / d[i]),
      uy = q.map(([, y], i) => (y - cy) / d[i]);
    const mx = ux.reduce((a, b) => a + b, 0) / n,
      my = uy.reduce((a, b) => a + b, 0) / n;
    // J = [-(ux - mean ux), -(uy - mean uy)], residual d - R; normal equations
    let a11 = 0,
      a12 = 0,
      a22 = 0,
      b1 = 0,
      b2 = 0;
    for (let i = 0; i < n; i++) {
      const j1 = -(ux[i] - mx),
        j2 = -(uy[i] - my),
        r = d[i] - R;
      a11 += j1 * j1;
      a12 += j1 * j2;
      a22 += j2 * j2;
      b1 -= j1 * r;
      b2 -= j2 * r;
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-18) break;
    const dx = (b1 * a22 - b2 * a12) / det,
      dy = (a11 * b2 - a12 * b1) / det;
    cx += dx;
    cy += dy;
    if (Math.hypot(dx, dy) < 1e-12) break;
  }
  const r = q.reduce((a, [x, y]) => a + Math.hypot(x - cx, y - cy), 0) / n;
  return { cx, cy, r };
}

function solve3(A: number[][], b: number[]): number[] | null {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-15) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** Closest point to p on triangle abc. */
function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b),
    d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
  const cp = sub(p, c),
    d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, mul(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const den = 1 / (va + vb + vc);
  return add(a, add(mul(ab, vb * den), mul(ac, vc * den)));
}

/** The surface point straight above / below p along dir (nearest hit), or null when the line misses every face. */
export function rayOnSurface(m: MeshEdit, p: V3, dir: V3): V3 | null {
  let best: number | null = null;
  for (const f of m.faces) {
    if (f.verts.some((v) => m.hide[v])) continue;
    const a = m.p(f.verts[0]) as V3;
    for (let i = 1; i + 1 < f.verts.length; i++) {
      const b = m.p(f.verts[i]) as V3,
        c = m.p(f.verts[i + 1]) as V3;
      const e1 = sub(b, a),
        e2 = sub(c, a);
      const pv = cross(dir, e2);
      const det = dot(e1, pv);
      if (Math.abs(det) < 1e-12) continue;
      const tv = sub(p, a);
      const u = dot(tv, pv) / det;
      const qv = cross(tv, e1);
      const v = dot(dir, qv) / det;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
      const t = dot(e2, qv) / det;
      if (best === null || Math.abs(t) < Math.abs(best)) best = t;
    }
  }
  return best === null ? null : add(p, mul(dir, best));
}

/** Nearest point on the (fan-triangulated) faces of the mesh. */
export function nearestOnSurface(m: MeshEdit, p: V3): V3 {
  let best: V3 = p,
    bd = Infinity;
  for (const f of m.faces) {
    if (f.verts.some((v) => m.hide[v])) continue;
    const a = m.p(f.verts[0]) as V3;
    for (let i = 1; i + 1 < f.verts.length; i++) {
      const q = closestOnTriangle(p, a, m.p(f.verts[i]) as V3, m.p(f.verts[i + 1]) as V3);
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
  }
  return best;
}

export interface CircleOptions {
  factor: number;
  fit_method: 'LEAST_SQUARE' | 'CONTRACT';
  angle: number;
  use_custom_radius: boolean;
  custom_radius: number;
  regular: boolean;
  flatten: number;
  lock: [boolean, boolean, boolean];
}

/** Move each loop onto a circle in the loop's plane. Returns the number of loops shaped. */
export function circularize(m: MeshEdit, o: CircleOptions): number {
  const loops = selectedLoops(m).filter((l) => l.verts.length >= 3);
  const orig = m.clone();
  const moves = new Map<number, V3>();
  for (const loop of loops) {
    const P = loop.verts.map((v) => m.p(v) as V3);
    const n = P.length;
    const nrm = newellNormal(P);
    const c = mul(P.reduce(add, [0, 0, 0] as V3), 1 / n);
    const flat = P.map((p) => sub(p, mul(nrm, dot(sub(p, c), nrm))));
    let e1 = sub(flat[0], c);
    if (len(e1) < 1e-12) e1 = Math.abs(nrm[0]) < 0.9 ? cross(nrm, [1, 0, 0]) : cross(nrm, [0, 1, 0]);
    e1 = norm(e1);
    const e2 = cross(nrm, e1);
    const q = flat.map((p) => [dot(sub(p, c), e1), dot(sub(p, c), e2)] as [number, number]);
    let cx: number, cy: number, r: number;
    if (o.fit_method === 'CONTRACT') {
      // centre of the loop's edges (weighted by length), radius of the nearest vertex: vertices only move inwards
      let L = 0,
        wx = 0,
        wy = 0;
      for (let i = 0; i < (loop.closed ? n : n - 1); i++) {
        const a = q[i],
          b = q[(i + 1) % n];
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        L += l;
        wx += ((a[0] + b[0]) / 2) * l;
        wy += ((a[1] + b[1]) / 2) * l;
      }
      cx = L ? wx / L : 0;
      cy = L ? wy / L : 0;
      r = Math.min(...q.map(([x, y]) => Math.hypot(x - cx, y - cy)));
    } else ({ cx, cy, r } = fitCircle2D(q));
    if (o.use_custom_radius) r = o.custom_radius;
    // angles along the loop, unwrapped
    const th: number[] = [];
    q.forEach(([x, y], i) => {
      let a = Math.atan2(y - cy, x - cx);
      if (i) while (a - th[i - 1] > Math.PI) a -= 2 * Math.PI;
      if (i) while (a - th[i - 1] < -Math.PI) a += 2 * Math.PI;
      th.push(a);
    });
    if (o.regular) {
      const step = loop.closed ? (2 * Math.PI) / n : (th[n - 1] - th[0]) / (n - 1);
      let base = 0;
      th.forEach((a, i) => (base += a - i * step));
      base /= n;
      for (let i = 0; i < n; i++) th[i] = base + i * step;
    }
    loop.verts.forEach((v, i) => {
      const a = th[i] - o.angle;
      let p = add(c, add(mul(e1, cx + r * Math.cos(a)), mul(e2, cy + r * Math.sin(a))));
      // not flattened: towards the nearest point of the original surface
      if (o.flatten < 1) {
        const s = rayOnSurface(orig, p, nrm) ?? nearestOnSurface(orig, p);
        p = add(mul(s, 1 - o.flatten), mul(p, o.flatten));
      }
      moves.set(v, p);
    });
  }
  applyMoves(m, moves, o.factor, o.lock);
  return loops.length;
}

/** Move vertices to targets, blended by factor, keeping locked axes. */
function applyMoves(m: MeshEdit, moves: Map<number, V3>, factor: number, lock: [boolean, boolean, boolean]) {
  for (const [v, p] of moves) {
    const cur = m.p(v);
    const next = [0, 1, 2].map((k) => (lock[k] ? cur[k] : cur[k] + (p[k] - cur[k]) * factor));
    m.setP(v, next);
  }
  if (moves.size && m.keys.length) m.keys[0] = m.pos.slice();
}

export interface FlattenOptions {
  factor: number;
  method: 'BEST_FIT' | 'NORMAL' | 'VIEW';
  lock: [boolean, boolean, boolean];
  /** view direction (object space) for VIEW */
  view?: V3;
}

/** Plane through the centroid minimising the squared distances (smallest principal axis). */
export function bestFitNormal(P: V3[]): V3 {
  const n = P.length;
  const c = mul(P.reduce(add, [0, 0, 0] as V3), 1 / n);
  const C = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
  for (const p of P) {
    const d = sub(p, c);
    C[0] += d[0] * d[0];
    C[1] += d[0] * d[1];
    C[2] += d[0] * d[2];
    C[3] += d[1] * d[1];
    C[4] += d[1] * d[2];
    C[5] += d[2] * d[2];
  }
  const M = [
    [C[0], C[1], C[2]],
    [C[1], C[3], C[4]],
    [C[2], C[4], C[5]],
  ];
  // inverse iteration converges to the eigenvector of the smallest eigenvalue
  const tr = C[0] + C[3] + C[5];
  const shift = tr * 1e-9 + 1e-12;
  const A = M.map((row, i) => row.map((x, j) => x + (i === j ? shift : 0)));
  let v: V3 = [1, 1, 1];
  for (let it = 0; it < 64; it++) {
    const s = solve3(A, v);
    if (!s) break;
    const nv = norm(s as V3);
    if (Math.abs(Math.abs(dot(nv, v)) - 1) < 1e-15) {
      v = nv;
      break;
    }
    v = nv;
  }
  return norm(v);
}

/** Flatten the selected vertices onto a plane through their centroid. */
export function flattenSelection(m: MeshEdit, o: FlattenOptions): boolean {
  const verts = m.selectedVerts();
  if (verts.length < 3) return false;
  const P = verts.map((v) => m.p(v) as V3);
  const c = mul(P.reduce(add, [0, 0, 0] as V3), 1 / P.length);
  let n: V3;
  if (o.method === 'NORMAL') {
    // area-weighted normal of the selected faces (of the faces around the selection when none is selected)
    let faces = m.selectedFaces();
    if (!faces.length) {
      const s = new Set(verts);
      faces = m.faces.map((f, i) => (f.verts.some((v) => s.has(v)) ? i : -1)).filter((i) => i >= 0);
    }
    let sum: V3 = [0, 0, 0];
    for (const fi of faces) {
      const pts = m.faces[fi].verts.map((v) => m.p(v) as V3);
      let a: V3 = [0, 0, 0];
      for (let i = 0; i < pts.length; i++) a = add(a, cross(pts[i], pts[(i + 1) % pts.length]));
      sum = add(sum, a);
    }
    n = len(sum) > 1e-12 ? norm(sum) : bestFitNormal(P);
  } else if (o.method === 'VIEW' && o.view) n = norm(o.view);
  else n = bestFitNormal(P);
  const moves = new Map<number, V3>();
  verts.forEach((v, i) => moves.set(v, sub(P[i], mul(n, dot(sub(P[i], c), n)))));
  applyMoves(m, moves, o.factor, o.lock);
  return true;
}

/** Natural (open) or periodic (closed) cubic spline through values y at parameters t. */
export function cubicSpline(t: number[], y: number[], periodic: boolean): (x: number) => number {
  const n = t.length - 1;
  const h = Array.from({ length: n }, (_, i) => t[i + 1] - t[i] || 1e-12);
  let c: number[];
  if (periodic) {
    // y[n] repeats y[0]; unknowns c[0..n-1], c[n] = c[0]
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    const r = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const hp = h[(i - 1 + n) % n],
        hi = h[i];
      const yPrev = y[(i - 1 + n) % n];
      A[i][(i - 1 + n) % n] += hp;
      A[i][i] += 2 * (hp + hi);
      A[i][(i + 1) % n] += hi;
      r[i] = 3 * ((y[i + 1] - y[i]) / hi - (y[i] - yPrev) / hp);
    }
    c = [...solveN(A, r), 0];
    c[n] = c[0];
  } else {
    const A = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
    const r = new Array(n + 1).fill(0);
    A[0][0] = 1;
    A[n][n] = 1;
    for (let i = 1; i < n; i++) {
      A[i][i - 1] = h[i - 1];
      A[i][i] = 2 * (h[i - 1] + h[i]);
      A[i][i + 1] = h[i];
      r[i] = 3 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]);
    }
    c = solveN(A, r);
  }
  const b = h.map((hi, i) => (y[i + 1] - y[i]) / hi - (hi * (2 * c[i] + c[i + 1])) / 3);
  const d = h.map((hi, i) => (c[i + 1] - c[i]) / (3 * hi));
  return (x: number) => {
    let i = 0;
    while (i < n - 1 && x >= t[i + 1]) i++;
    const dx = x - t[i];
    return y[i] + b[i] * dx + c[i] * dx * dx + d[i] * dx * dx * dx;
  };
}

function solveN(A: number[][], b: number[]): number[] {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const piv = m[c][c] || 1e-18;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / piv;
      if (f) for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / (row[i] || 1e-18));
}

/** Respace the vertices of each selected loop at equal distances along it (cubic: along a smooth spline). */
export function spaceEvenly(m: MeshEdit, o: { factor: number; interpolation: 'CUBIC' | 'LINEAR'; lock: [boolean, boolean, boolean] }): number {
  const loops = selectedLoops(m).filter((l) => l.verts.length >= 3);
  const moves = new Map<number, V3>();
  for (const loop of loops) {
    const P = loop.verts.map((v) => m.p(v) as V3);
    if (loop.closed) P.push(P[0]);
    const t = [0];
    for (let i = 1; i < P.length; i++) t.push(t[i - 1] + len(sub(P[i], P[i - 1])));
    const L = t[t.length - 1];
    if (L <= 0) continue;
    const count = loop.verts.length;
    const at = (x: number): V3 => {
      if (o.interpolation === 'LINEAR') {
        let i = 0;
        while (i < P.length - 2 && x > t[i + 1]) i++;
        const s = (x - t[i]) / (t[i + 1] - t[i] || 1);
        return add(P[i], mul(sub(P[i + 1], P[i]), s));
      }
      return [0, 1, 2].map((k) => splines[k](x)) as V3;
    };
    const splines = o.interpolation === 'CUBIC' ? [0, 1, 2].map((k) => cubicSpline(t, P.map((p) => p[k]), loop.closed)) : [];
    loop.verts.forEach((v, i) => moves.set(v, at(loop.closed ? (L * i) / count : (L * i) / (count - 1))));
  }
  applyMoves(m, moves, o.factor, o.lock);
  return loops.length;
}

// ---------------------------------------------------------------------------
// operators

const lockProp: PropDef = { id: 'lock', label: 'Lock', type: 'bools', default: [false, false, false] };
const lockOf = (p: Record<string, unknown>) => (Array.isArray(p.lock) ? (p.lock as boolean[]).map(Boolean) : [false, false, false]) as [boolean, boolean, boolean];

registerOperators([
  {
    idname: 'mesh.circularize',
    label: 'To Circle',
    description: 'Shape the selected edge loops (or the boundary of the selected faces) into circles',
    props: [
      { id: 'factor', label: 'Factor', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' },
      {
        id: 'fit_method',
        label: 'Method',
        type: 'enum',
        default: 'LEAST_SQUARE',
        items: [
          ['LEAST_SQUARE', 'Best Fit', 'The circle closest to all vertices of the loop'],
          ['CONTRACT', 'Interior Fit', 'A circle inside the loop: vertices only move towards its centre'],
        ],
      },
      { id: 'angle', label: 'Rotation', type: 'float', default: 0, min: -2 * Math.PI, max: 2 * Math.PI, subtype: 'angle' },
      { id: 'use_custom_radius', label: 'Use Custom Radius', type: 'bool', default: false },
      { id: 'custom_radius', label: 'Radius', type: 'float', default: 1, min: 0, subtype: 'distance', showIf: (p) => !!p.use_custom_radius },
      { id: 'regular', label: 'Space Evenly', type: 'bool', default: true },
      { id: 'flatten', label: 'Flatten', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' },
      lockProp,
    ],
    poll: editPoll,
    exec: (_c, p) => {
      let n = 0;
      withEdit((m) => (n += circularize(m, { ...(p as unknown as CircleOptions), lock: lockOf(p) })) > 0);
      if (!n) {
        app.report('WARNING', 'Select one or more edge loops (or faces) to shape into circles');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'mesh.flatten',
    label: 'Flatten',
    description: 'Move the selected vertices onto one plane',
    props: [
      { id: 'factor', label: 'Factor', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' },
      {
        id: 'method',
        label: 'Method',
        type: 'enum',
        default: 'BEST_FIT',
        items: [
          ['BEST_FIT', 'Best Fit', 'The plane closest to all selected vertices'],
          ['NORMAL', 'Normal', 'The plane facing the average normal of the selected faces'],
          ['VIEW', 'View', 'The plane facing the view'],
        ],
      },
      lockProp,
    ],
    poll: editPoll,
    exec: (_c, p) => {
      const v = activeView3D();
      const viewDir = v ? new Vector3(0, 0, 1).applyQuaternion(v.camera.quaternion) : null;
      const ok = withEdit((m, ob) => {
        const view = viewDir ? (viewDir.clone().transformDirection(worldMatrix(ob).clone().invert()).toArray() as V3) : undefined;
        return flattenSelection(m, { factor: p.factor as number, method: p.method as FlattenOptions['method'], lock: lockOf(p), view });
      });
      if (!ok) {
        app.report('WARNING', 'Select at least three vertices to flatten');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'mesh.space_edge_loops_evenly',
    label: 'Space Edge Loops Evenly',
    description: 'Respace the vertices of the selected edge loops at equal distances along them',
    props: [
      { id: 'factor', label: 'Factor', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' },
      {
        id: 'interpolation',
        label: 'Interpolation',
        type: 'enum',
        default: 'CUBIC',
        items: [
          ['CUBIC', 'Cubic', 'Along a smooth curve through the vertices'],
          ['LINEAR', 'Linear', 'Along the existing edges'],
        ],
      },
      lockProp,
    ],
    poll: editPoll,
    exec: (_c, p) => {
      let n = 0;
      withEdit((m) => (n += spaceEvenly(m, { factor: p.factor as number, interpolation: p.interpolation as 'CUBIC', lock: lockOf(p) })) > 0);
      if (!n) {
        app.report('WARNING', 'Select one or more edge loops of at least three vertices');
        return 'CANCELLED';
      }
    },
  },
]);
