// Sampled fields on a regular XY grid and the curves read from them:
// contours by marching squares (oriented with the inside on the left, with an
// optional exact refinement of each crossing), Euclidean distance transforms
// and polyline simplification.

export interface GridSpec {
  x0: number;
  y0: number;
  /** Node spacing. */
  c: number;
  nx: number;
  ny: number;
}

/** A polyline as x, y pairs (or x, y, z triples for 3D paths). */
export interface Polyline {
  pts: number[];
  closed: boolean;
}

export function gridOver(x0: number, y0: number, x1: number, y1: number, c: number, maxNodes = 600_000): GridSpec {
  let cell = c;
  const w = Math.max(x1 - x0, 1e-6), h = Math.max(y1 - y0, 1e-6);
  if ((w / cell + 1) * (h / cell + 1) > maxNodes) cell = Math.sqrt((w * h) / maxNodes) * 1.02;
  const nx = Math.max(2, Math.ceil(w / cell) + 1), ny = Math.max(2, Math.ceil(h / cell) + 1);
  return { x0, y0, c: cell, nx, ny };
}

/**
 * Contours where `v` crosses `level`, the region v >= level kept on the left.
 * `refine(ax, ay, bx, by, t)` may move a crossing found at fraction t of the
 * way from node a (inside) to node b (outside) and returns the new fraction.
 */
export function contours(g: GridSpec, v: ArrayLike<number>, level: number, refine?: (ax: number, ay: number, bx: number, by: number, t: number) => number): Polyline[] {
  const { nx, ny, x0, y0, c } = g;
  const inside = (i: number, j: number) => v[j * nx + i] >= level;
  // Edge ids: horizontal edge (i,j)-(i+1,j): j*(nx-1)+i; vertical (i,j)-(i,j+1): H + j*nx + i.
  const H = (nx - 1) * ny;
  const edgeCount = H + nx * (ny - 1);
  const px = new Float64Array(edgeCount), py = new Float64Array(edgeCount);
  const done = new Uint8Array(edgeCount);
  const point = (e: number) => {
    if (done[e]) return;
    done[e] = 1;
    let ai: number, aj: number, bi: number, bj: number;
    if (e < H) { aj = Math.floor(e / (nx - 1)); ai = e - aj * (nx - 1); bi = ai + 1; bj = aj; }
    else { const k = e - H; aj = Math.floor(k / nx); ai = k - aj * nx; bi = ai; bj = aj + 1; }
    let va = v[aj * nx + ai], vb = v[bj * nx + bi];
    // From the inside node to the outside one.
    if (va < level) { [ai, aj, bi, bj] = [bi, bj, ai, aj]; [va, vb] = [vb, va]; }
    let t = va === vb ? 0.5 : (va - level) / (va - vb);
    t = Math.max(0, Math.min(1, t));
    const ax = x0 + ai * c, ay = y0 + aj * c, bx = x0 + bi * c, by = y0 + bj * c;
    if (refine) t = Math.max(0, Math.min(1, refine(ax, ay, bx, by, t)));
    px[e] = ax + (bx - ax) * t;
    py[e] = ay + (by - ay) * t;
  };
  // next[e]: the edge the contour goes to after entering at edge e (-1 none).
  const next = new Int32Array(edgeCount).fill(-1);
  const hasPrev = new Uint8Array(edgeCount);
  const starts: number[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = inside(i, j), b = inside(i + 1, j), cc = inside(i + 1, j + 1), d = inside(i, j + 1);
      if (a === b && b === cc && cc === d) continue;
      // Corners and edges counter-clockwise: 00 -e0- 10 -e1- 11 -e2- 01 -e3- 00.
      const corners = [a, b, cc, d];
      const edges = [j * (nx - 1) + i, H + j * nx + i + 1, (j + 1) * (nx - 1) + i, H + j * nx + i];
      const crossing: { e: number; out: boolean }[] = [];
      for (let k = 0; k < 4; k++) {
        const p = corners[k], q = corners[(k + 1) % 4];
        if (p !== q) crossing.push({ e: edges[k], out: p });
      }
      let centerIn = true;
      if (crossing.length === 4) {
        const m = (v[j * nx + i] + v[j * nx + i + 1] + v[(j + 1) * nx + i + 1] + v[(j + 1) * nx + i]) / 4;
        centerIn = m >= level;
      }
      for (let k = 0; k < crossing.length; k++) {
        if (!crossing[k].out) continue;
        const to = crossing.length === 2 ? crossing[(k + 1) % 2] : crossing[centerIn ? (k + 1) % 4 : (k + 3) % 4];
        // Leaving across edge `from` into... the segment runs from the in->out edge to the out->in edge.
        const from = crossing[k].e;
        next[from] = to.e;
        hasPrev[to.e] = 1;
        starts.push(from);
      }
    }
  }
  const out: Polyline[] = [];
  const used = new Uint8Array(edgeCount);
  const trace = (s: number) => {
    const pts: number[] = [];
    let e = s;
    while (e >= 0 && !used[e]) {
      used[e] = 1;
      point(e);
      pts.push(px[e], py[e]);
      e = next[e];
    }
    const closed = e === s;
    if (pts.length >= 4) out.push({ pts, closed });
  };
  // Open chains first (they start on the border), then loops.
  for (const s of starts) if (!hasPrev[s] && !used[s]) trace(s);
  for (const s of starts) if (!used[s]) trace(s);
  return out;
}

const INF = 1e20;

/** Squared distance transform (in cells²) of the nodes where `feature` is set, to the nearest such node. */
export function edt(g: GridSpec, feature: (k: number) => boolean): Float64Array {
  const { nx, ny } = g;
  const d = new Float64Array(nx * ny);
  for (let k = 0; k < d.length; k++) d[k] = feature(k) ? 0 : INF;
  const n = Math.max(nx, ny);
  const f = new Float64Array(n), z = new Float64Array(n + 1), vv = new Int32Array(n), out = new Float64Array(n);
  const pass = (len: number, get: (i: number) => number, set: (i: number, x: number) => void) => {
    for (let i = 0; i < len; i++) f[i] = get(i);
    let k = 0;
    vv[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[vv[k]] + vv[k] * vv[k])) / (2 * q - 2 * vv[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[vv[k]] + vv[k] * vv[k])) / (2 * q - 2 * vv[k]);
      }
      k++;
      vv[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      out[q] = (q - vv[k]) * (q - vv[k]) + f[vv[k]];
    }
    for (let i = 0; i < len; i++) set(i, out[i]);
  };
  for (let i = 0; i < nx; i++) pass(ny, (j) => d[j * nx + i], (j, x) => { d[j * nx + i] = x; });
  for (let j = 0; j < ny; j++) pass(nx, (i) => d[j * nx + i], (i, x) => { d[j * nx + i] = x; });
  return d;
}

/**
 * Signed distance (model units) to the boundary of a region of nodes:
 * positive inside, negative outside, the boundary halfway between nodes.
 */
export function signedDistance(g: GridSpec, inside: Uint8Array): Float64Array {
  const dOut = edt(g, (k) => !inside[k]);
  const dIn = edt(g, (k) => !!inside[k]);
  const s = new Float64Array(inside.length);
  for (let k = 0; k < s.length; k++) s[k] = inside[k] ? (Math.sqrt(dOut[k]) - 0.5) * g.c : -(Math.sqrt(dIn[k]) - 0.5) * g.c;
  return s;
}

/** Bilinear sample of a node field at a point (clamped to the grid). */
export function sample(g: GridSpec, v: ArrayLike<number>, x: number, y: number): number {
  const fx = Math.max(0, Math.min(g.nx - 1.000001, (x - g.x0) / g.c));
  const fy = Math.max(0, Math.min(g.ny - 1.000001, (y - g.y0) / g.c));
  const i = Math.floor(fx), j = Math.floor(fy);
  const tx = fx - i, ty = fy - j;
  const k = j * g.nx + i;
  return (v[k] * (1 - tx) + v[k + 1] * tx) * (1 - ty) + (v[k + g.nx] * (1 - tx) + v[k + g.nx + 1] * tx) * ty;
}

/** Douglas-Peucker simplification of a polyline with `dim` numbers per point. */
export function simplify(pts: number[], tol: number, dim: 2 | 3 = 2, closed = false): number[] {
  const n = pts.length / dim;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  const dist2 = (p: number, a: number, b: number) => {
    let ab2 = 0, t = 0;
    for (let k = 0; k < dim; k++) { const e = pts[b * dim + k] - pts[a * dim + k]; ab2 += e * e; t += (pts[p * dim + k] - pts[a * dim + k]) * e; }
    t = ab2 > 0 ? Math.max(0, Math.min(1, t / ab2)) : 0;
    let d2 = 0;
    for (let k = 0; k < dim; k++) { const q = pts[a * dim + k] + (pts[b * dim + k] - pts[a * dim + k]) * t - pts[p * dim + k]; d2 += q * q; }
    return d2;
  };
  // Simplifies the run of points idx[0..] (indices into pts), marking those kept.
  const run = (idx: number[]) => {
    const tol2 = tol * tol;
    keep[idx[0]] = keep[idx[idx.length - 1]] = 1;
    const stack = [0, idx.length - 1];
    while (stack.length) {
      const e = stack.pop()!, s = stack.pop()!;
      let best = -1, bd = tol2;
      for (let p = s + 1; p < e; p++) { const d = dist2(idx[p], idx[s], idx[e]); if (d > bd) { bd = d; best = p; } }
      if (best >= 0) { keep[idx[best]] = 1; stack.push(s, best, best, e); }
    }
  };
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  if (closed) {
    // Split the loop at the point farthest from the first; the second half closes back to it.
    let far = 0, fd = -1;
    for (let p = 1; p < n; p++) { let d = 0; for (let k = 0; k < dim; k++) { const e = pts[p * dim + k] - pts[k]; d += e * e; } if (d > fd) { fd = d; far = p; } }
    run(range(0, far));
    run([...range(far, n - 1), 0]);
  } else run(range(0, n - 1));
  const out: number[] = [];
  for (let p = 0; p < n; p++) if (keep[p]) for (let k = 0; k < dim; k++) out.push(pts[p * dim + k]);
  return out;
}

/** Signed area of a closed 2D polyline (positive counter-clockwise). */
export function area(pts: number[]): number {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
  return a / 2;
}

export function pointInPolygon(pts: number[], x: number, y: number): boolean {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], yi = pts[i * 2 + 1], xj = pts[j * 2], yj = pts[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polyLength(pts: number[], dim: 2 | 3 = 2, closed = false): number {
  let l = 0;
  const n = pts.length / dim;
  for (let i = 1; i < n + (closed ? 1 : 0); i++) {
    const a = (i - 1) * dim, b = (i % n) * dim;
    let d = 0;
    for (let k = 0; k < dim; k++) { const e = pts[b + k] - pts[a + k]; d += e * e; }
    l += Math.sqrt(d);
  }
  return l;
}
