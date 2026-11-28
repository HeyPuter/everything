// The part's boundary as the kernel triangulates it (a closed triangle mesh
// whose triangles know their B-rep face), indexed for the queries the mesher
// needs: which side of the boundary a point is on, where a segment crosses
// it, and the nearest point on it (on any face, on given faces, or on the
// edges between two faces).
//
// Inside tests count crossings of a ray along +x. They are exact in the sense
// that matters: a ray through a shared edge or vertex is counted once,
// because every edge function is evaluated with its end points in one
// canonical order (both triangles get the same number) and zeros are broken
// by a fixed rule (as if the ray were moved by an infinitesimal amount).

export interface FeaSurfaceData {
  /** xyz per vertex (a vertex may repeat, once per face it is on). */
  positions: Float32Array | Float64Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array | Int32Array;
  /** B-rep face index of each triangle. */
  triFace: Int32Array;
}

export interface ClosestHit {
  p: [number, number, number];
  tri: number;
  d2: number;
}

const EPS_AREA = 0;

export class SurfaceIndex {
  /** Welded vertices (exact coordinates), xyz. */
  readonly v: Float64Array;
  /** Triangles over welded vertices. */
  readonly t: Int32Array;
  readonly face: Int32Array;
  readonly nt: number;
  readonly min: [number, number, number] = [Infinity, Infinity, Infinity];
  readonly max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  /** Bins of triangles over (y, z) for rays along x. */
  private yz: { y0: number; z0: number; c: number; ny: number; nz: number; start: Int32Array; items: Int32Array };
  /** 3D bins of triangles for segment and nearest point queries. */
  private g: { o: [number, number, number]; c: number; n: [number, number, number]; start: Int32Array; items: Int32Array };
  /** Edges between faces: per face pair key, segments (welded vertex pairs). */
  private seams = new Map<string, number[]>();
  /** Welded vertices where three or more faces meet, with their faces. */
  readonly corners: { v: number; faces: number[] }[] = [];

  constructor(data: FeaSurfaceData) {
    const P = data.positions, I = data.indices;
    const key = new Map<string, number>();
    const remap = new Int32Array(P.length / 3);
    const vs: number[] = [];
    for (let i = 0; i < remap.length; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const k = `${x},${y},${z}`;
      let id = key.get(k);
      if (id === undefined) { id = vs.length / 3; key.set(k, id); vs.push(x, y, z); }
      remap[i] = id;
    }
    this.v = Float64Array.from(vs);
    // Triangles that collapse after welding have no area and carry nothing.
    const tris: number[] = [], faces: number[] = [];
    for (let k = 0; k < I.length / 3; k++) {
      const a = remap[I[k * 3]], b = remap[I[k * 3 + 1]], c = remap[I[k * 3 + 2]];
      if (a === b || b === c || a === c) continue;
      tris.push(a, b, c);
      faces.push(data.triFace[k]);
    }
    this.t = Int32Array.from(tris);
    this.face = Int32Array.from(faces);
    this.nt = faces.length;
    const V = this.v;
    for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) { this.min[k] = Math.min(this.min[k], V[i + k]); this.max[k] = Math.max(this.max[k], V[i + k]); }
    this.yz = this.buildYz();
    this.g = this.buildGrid();
    this.buildSeams();
  }

  get diag(): number {
    return Math.hypot(this.max[0] - this.min[0], this.max[1] - this.min[1], this.max[2] - this.min[2]);
  }

  /** Area of each face (by index, up to the largest index present). */
  faceAreas(): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.nt; k++) {
      const f = this.face[k];
      while (out.length <= f) out.push(0);
      out[f] += this.triArea(k);
    }
    return out;
  }

  triArea(k: number): number {
    const V = this.v, a = this.t[k * 3] * 3, b = this.t[k * 3 + 1] * 3, c = this.t[k * 3 + 2] * 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const wx = V[c] - V[a], wy = V[c + 1] - V[a + 1], wz = V[c + 2] - V[a + 2];
    return 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
  }

  /** Volume enclosed (divergence theorem; positive when the triangles face outward). */
  volume(): number {
    const V = this.v, T = this.t;
    let s = 0;
    for (let k = 0; k < this.nt; k++) {
      const a = T[k * 3] * 3, b = T[k * 3 + 1] * 3, c = T[k * 3 + 2] * 3;
      s += V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1]) - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c]) + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c]);
    }
    return s / 6;
  }

  // ---------- rays along x ----------

  private buildYz() {
    const V = this.v, T = this.t;
    const area = (this.max[1] - this.min[1]) * (this.max[2] - this.min[2]);
    const c = Math.max(Math.sqrt(Math.max(area, 1e-12) / Math.max(1, this.nt)) * 2, 1e-9);
    const ny = Math.max(1, Math.min(2048, Math.ceil((this.max[1] - this.min[1]) / c) + 1));
    const nz = Math.max(1, Math.min(2048, Math.ceil((this.max[2] - this.min[2]) / c) + 1));
    const cy = Math.max((this.max[1] - this.min[1]) / ny, 1e-12), cz = Math.max((this.max[2] - this.min[2]) / nz, 1e-12);
    const cc = Math.max(cy, cz);
    const y0 = this.min[1], z0 = this.min[2];
    const nY = Math.max(1, Math.ceil((this.max[1] - y0) / cc) + 1), nZ = Math.max(1, Math.ceil((this.max[2] - z0) / cc) + 1);
    const count = new Int32Array(nY * nZ + 1);
    const range = (k: number) => {
      let ya = Infinity, yb = -Infinity, za = Infinity, zb = -Infinity;
      for (let q = 0; q < 3; q++) { const i = T[k * 3 + q] * 3; ya = Math.min(ya, V[i + 1]); yb = Math.max(yb, V[i + 1]); za = Math.min(za, V[i + 2]); zb = Math.max(zb, V[i + 2]); }
      return [Math.max(0, Math.floor((ya - y0) / cc)), Math.min(nY - 1, Math.floor((yb - y0) / cc)), Math.max(0, Math.floor((za - z0) / cc)), Math.min(nZ - 1, Math.floor((zb - z0) / cc))];
    };
    for (let k = 0; k < this.nt; k++) {
      const [a, b, e, f] = range(k);
      for (let j = e; j <= f; j++) for (let i = a; i <= b; i++) count[j * nY + i + 1]++;
    }
    for (let i = 1; i < count.length; i++) count[i] += count[i - 1];
    const fill = count.slice();
    const items = new Int32Array(count[count.length - 1]);
    for (let k = 0; k < this.nt; k++) {
      const [a, b, e, f] = range(k);
      for (let j = e; j <= f; j++) for (let i = a; i <= b; i++) items[fill[j * nY + i]++] = k;
    }
    return { y0, z0, c: cc, ny: nY, nz: nZ, start: count, items };
  }

  /**
   * Edge function of welded vertices a, b at point (y, z) in the (y, z) projection,
   * evaluated with the end points in a fixed order so that both triangles on an edge agree.
   */
  private edgeFn(a: number, b: number, y: number, z: number): number {
    const V = this.v;
    if (a > b) return -this.edgeFn(b, a, y, z);
    const ay = V[a * 3 + 1], az = V[a * 3 + 2], by = V[b * 3 + 1], bz = V[b * 3 + 2];
    return (by - ay) * (z - az) - (bz - az) * (y - ay);
  }

  /** Whether an edge (a to b, the triangle on its left in (y, z)) owns points exactly on it. */
  private owns(a: number, b: number): boolean {
    const V = this.v;
    const dy = V[b * 3 + 1] - V[a * 3 + 1], dz = V[b * 3 + 2] - V[a * 3 + 2];
    return dz > 0 || (dz === 0 && dy < 0);
  }

  /**
   * Where the line {(t, y, z)} crosses the boundary: x values in increasing
   * order, with the triangle crossed. Triangles seen edge-on are not crossed.
   */
  xCrossings(y: number, z: number): { x: number[]; tri: number[] } {
    const g = this.yz;
    const i = Math.floor((y - g.y0) / g.c), j = Math.floor((z - g.z0) / g.c);
    const xs: number[] = [], ts: number[] = [];
    if (i < 0 || j < 0 || i >= g.ny || j >= g.nz) return { x: xs, tri: ts };
    const cell = j * g.ny + i;
    const T = this.t, V = this.v;
    for (let q = g.start[cell]; q < g.start[cell + 1]; q++) {
      const k = g.items[q];
      let a = T[k * 3], b = T[k * 3 + 1], c = T[k * 3 + 2];
      let o = this.edgeFn(a, b, V[c * 3 + 1], V[c * 3 + 2]);
      if (o === EPS_AREA) continue;
      if (o < 0) { const s = b; b = c; c = s; o = -o; }
      const w0 = this.edgeFn(b, c, y, z), w1 = this.edgeFn(c, a, y, z), w2 = this.edgeFn(a, b, y, z);
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      if ((w0 === 0 && !this.owns(b, c)) || (w1 === 0 && !this.owns(c, a)) || (w2 === 0 && !this.owns(a, b))) continue;
      const s = w0 + w1 + w2;
      if (!(s > 0)) continue;
      xs.push((w0 * V[a * 3] + w1 * V[b * 3] + w2 * V[c * 3]) / s);
      ts.push(k);
    }
    const order = xs.map((_, n) => n).sort((p, q) => xs[p] - xs[q]);
    return { x: order.map((n) => xs[n]), tri: order.map((n) => ts[n]) };
  }

  /** Whether a point is inside the closed boundary. */
  inside(p: ArrayLike<number>): boolean {
    const { x } = this.xCrossings(p[1], p[2]);
    let n = 0;
    for (const v of x) if (v > p[0]) n++;
    return (n & 1) === 1;
  }

  // ---------- 3D bins ----------

  private buildGrid() {
    const V = this.v, T = this.t;
    const ext = [this.max[0] - this.min[0], this.max[1] - this.min[1], this.max[2] - this.min[2]];
    // About two triangles per occupied cell, bounded in total.
    const avgEdge = Math.sqrt((this.faceAreas().reduce((a, b) => a + b, 0) / Math.max(1, this.nt)) * 2);
    let c = Math.max(avgEdge * 1.5, this.diag / 400, 1e-9);
    while ((ext[0] / c + 1) * (ext[1] / c + 1) * (ext[2] / c + 1) > 8e6) c *= 1.5;
    const o: [number, number, number] = [this.min[0] - c * 0.5, this.min[1] - c * 0.5, this.min[2] - c * 0.5];
    const n: [number, number, number] = [Math.ceil(ext[0] / c) + 2, Math.ceil(ext[1] / c) + 2, Math.ceil(ext[2] / c) + 2];
    const range = (k: number) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let q = 0; q < 3; q++) for (let d = 0; d < 3; d++) { const v = V[T[k * 3 + q] * 3 + d]; lo[d] = Math.min(lo[d], v); hi[d] = Math.max(hi[d], v); }
      return [0, 1, 2].flatMap((d) => [Math.max(0, Math.floor((lo[d] - o[d]) / c)), Math.min(n[d] - 1, Math.floor((hi[d] - o[d]) / c))]);
    };
    const count = new Int32Array(n[0] * n[1] * n[2] + 1);
    for (let k = 0; k < this.nt; k++) {
      const r = range(k);
      for (let z = r[4]; z <= r[5]; z++) for (let y = r[2]; y <= r[3]; y++) for (let x = r[0]; x <= r[1]; x++) count[(z * n[1] + y) * n[0] + x + 1]++;
    }
    for (let i = 1; i < count.length; i++) count[i] += count[i - 1];
    const fill = count.slice();
    const items = new Int32Array(count[count.length - 1]);
    for (let k = 0; k < this.nt; k++) {
      const r = range(k);
      for (let z = r[4]; z <= r[5]; z++) for (let y = r[2]; y <= r[3]; y++) for (let x = r[0]; x <= r[1]; x++) items[fill[(z * n[1] + y) * n[0] + x]++] = k;
    }
    return { o, c, n, start: count, items };
  }

  /** Calls fn with each triangle whose bins meet the box (a triangle may come more than once). */
  private eachNear(lo: ArrayLike<number>, hi: ArrayLike<number>, fn: (k: number) => void) {
    const g = this.g;
    const r = [0, 1, 2].flatMap((d) => [Math.max(0, Math.floor((lo[d] - g.o[d]) / g.c)), Math.min(g.n[d] - 1, Math.floor((hi[d] - g.o[d]) / g.c))]);
    for (let z = r[4]; z <= r[5]; z++) for (let y = r[2]; y <= r[3]; y++) for (let x = r[0]; x <= r[1]; x++) {
      const cell = (z * g.n[1] + y) * g.n[0] + x;
      for (let q = g.start[cell]; q < g.start[cell + 1]; q++) fn(g.items[q]);
    }
  }

  /**
   * Where the segment p-q crosses the boundary: the parameter t in (0, 1) and
   * the triangle, the crossing nearest to p; null when none is found.
   */
  segmentHit(p: ArrayLike<number>, q: ArrayLike<number>): { t: number; tri: number } | null {
    const lo = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])];
    const hi = [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])];
    const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
    const V = this.v, T = this.t;
    let best: { t: number; tri: number } | null = null;
    this.eachNear(lo, hi, (k) => {
      const a = T[k * 3] * 3, b = T[k * 3 + 1] * 3, c = T[k * 3 + 2] * 3;
      const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
      const e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det === 0) return;
      const inv = 1 / det;
      const sx = p[0] - V[a], sy = p[1] - V[a + 1], sz = p[2] - V[a + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < -1e-12 || u > 1 + 1e-12) return;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < -1e-12 || u + v > 1 + 1e-12) return;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t < 0 || t > 1) return;
      if (!best || t < best.t) best = { t, tri: k };
    });
    return best;
  }

  /** Nearest point of triangle k to p. */
  closestOnTri(k: number, p: ArrayLike<number>): [number, number, number] {
    const V = this.v, T = this.t;
    const a = T[k * 3] * 3, b = T[k * 3 + 1] * 3, c = T[k * 3 + 2] * 3;
    return closestOnTriangle(p, V[a], V[a + 1], V[a + 2], V[b], V[b + 1], V[b + 2], V[c], V[c + 1], V[c + 2]);
  }

  /**
   * Nearest point on the boundary within radius r of p (on the given faces
   * only, if any), or null when there is none that close.
   */
  closest(p: ArrayLike<number>, r: number, faces?: ReadonlySet<number> | null): ClosestHit | null {
    let best: ClosestHit | null = null;
    let lim = r * r;
    this.eachNear([p[0] - r, p[1] - r, p[2] - r], [p[0] + r, p[1] + r, p[2] + r], (k) => {
      if (faces && !faces.has(this.face[k])) return;
      const c = this.closestOnTri(k, p);
      const d2 = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
      if (d2 <= lim && (!best || d2 < best.d2)) { best = { p: c, tri: k, d2 }; lim = d2; }
    });
    return best;
  }

  // ---------- face boundaries ----------

  private buildSeams() {
    const T = this.t;
    const edgeFaces = new Map<number, number[]>();
    const nv = this.v.length / 3;
    const vertFaces: Set<number>[] = [];
    for (let k = 0; k < this.nt; k++) {
      for (let q = 0; q < 3; q++) {
        const a = T[k * 3 + q], b = T[k * 3 + (q + 1) % 3];
        const key = Math.min(a, b) * nv + Math.max(a, b);
        let l = edgeFaces.get(key);
        if (!l) edgeFaces.set(key, (l = []));
        l.push(this.face[k]);
        (vertFaces[a] ??= new Set()).add(this.face[k]);
      }
    }
    for (const [key, fs] of edgeFaces) {
      const uniq = [...new Set(fs)];
      if (uniq.length < 2) continue;
      const a = Math.floor(key / nv), b = key - a * nv;
      for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
        const pk = pairKey(uniq[i], uniq[j]);
        let l = this.seams.get(pk);
        if (!l) this.seams.set(pk, (l = []));
        l.push(a, b);
      }
    }
    vertFaces.forEach((s, v) => { if (s && s.size >= 3) this.corners.push({ v, faces: [...s] }); });
  }

  /** Whether faces a and b share an edge. */
  adjacent(a: number, b: number): boolean {
    return this.seams.has(pairKey(a, b));
  }

  /** Nearest point on the edge between faces a and b (squared distance), or null if they do not meet. */
  closestOnSeam(a: number, b: number, p: ArrayLike<number>): { p: [number, number, number]; d2: number } | null {
    const segs = this.seams.get(pairKey(a, b));
    if (!segs) return null;
    const V = this.v;
    let best: [number, number, number] | null = null, bd = Infinity;
    for (let i = 0; i < segs.length; i += 2) {
      const s = segs[i] * 3, e = segs[i + 1] * 3;
      const dx = V[e] - V[s], dy = V[e + 1] - V[s + 1], dz = V[e + 2] - V[s + 2];
      const l2 = dx * dx + dy * dy + dz * dz;
      let t = l2 > 0 ? ((p[0] - V[s]) * dx + (p[1] - V[s + 1]) * dy + (p[2] - V[s + 2]) * dz) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const c: [number, number, number] = [V[s] + dx * t, V[s + 1] + dy * t, V[s + 2] + dz * t];
      const d2 = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
      if (d2 < bd) { bd = d2; best = c; }
    }
    return best ? { p: best, d2: bd } : null;
  }

  vertex(i: number): [number, number, number] {
    return [this.v[i * 3], this.v[i * 3 + 1], this.v[i * 3 + 2]];
  }
}

const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Nearest point of triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestOnTriangle(p: ArrayLike<number>, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): [number, number, number] {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [ax, ay, az];
  const bpx = p[0] - bx, bpy = p[1] - by, bpz = p[2] - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [bx, by, bz];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [ax + abx * v, ay + aby * v, az + abz * v]; }
  const cpx = p[0] - cx, cpy = p[1] - cy, cpz = p[2] - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [cx, cy, cz];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [ax + acx * w, ay + acy * w, az + acz * w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w]; }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
}
