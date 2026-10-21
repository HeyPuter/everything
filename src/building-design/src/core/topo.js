/**
 * Topography: a ground surface through surveyed points [x, y, z]. The points
 * are triangulated (Delaunay, in plan); plans draw contour lines and 3D
 * views a solid of the given thickness under the surface.
 *
 *   topo { points: [[x, y, z]], thickness, contour, materialId }
 */

/** Delaunay triangulation of 2D points: array of [i, j, k] index triples. */
export function delaunay(pts) {
  const n = pts.length;
  if (n < 3) return [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  const d = Math.max(x1 - x0, y1 - y0) * 20 || 1;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  // A super triangle containing everything.
  const P = pts.map((p) => [p[0], p[1]]).concat([
    [cx - d, cy - d],
    [cx + d, cy - d],
    [cx, cy + d],
  ]);
  let tris = [[n, n + 1, n + 2]];
  const circum = (t) => {
    const [a, b, c] = t.map((i) => P[i]);
    const D = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(D) < 1e-12) return { x: 0, y: 0, r2: Infinity };
    const a2 = a[0] * a[0] + a[1] * a[1];
    const b2 = b[0] * b[0] + b[1] * b[1];
    const c2 = c[0] * c[0] + c[1] * c[1];
    const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / D;
    const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / D;
    return { x, y, r2: (a[0] - x) ** 2 + (a[1] - y) ** 2 };
  };
  let circles = tris.map(circum);
  for (let i = 0; i < n; i++) {
    const p = P[i];
    const bad = [];
    const keep = [];
    const keepC = [];
    tris.forEach((t, k) => {
      const c = circles[k];
      if ((p[0] - c.x) ** 2 + (p[1] - c.y) ** 2 < c.r2 * (1 - 1e-12)) bad.push(t);
      else {
        keep.push(t);
        keepC.push(c);
      }
    });
    // The hole's boundary: edges of bad triangles not shared by two of them.
    const edges = new Map();
    for (const t of bad)
      for (let e = 0; e < 3; e++) {
        const a = t[e];
        const b = t[(e + 1) % 3];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        edges.set(key, edges.has(key) ? null : [a, b]);
      }
    for (const e of edges.values()) {
      if (!e) continue;
      const t = [e[0], e[1], i];
      keep.push(t);
      keepC.push(circum(t));
    }
    tris = keep;
    circles = keepC;
  }
  return tris.filter((t) => t[0] < n && t[1] < n && t[2] < n);
}

/** Elevation of the surface at a plan point (null outside). */
export function topoHeightAt(topo, p, tris = delaunay(topo.points)) {
  const P = topo.points;
  for (const [i, j, k] of tris) {
    const a = P[i];
    const b = P[j];
    const c = P[k];
    const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(det) < 1e-9) continue;
    const l1 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / det;
    const l2 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / det;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return l1 * a[2] + l2 * b[2] + l3 * c[2];
  }
  return null;
}

/**
 * Contour segments at every multiple of `interval`:
 * [{ z, major, a: [x, y], b: [x, y] }]. Every fifth contour is major.
 */
export function contours(topo, interval, tris = delaunay(topo.points)) {
  const P = topo.points;
  const out = [];
  if (!(interval > 0)) return out;
  for (const [i, j, k] of tris) {
    const tri = [P[i], P[j], P[k]];
    const zs = tri.map((p) => p[2]);
    const lo = Math.ceil(Math.min(...zs) / interval);
    const hi = Math.floor(Math.max(...zs) / interval);
    for (let m = lo; m <= hi; m++) {
      const z = m * interval;
      const hits = [];
      for (let e = 0; e < 3; e++) {
        const a = tri[e];
        const b = tri[(e + 1) % 3];
        if ((a[2] - z) * (b[2] - z) < 0) {
          const t = (z - a[2]) / (b[2] - a[2]);
          hits.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
      }
      if (hits.length === 2) out.push({ z, major: m % 5 === 0, a: hits[0], b: hits[1] });
    }
  }
  return out;
}

/** Outline of the surface (convex hull of the points, counterclockwise). */
export function topoBoundary(topo) {
  const pts = topo.points.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** A rectangular site of points on a grid, gently sloped, to start from. */
export function sampleTopo(x0, y0, x1, y1, z0 = 0, rise = 0) {
  const pts = [];
  const nx = 5;
  const ny = 4;
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      const y = y0 + ((y1 - y0) * j) / ny;
      pts.push([x, y, Math.round(z0 + (rise * j) / ny)]);
    }
  return pts;
}
