// Quad remeshing (pure): the surface is first rebuilt as even triangles of a target edge length
// (split long edges, collapse short ones, flip edges towards valence 6, relax in the tangent plane and
// project back onto the original surface, keeping boundaries and sharp features on their lines). Pairs
// of triangles then become quads, and one split step turns every quad into four and every left-over
// triangle into three, so the result is made of quads only; a last relaxation evens them out.

export interface QuadRemeshOptions {
  /** wanted number of quads in the result */
  targetFaces: number;
  /** keep edges sharper than this angle (radians) as feature lines; 0 = off */
  sharpAngle: number;
  /** extra feature edges (vertex pairs of the input) */
  sharpEdges?: [number, number][];
  /** remeshing rounds */
  iterations?: number;
  seed?: number;
}

export interface QuadRemeshResult {
  positions: Float32Array;
  /** 4 vertex indices per quad */
  quads: Uint32Array;
}

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V): V => mul(a, 1 / (len(a) || 1));
const ekey = (a: number, b: number) => (a < b ? a * 0x200000 + b : b * 0x200000 + a);

// ---------------------------------------------------------------------------
// the original surface: triangles in a uniform grid for nearest-point queries

function closestOnTri(p: V, a: V, b: V, c: V): V {
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

function closestOnSeg(p: V, a: V, b: V): V {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return add(a, mul(ab, t));
}

class Surface {
  private cells = new Map<string, number[]>();
  private segCells = new Map<string, number[]>();
  constructor(
    private P: V[],
    private T: number[],
    private segs: [number, number][],
    private cell: number,
  ) {
    for (let t = 0; t < T.length / 3; t++) this.insert(this.cells, [P[T[t * 3]], P[T[t * 3 + 1]], P[T[t * 3 + 2]]], t);
    segs.forEach(([a, b], i) => this.insert(this.segCells, [P[a], P[b]], i));
  }
  private key(x: number, y: number, z: number) {
    return `${x},${y},${z}`;
  }
  private insert(map: Map<string, number[]>, pts: V[], id: number) {
    const c = this.cell;
    const lo = [0, 1, 2].map((k) => Math.floor(Math.min(...pts.map((p) => p[k])) / c));
    const hi = [0, 1, 2].map((k) => Math.floor(Math.max(...pts.map((p) => p[k])) / c));
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) {
          const k = this.key(x, y, z);
          const l = map.get(k);
          if (l) l.push(id);
          else map.set(k, [id]);
        }
  }
  private search(map: Map<string, number[]>, p: V, test: (id: number) => [number, V]): V | null {
    const c = this.cell;
    const ci = p.map((x) => Math.floor(x / c));
    let best: V | null = null,
      bd = Infinity;
    const seen = new Set<number>();
    for (let r = 0; r <= 6; r++) {
      for (let x = ci[0] - r; x <= ci[0] + r; x++)
        for (let y = ci[1] - r; y <= ci[1] + r; y++)
          for (let z = ci[2] - r; z <= ci[2] + r; z++) {
            if (Math.max(Math.abs(x - ci[0]), Math.abs(y - ci[1]), Math.abs(z - ci[2])) !== r) continue;
            for (const id of map.get(this.key(x, y, z)) ?? []) {
              if (seen.has(id)) continue;
              seen.add(id);
              const [d, q] = test(id);
              if (d < bd) {
                bd = d;
                best = q;
              }
            }
          }
      // anything found within the searched shell is final once the shell is farther than it
      if (best && Math.sqrt(bd) <= r * c) break;
    }
    return best;
  }
  nearest(p: V): V {
    const { P, T } = this;
    return (
      this.search(this.cells, p, (t) => {
        const q = closestOnTri(p, P[T[t * 3]], P[T[t * 3 + 1]], P[T[t * 3 + 2]]);
        const d = sub(q, p);
        return [dot(d, d), q];
      }) ?? p
    );
  }
  nearestFeature(p: V): V {
    if (!this.segs.length) return this.nearest(p);
    return (
      this.search(this.segCells, p, (i) => {
        const q = closestOnSeg(p, this.P[this.segs[i][0]], this.P[this.segs[i][1]]);
        const d = sub(q, p);
        return [dot(d, d), q];
      }) ?? p
    );
  }
}

// ---------------------------------------------------------------------------
// the working triangle mesh

class Tris {
  P: V[];
  T: number[]; // 3 per triangle, -1 = deleted
  /** per vertex: on a boundary / feature line (moves along it), corner (fixed) */
  vflag: Uint8Array;
  feat = new Set<number>(); // feature edges (ekey)
  constructor(P: V[], T: number[]) {
    this.P = P;
    this.T = T;
    this.vflag = new Uint8Array(P.length);
  }
  tri(t: number): [number, number, number] {
    return [this.T[t * 3], this.T[t * 3 + 1], this.T[t * 3 + 2]];
  }
  get count() {
    return this.T.length / 3;
  }
  /** edge → triangles, vertex → triangles */
  adjacency() {
    const edges = new Map<number, number[]>();
    const vt: number[][] = Array.from({ length: this.P.length }, () => []);
    for (let t = 0; t < this.count; t++) {
      if (this.T[t * 3] < 0) continue;
      const v = this.tri(t);
      for (let i = 0; i < 3; i++) {
        const k = ekey(v[i], v[(i + 1) % 3]);
        const l = edges.get(k);
        if (l) l.push(t);
        else edges.set(k, [t]);
        vt[v[i]].push(t);
      }
    }
    return { edges, vt };
  }
  normal(t: number): V {
    const [a, b, c] = this.tri(t);
    return cross(sub(this.P[b], this.P[a]), sub(this.P[c], this.P[a]));
  }
}

const FEATURE = 1,
  CORNER = 2;

/** Mark boundary / sharp / non-manifold edges as features; vertices with ≠ 2 feature edges are corners. */
function classify(m: Tris, sharpCos: number, extra: Set<number>) {
  const { edges } = m.adjacency();
  m.feat.clear();
  for (const [k, ts] of edges) {
    let f = ts.length !== 2 || extra.has(k);
    if (!f && sharpCos < 1) {
      const n0 = norm(m.normal(ts[0])),
        n1 = norm(m.normal(ts[1]));
      f = dot(n0, n1) < sharpCos;
    }
    if (f) m.feat.add(k);
  }
  const fcount = new Uint16Array(m.P.length);
  for (const k of m.feat) {
    fcount[Math.floor(k / 0x200000)]++;
    fcount[k % 0x200000]++;
  }
  m.vflag = new Uint8Array(m.P.length);
  for (let v = 0; v < m.P.length; v++) m.vflag[v] = fcount[v] === 0 ? 0 : fcount[v] === 2 ? FEATURE : CORNER;
}

function splitLong(m: Tris, maxLen: number): number {
  let done = 0;
  for (let sweep = 0; sweep < 8; sweep++) {
    const { edges } = m.adjacency();
    const long: [number, number][] = [];
    for (const k of edges.keys()) {
      const a = Math.floor(k / 0x200000),
        b = k % 0x200000;
      const l = len(sub(m.P[a], m.P[b]));
      if (l > maxLen) long.push([k, l]);
    }
    if (!long.length) break;
    long.sort((x, y) => y[1] - x[1]);
    const touched = new Set<number>();
    let n = 0;
    for (const [k] of long) {
      const ts = edges.get(k)!;
      if (ts.some((t) => touched.has(t))) continue;
      const a = Math.floor(k / 0x200000),
        b = k % 0x200000;
      const mid = m.P.length;
      m.P.push(mul(add(m.P[a], m.P[b]), 0.5));
      const f = m.feat.has(k);
      if (f) {
        m.feat.delete(k);
        m.feat.add(ekey(a, mid));
        m.feat.add(ekey(mid, b));
      }
      const vf = new Uint8Array(m.P.length);
      vf.set(m.vflag);
      vf[mid] = f ? FEATURE : 0;
      m.vflag = vf;
      for (const t of ts) {
        touched.add(t);
        const v = m.tri(t);
        // the triangle (a, b, c) becomes (a, mid, c) and (mid, b, c) keeping its winding
        const i = v.findIndex((x, j) => (x === a && v[(j + 1) % 3] === b) || (x === b && v[(j + 1) % 3] === a));
        const p = v[i],
          q = v[(i + 1) % 3],
          r = v[(i + 2) % 3];
        m.T[t * 3] = p;
        m.T[t * 3 + 1] = mid;
        m.T[t * 3 + 2] = r;
        m.T.push(mid, q, r);
        touched.add(m.count - 1);
      }
      n++;
    }
    done += n;
    if (!n) break;
  }
  return done;
}

function collapseShort(m: Tris, minLen: number, maxLen: number): number {
  let done = 0;
  for (let sweep = 0; sweep < 8; sweep++) {
    const { edges, vt } = m.adjacency();
    const short: [number, number][] = [];
    for (const k of edges.keys()) {
      const a = Math.floor(k / 0x200000),
        b = k % 0x200000;
      const l = len(sub(m.P[a], m.P[b]));
      if (l < minLen) short.push([k, l]);
    }
    if (!short.length) break;
    short.sort((x, y) => x[1] - y[1]);
    const locked = new Set<number>();
    let n = 0;
    for (const [k] of short) {
      let a = Math.floor(k / 0x200000),
        b = k % 0x200000;
      if (locked.has(a) || locked.has(b)) continue;
      const fa = m.vflag[a],
        fb = m.vflag[b];
      // corners stay; two feature vertices only merge along their own feature edge
      if (fa === CORNER && fb === CORNER) continue;
      if (fa && fb && !m.feat.has(k)) continue;
      // b goes into a: keep the more constrained vertex
      if (fb > fa) [a, b] = [b, a];
      const both = m.vflag[a] === m.vflag[b];
      const target: V = both && m.vflag[a] !== CORNER ? mul(add(m.P[a], m.P[b]), 0.5) : m.vflag[a] ? m.P[a] : mul(add(m.P[a], m.P[b]), 0.5);
      const ta = vt[a].filter((t) => m.T[t * 3] >= 0),
        tb = vt[b].filter((t) => m.T[t * 3] >= 0);
      // link condition: a and b share exactly the vertices opposite to their edge
      const na = new Set(ta.flatMap((t) => m.tri(t))),
        nb = new Set(tb.flatMap((t) => m.tri(t)));
      const common = [...na].filter((x) => nb.has(x) && x !== a && x !== b);
      const shared = (edges.get(k) ?? []).length;
      if (common.length !== shared) continue;
      // no long edges and no flipped triangles afterwards
      let ok = true;
      for (const t of [...ta, ...tb]) {
        const v = m.tri(t);
        if (v.includes(a) && v.includes(b)) continue;
        const nv = v.map((x) => (x === b ? a : x)) as [number, number, number];
        const pts = nv.map((x) => (x === a ? target : m.P[x]));
        for (let i = 0; i < 3; i++) if (len(sub(pts[i], pts[(i + 1) % 3])) > maxLen) ok = false;
        const n0 = m.normal(t);
        const n1 = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
        if (dot(norm(n0), norm(n1)) < 0.2) ok = false;
        if (!ok) break;
      }
      if (!ok) continue;
      m.P[a] = target;
      for (const t of tb) {
        const v = m.tri(t);
        if (v.includes(a)) {
          m.T[t * 3] = m.T[t * 3 + 1] = m.T[t * 3 + 2] = -1;
          continue;
        }
        for (let i = 0; i < 3; i++) if (m.T[t * 3 + i] === b) m.T[t * 3 + i] = a;
      }
      // feature edges of b now run from a
      for (const fk of [...m.feat]) {
        const x = Math.floor(fk / 0x200000),
          y = fk % 0x200000;
        if (x === b || y === b) {
          m.feat.delete(fk);
          const o = x === b ? y : x;
          if (o !== a) m.feat.add(ekey(a, o));
        }
      }
      for (const v of na) locked.add(v);
      for (const v of nb) locked.add(v);
      n++;
    }
    done += n;
    if (!n) break;
  }
  return done;
}

function flipEdges(m: Tris): number {
  const { edges } = m.adjacency();
  const valence = new Int32Array(m.P.length);
  for (const k of edges.keys()) {
    valence[Math.floor(k / 0x200000)]++;
    valence[k % 0x200000]++;
  }
  const target = (v: number) => (m.vflag[v] ? 4 : 6);
  const touched = new Set<number>();
  let n = 0;
  for (const [k, ts] of edges) {
    if (ts.length !== 2 || m.feat.has(k) || ts.some((t) => touched.has(t))) continue;
    const a = Math.floor(k / 0x200000),
      b = k % 0x200000;
    const t0 = m.tri(ts[0]),
      t1 = m.tri(ts[1]);
    const c = t0.find((x) => x !== a && x !== b)!,
      d = t1.find((x) => x !== a && x !== b)!;
    if (c === d || edges.has(ekey(c, d))) continue;
    const dev = (va: number, vb: number, vc: number, vd: number) => Math.abs(va - target(a)) + Math.abs(vb - target(b)) + Math.abs(vc - target(c)) + Math.abs(vd - target(d));
    const before = dev(valence[a], valence[b], valence[c], valence[d]);
    const after = dev(valence[a] - 1, valence[b] - 1, valence[c] + 1, valence[d] + 1);
    if (after >= before) continue;
    // keep the winding: t0 runs a→b (or b→a); the new triangles share c–d
    const i0 = t0.indexOf(a),
      forward = t0[(i0 + 1) % 3] === b;
    const [p, q] = forward ? [a, b] : [b, a];
    const n1: [number, number, number] = [p, d, c],
      n2: [number, number, number] = [q, c, d];
    const nrm = norm(add(m.normal(ts[0]), m.normal(ts[1])));
    const ok = [n1, n2].every((tv) => dot(norm(cross(sub(m.P[tv[1]], m.P[tv[0]]), sub(m.P[tv[2]], m.P[tv[0]]))), nrm) > 0.3);
    if (!ok) continue;
    m.T.splice(ts[0] * 3, 3, ...n1);
    m.T.splice(ts[1] * 3, 3, ...n2);
    valence[a]--;
    valence[b]--;
    valence[c]++;
    valence[d]++;
    touched.add(ts[0]).add(ts[1]);
    n++;
  }
  return n;
}

/** Move vertices towards the centre of their neighbours along the surface, then back onto it. */
function relax(m: { P: V[]; vflag: Uint8Array }, nbrs: number[][], featNbrs: number[][], normals: V[], surf: Surface, amount: number) {
  const next = m.P.map((p) => [...p] as V);
  for (let v = 0; v < m.P.length; v++) {
    const f = m.vflag[v];
    if (f === CORNER) continue;
    const ns = f ? featNbrs[v] : nbrs[v];
    if (!ns || ns.length < 2) continue;
    let c: V = [0, 0, 0];
    for (const w of ns) c = add(c, m.P[w]);
    c = mul(c, 1 / ns.length);
    let d = sub(c, m.P[v]);
    if (!f) d = sub(d, mul(normals[v], dot(d, normals[v])));
    const p = add(m.P[v], mul(d, amount));
    next[v] = f ? surf.nearestFeature(p) : surf.nearest(p);
  }
  m.P = next;
}

function neighbourLists(nv: number, faces: number[][], feat?: Set<number>) {
  const nb: Set<number>[] = Array.from({ length: nv }, () => new Set());
  const fn: Set<number>[] = Array.from({ length: nv }, () => new Set());
  for (const f of faces)
    for (let i = 0; i < f.length; i++) {
      const a = f[i],
        b = f[(i + 1) % f.length];
      if (a < 0 || b < 0) continue;
      nb[a].add(b);
      nb[b].add(a);
      if (feat?.has(ekey(a, b))) {
        fn[a].add(b);
        fn[b].add(a);
      }
    }
  return { nbrs: nb.map((s) => [...s]), featNbrs: fn.map((s) => [...s]) };
}

function vertexNormals(P: V[], faces: number[][]): V[] {
  const n: V[] = P.map(() => [0, 0, 0]);
  for (const f of faces) {
    if (f[0] < 0) continue;
    let fn: V = [0, 0, 0];
    for (let i = 0; i < f.length; i++) fn = add(fn, cross(P[f[i]], P[f[(i + 1) % f.length]]));
    for (const v of f) n[v] = add(n[v], fn);
  }
  return n.map(norm);
}

/** Quad quality of the triangles pair (a, b, c) + (b, a, d) as quad (a, d, b, c): 1 = square corners. */
function quadQuality(P: V[], q: number[]): number {
  let worst = 1;
  for (let i = 0; i < 4; i++) {
    const p = P[q[i]],
      a = norm(sub(P[q[(i + 3) % 4]], p)),
      b = norm(sub(P[q[(i + 1) % 4]], p));
    worst = Math.min(worst, 1 - Math.abs(dot(a, b)));
  }
  return worst;
}

export function quadRemesh(positions: ArrayLike<number>, faces: number[][], o: QuadRemeshOptions): QuadRemeshResult {
  // input as triangles
  const P0: V[] = [];
  for (let i = 0; i < positions.length; i += 3) P0.push([positions[i], positions[i + 1], positions[i + 2]]);
  const T0: number[] = [];
  for (const f of faces) for (let i = 1; i + 1 < f.length; i++) T0.push(f[0], f[i], f[i + 1]);
  let area = 0;
  for (let t = 0; t < T0.length; t += 3) area += len(cross(sub(P0[T0[t + 1]], P0[T0[t]]), sub(P0[T0[t + 2]], P0[T0[t]]))) / 2;
  if (!T0.length || area <= 0) return { positions: new Float32Array(0), quads: new Uint32Array(0) };
  const target = Math.max(4, o.targetFaces);
  // final quads ≈ 2 × base triangles, each base triangle about equilateral
  const L = Math.sqrt((8 * area) / (Math.sqrt(3) * target));
  const sharpCos = o.sharpAngle > 0 ? Math.cos(o.sharpAngle) : 1;
  const extra = new Set((o.sharpEdges ?? []).map(([a, b]) => ekey(a, b)));
  const m = new Tris(P0.map((p) => [...p] as V), [...T0]);
  classify(m, sharpCos, extra);
  const featSegs = [...m.feat].map((k) => [Math.floor(k / 0x200000), k % 0x200000] as [number, number]);
  const surf = new Surface(P0, T0, featSegs, Math.max(L * 2, Math.sqrt(area / Math.max(1, T0.length / 3)) * 2));
  const iters = o.iterations ?? 8;
  for (let it = 0; it < iters; it++) {
    splitLong(m, (4 / 3) * L);
    collapseShort(m, (4 / 5) * L, (4 / 3) * L);
    for (let k = 0; k < 2; k++) if (!flipEdges(m)) break;
    const tris = Array.from({ length: m.count }, (_, t) => m.tri(t)).filter((t) => t[0] >= 0);
    const { nbrs, featNbrs } = neighbourLists(m.P.length, tris, m.feat);
    relax(m, nbrs, featNbrs, vertexNormals(m.P, tris), surf, 0.5);
  }
  // compact
  const alive = Array.from({ length: m.count }, (_, t) => m.tri(t)).filter((t) => t[0] >= 0);
  const used = new Int32Array(m.P.length).fill(-1);
  const P: V[] = [];
  const vflag: number[] = [];
  for (const t of alive)
    for (const v of t)
      if (used[v] < 0) {
        used[v] = P.length;
        P.push(m.P[v]);
        vflag.push(m.vflag[v]);
      }
  const tris = alive.map((t) => t.map((v) => used[v]) as [number, number, number]);
  const feat = new Set<number>();
  for (const k of m.feat) {
    const a = used[Math.floor(k / 0x200000)],
      b = used[k % 0x200000];
    if (a >= 0 && b >= 0) feat.add(ekey(a, b));
  }
  // pair triangles into quads, best shaped first
  const edgeTris = new Map<number, number[]>();
  tris.forEach((t, ti) => {
    for (let i = 0; i < 3; i++) {
      const k = ekey(t[i], t[(i + 1) % 3]);
      const l = edgeTris.get(k);
      if (l) l.push(ti);
      else edgeTris.set(k, [ti]);
    }
  });
  const cands: [number, number, number, number[]][] = [];
  // the seed varies the choice between equally good pairings
  let rs = ((o.seed ?? 0) * 2654435761 + 1) >>> 0 || 1;
  const jitter = () => {
    rs ^= rs << 13;
    rs ^= rs >>> 17;
    rs ^= rs << 5;
    return ((rs >>> 0) / 4294967296) * (o.seed ? 0.05 : 0);
  };
  for (const [k, ts] of edgeTris) {
    if (ts.length !== 2 || feat.has(k)) continue;
    const a = Math.floor(k / 0x200000),
      b = k % 0x200000;
    const t0 = tris[ts[0]],
      t1 = tris[ts[1]];
    const i = t0.indexOf(a);
    const [p, q] = t0[(i + 1) % 3] === b ? [a, b] : [b, a];
    const c = t0.find((x) => x !== a && x !== b)!,
      d = t1.find((x) => x !== a && x !== b)!;
    // t0 runs p→q→c; the quad keeps that winding: p, d, q, c
    const quad = [p, d, q, c];
    cands.push([quadQuality(P, quad) + jitter(), ts[0], ts[1], quad]);
  }
  cands.sort((x, y) => y[0] - x[0]);
  const paired = new Uint8Array(tris.length);
  const polys: number[][] = [];
  for (const [qual, t0, t1, quad] of cands) {
    if (qual < 0.25 || paired[t0] || paired[t1]) continue;
    paired[t0] = paired[t1] = 1;
    polys.push(quad);
  }
  tris.forEach((t, ti) => !paired[ti] && polys.push([...t]));
  // one split: n-gon → n quads around its centre
  const mids = new Map<number, number>();
  const out: number[][] = [];
  const fv: number[] = [...vflag];
  const featOut = new Set<number>();
  const mid = (a: number, b: number) => {
    const k = ekey(a, b);
    let v = mids.get(k);
    if (v === undefined) {
      v = P.length;
      P.push(mul(add(P[a], P[b]), 0.5));
      fv.push(feat.has(k) ? FEATURE : 0);
      if (feat.has(k)) featOut.add(ekey(a, v)).add(ekey(v, b));
      mids.set(k, v);
    }
    return v;
  };
  for (const f of polys) {
    const c = P.length;
    P.push(mul(f.reduce((s, v) => add(s, P[v]), [0, 0, 0] as V), 1 / f.length));
    fv.push(0);
    const ms = f.map((v, i) => mid(v, f[(i + 1) % f.length]));
    f.forEach((v, i) => out.push([v, ms[i], c, ms[(i + f.length - 1) % f.length]]));
  }
  // even the quads out on the surface
  const state = { P, vflag: Uint8Array.from(fv) };
  for (let it = 0; it < 3; it++) {
    const { nbrs, featNbrs } = neighbourLists(P.length, out, featOut);
    relax(state, nbrs, featNbrs, vertexNormals(state.P, out), surf, 0.5);
  }
  return { positions: Float32Array.from(state.P.flat()), quads: Uint32Array.from(out.flat()) };
}
