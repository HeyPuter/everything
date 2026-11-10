/**
 * Boundary detection for "pick an internal point" hatching.
 *
 * The candidate curves (already tessellated) are turned into a planar graph:
 * segments are split at every intersection, nearly coincident vertices are
 * merged, dangling edges and bridges are removed, and faces are traced with
 * half-edges. The smallest bounded face containing the pick point is the
 * outer boundary; closed components lying directly inside it are islands.
 */
import RBush from 'rbush';
import { pointInRing, ringArea } from './fill.js';

/**
 * Find the smallest closed region around (px, py).
 *
 *   curves        Array<{ pts: flat xy number[], closed: boolean }> in world
 *                 coordinates; they may cross, overlap and have loose ends
 *   opts.tol      vertex merge tolerance (default: 1e-9 of the extent)
 *   opts.gapTol   loose ends closer than this to another curve are bridged
 *                 (default 0: no gap closing)
 *
 * Returns { outer, islands } with flat xy rings (outer counter-clockwise,
 * islands clockwise), or null when the point is not enclosed.
 */
export function findBoundary(px, py, curves, opts = {}) {
  // Work relative to the pick point: the merge tolerance follows the size of
  // the coordinates, and far from the origin it would swallow small shapes
  // and close small gaps.
  if ((px !== 0 || py !== 0) && Number.isFinite(px) && Number.isFinite(py)) {
    const move = (pts, dx, dy) => {
      const out = new Array(pts.length);
      for (let i = 0; i + 1 < pts.length; i += 2) {
        out[i] = pts[i] + dx;
        out[i + 1] = pts[i + 1] + dy;
      }
      return out;
    };
    const near = (curves ?? []).map((c) => (c?.pts ? { pts: move(c.pts, -px, -py), closed: c.closed } : c));
    const r = findBoundary(0, 0, near, opts);
    return r && { outer: move(r.outer, px, py), islands: r.islands.map((i) => move(i, px, py)) };
  }
  const segs = [];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of curves ?? []) {
    const p = c?.pts;
    if (!p) continue;
    const n = p.length >> 1;
    const addSeg = (i, j) => {
      const ax = p[i * 2],
        ay = p[i * 2 + 1],
        bx = p[j * 2],
        by = p[j * 2 + 1];
      if (!Number.isFinite(ax + ay + bx + by) || (ax === bx && ay === by)) return;
      segs.push(ax, ay, bx, by);
      x0 = Math.min(x0, ax, bx);
      y0 = Math.min(y0, ay, by);
      x1 = Math.max(x1, ax, bx);
      y1 = Math.max(y1, ay, by);
    };
    for (let i = 0; i + 1 < n; i++) addSeg(i, i + 1);
    if (c.closed && n > 2) addSeg(n - 1, 0);
  }
  if (!segs.length) return null;
  if (px < x0 || px > x1 || py < y0 || py > y1) return null;
  const extent = Math.max(x1 - x0, y1 - y0, Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1));
  const tol = opts.tol > 0 ? opts.tol : Math.max(extent * 1e-9, 1e-12);
  const gapTol = opts.gapTol > 0 ? opts.gapTol : 0;

  let g = buildGraph(segs, tol);
  if (gapTol > tol) {
    const bridges = gapBridges(g, gapTol);
    if (bridges.length) g = buildGraph(segs.concat(bridges), tol);
  }
  prune(g);
  let faces = traceFaces(g);
  let removed = false;
  for (let e = 0; e < g.ne; e++) {
    if (g.alive[e] && faces.faceOf[e * 2] === faces.faceOf[e * 2 + 1]) {
      g.alive[e] = 0;
      removed = true;
    }
  }
  if (removed) {
    prune(g);
    faces = traceFaces(g);
  }

  // Smallest bounded face containing the point.
  let best = -1;
  for (let f = 0; f < faces.list.length; f++) {
    const F = faces.list[f];
    if (F.area <= 0) continue;
    if (best >= 0 && F.area >= faces.list[best].area) continue;
    const b = F.box;
    if (px < b[0] || px > b[2] || py < b[1] || py > b[3]) continue;
    if (pointInRing(px, py, F.ring) === 1) best = f;
  }
  if (best < 0) return null;
  const outerFace = faces.list[best];
  const outer = simplify(outerFace.ring, tol);

  // Islands: outer boundaries of other components inside the outer face.
  const comp = components(g);
  const outerComp = comp[outerFace.v0];
  const compOuter = new Map();
  for (const F of faces.list) {
    if (F.area >= 0) continue;
    const c = comp[F.v0];
    const prev = compOuter.get(c);
    if (!prev || F.area < prev.area) compOuter.set(c, F);
  }
  const ob = outerFace.box;
  const cands = [];
  for (const [c, F] of compOuter) {
    if (c === outerComp) continue;
    const b = F.box;
    if (b[0] < ob[0] || b[1] < ob[1] || b[2] > ob[2] || b[3] > ob[3]) continue;
    if (pointInRing(F.ring[0], F.ring[1], outerFace.ring) !== 1) continue;
    if (pointInRing(px, py, F.ring) === 1) continue;
    cands.push(F);
  }
  // Keep direct children only.
  cands.sort((a, b) => a.area - b.area);
  const islands = [];
  for (let i = 0; i < cands.length; i++) {
    const F = cands[i];
    let nested = false;
    for (let j = 0; j < i && !nested; j++) {
      const P = cands[j],
        b = P.box;
      if (F.box[0] < b[0] || F.box[1] < b[1] || F.box[2] > b[2] || F.box[3] > b[3]) continue;
      nested = pointInRing(F.ring[0], F.ring[1], P.ring) === 1;
    }
    if (!nested) islands.push(simplify(F.ring, tol));
  }
  return { outer, islands };
}

/** Hatch loops ([x, y, 0, ...], outer first) from a findBoundary result. */
export function toHatchLoops(result) {
  if (!result) return [];
  return [result.outer, ...result.islands].map((r) => {
    const out = [];
    for (let i = 0; i < r.length; i += 2) out.push(r[i], r[i + 1], 0);
    return out;
  });
}

/**
 * Split segments at mutual intersections, merge vertices within tol and
 * return the graph { xs, ys, ea, eb, alive, nv, ne }.
 */
function buildGraph(segs, tol) {
  const ns = segs.length >> 2;
  const items = new Array(ns);
  for (let i = 0; i < ns; i++) {
    const ax = segs[i * 4],
      ay = segs[i * 4 + 1],
      bx = segs[i * 4 + 2],
      by = segs[i * 4 + 3];
    items[i] = {
      minX: Math.min(ax, bx) - tol,
      minY: Math.min(ay, by) - tol,
      maxX: Math.max(ax, bx) + tol,
      maxY: Math.max(ay, by) + tol,
      i,
    };
  }
  const tree = new RBush();
  tree.load(items);
  const splits = new Array(ns).fill(null);
  const addSplit = (i, t, x, y) => {
    (splits[i] ??= []).push(t, x, y);
  };
  // Parameter of (x, y) projected onto segment i.
  const proj = (i, x, y) => {
    const ax = segs[i * 4],
      ay = segs[i * 4 + 1];
    const rx = segs[i * 4 + 2] - ax,
      ry = segs[i * 4 + 3] - ay;
    return ((x - ax) * rx + (y - ay) * ry) / (rx * rx + ry * ry);
  };
  // Split i at a point of another segment when it lies inside i.
  const splitAtPoint = (i, x, y, eps) => {
    const t = proj(i, x, y);
    if (t > eps && t < 1 - eps) addSplit(i, t, x, y);
  };

  for (let i = 0; i < ns; i++) {
    const it = items[i];
    const hits = tree.search(it);
    const ax = segs[i * 4],
      ay = segs[i * 4 + 1],
      rx = segs[i * 4 + 2] - ax,
      ry = segs[i * 4 + 3] - ay;
    const rl = Math.hypot(rx, ry);
    const ei = tol / rl;
    for (const h of hits) {
      const j = h.i;
      if (j <= i) continue;
      const cx = segs[j * 4],
        cy = segs[j * 4 + 1],
        sx = segs[j * 4 + 2] - cx,
        sy = segs[j * 4 + 3] - cy;
      const sl = Math.hypot(sx, sy);
      const ej = tol / sl;
      const den = rx * sy - ry * sx;
      const qx = cx - ax,
        qy = cy - ay;
      if (Math.abs(den) <= 1e-10 * rl * sl) {
        // Parallel: only collinear overlaps matter.
        if (Math.abs(qx * ry - qy * rx) / rl > tol) continue;
        splitAtPoint(i, cx, cy, ei);
        splitAtPoint(i, cx + sx, cy + sy, ei);
        splitAtPoint(j, ax, ay, ej);
        splitAtPoint(j, ax + rx, ay + ry, ej);
        continue;
      }
      const t = (qx * sy - qy * sx) / den;
      const u = (qx * ry - qy * rx) / den;
      if (t < -ei || t > 1 + ei || u < -ej || u > 1 + ej) continue;
      // Prefer an existing endpoint so T-junctions meet exactly.
      let x, y;
      if (Math.abs(u) <= ej) [x, y] = [cx, cy];
      else if (Math.abs(u - 1) <= ej) [x, y] = [cx + sx, cy + sy];
      else if (Math.abs(t) <= ei) [x, y] = [ax, ay];
      else if (Math.abs(t - 1) <= ei) [x, y] = [ax + rx, ay + ry];
      else [x, y] = [ax + t * rx, ay + t * ry];
      splitAtPoint(i, x, y, ei);
      splitAtPoint(j, x, y, ej);
    }
  }

  // Vertex merging on a hash grid: columns by cell x, each a map by cell y
  // (numeric keys: building a string key per probe dominated big drawings).
  const xs = [],
    ys = [];
  const cell = tol * 2;
  const grid = new Map();
  const vertex = (x, y) => {
    const gx = Math.floor(x / cell),
      gy = Math.floor(y / cell);
    for (let a = gx - 1; a <= gx + 1; a++) {
      const col = grid.get(a);
      if (!col) continue;
      for (let b = gy - 1; b <= gy + 1; b++) {
        const list = col.get(b);
        if (!list) continue;
        for (const v of list) if (Math.abs(xs[v] - x) <= tol && Math.abs(ys[v] - y) <= tol) return v;
      }
    }
    const v = xs.length;
    xs.push(x);
    ys.push(y);
    let col = grid.get(gx);
    if (!col) grid.set(gx, (col = new Map()));
    const list = col.get(gy);
    if (list) list.push(v);
    else col.set(gy, [v]);
    return v;
  };

  const ea = [],
    eb = [];
  const seen = new Set();
  const addEdge = (a, b) => {
    if (a === b) return;
    // Vertex ids stay far below 2^26, so the pair packs into one exact number.
    const key = a < b ? a * 67108864 + b : b * 67108864 + a;
    if (seen.has(key)) return;
    seen.add(key);
    ea.push(a);
    eb.push(b);
  };
  for (let i = 0; i < ns; i++) {
    let prev = vertex(segs[i * 4], segs[i * 4 + 1]);
    const sp = splits[i];
    if (sp) {
      const idx = [];
      for (let k = 0; k < sp.length; k += 3) idx.push(k);
      idx.sort((p, q) => sp[p] - sp[q]);
      for (const k of idx) {
        const v = vertex(sp[k + 1], sp[k + 2]);
        addEdge(prev, v);
        prev = v;
      }
    }
    addEdge(prev, vertex(segs[i * 4 + 2], segs[i * 4 + 3]));
  }
  return { xs, ys, ea, eb, alive: new Uint8Array(ea.length).fill(1), nv: xs.length, ne: ea.length };
}

/** Vertex degrees over alive edges. */
function degrees(g) {
  const deg = new Int32Array(g.nv);
  for (let e = 0; e < g.ne; e++) {
    if (!g.alive[e]) continue;
    deg[g.ea[e]]++;
    deg[g.eb[e]]++;
  }
  return deg;
}

/** Remove dangling edges until every vertex has degree 0 or >= 2. */
function prune(g) {
  const deg = degrees(g);
  const inc = incidence(g);
  const stack = [];
  for (let v = 0; v < g.nv; v++) if (deg[v] === 1) stack.push(v);
  while (stack.length) {
    const v = stack.pop();
    if (deg[v] !== 1) continue;
    for (const e of inc[v]) {
      if (!g.alive[e]) continue;
      g.alive[e] = 0;
      const w = g.ea[e] === v ? g.eb[e] : g.ea[e];
      deg[v]--;
      deg[w]--;
      if (deg[w] === 1) stack.push(w);
      break;
    }
  }
}

/** Alive edge ids per vertex. */
function incidence(g) {
  const inc = Array.from({ length: g.nv }, () => []);
  for (let e = 0; e < g.ne; e++) {
    if (!g.alive[e]) continue;
    inc[g.ea[e]].push(e);
    inc[g.eb[e]].push(e);
  }
  return inc;
}

/**
 * Bridge segments from loose ends to the nearest other loose end, or else
 * the nearest point on a non-incident edge, within gapTol.
 */
function gapBridges(g, gapTol) {
  const deg = degrees(g);
  const ends = [];
  for (let v = 0; v < g.nv; v++) if (deg[v] === 1) ends.push(v);
  if (!ends.length) return [];
  const inc = incidence(g);
  const endTree = new RBush();
  endTree.load(ends.map((v) => ({ minX: g.xs[v], minY: g.ys[v], maxX: g.xs[v], maxY: g.ys[v], v })));
  const edgeTree = new RBush();
  const edgeItems = [];
  for (let e = 0; e < g.ne; e++) {
    if (!g.alive[e]) continue;
    const a = g.ea[e],
      b = g.eb[e];
    edgeItems.push({
      minX: Math.min(g.xs[a], g.xs[b]),
      minY: Math.min(g.ys[a], g.ys[b]),
      maxX: Math.max(g.xs[a], g.xs[b]),
      maxY: Math.max(g.ys[a], g.ys[b]),
      e,
    });
  }
  edgeTree.load(edgeItems);
  const out = [];
  for (const v of ends) {
    const x = g.xs[v],
      y = g.ys[v];
    const box = { minX: x - gapTol, minY: y - gapTol, maxX: x + gapTol, maxY: y + gapTol };
    const own = inc[v][0];
    const nb = g.ea[own] === v ? g.eb[own] : g.ea[own];
    let bd = gapTol,
      bx = 0,
      by = 0,
      found = false;
    for (const it of endTree.search(box)) {
      if (it.v === v || it.v === nb) continue;
      const d = Math.hypot(g.xs[it.v] - x, g.ys[it.v] - y);
      if (d <= bd) {
        bd = d;
        bx = g.xs[it.v];
        by = g.ys[it.v];
        found = true;
      }
    }
    if (!found) {
      for (const it of edgeTree.search(box)) {
        const e = it.e;
        if (g.ea[e] === v || g.eb[e] === v) continue;
        const ax = g.xs[g.ea[e]],
          ay = g.ys[g.ea[e]];
        const ex = g.xs[g.eb[e]] - ax,
          ey = g.ys[g.eb[e]] - ay;
        const l2 = ex * ex + ey * ey;
        let t = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * ex,
          qy = ay + t * ey;
        const d = Math.hypot(qx - x, qy - y);
        if (d <= bd) {
          bd = d;
          bx = qx;
          by = qy;
          found = true;
        }
      }
    }
    if (found && bd > 0) out.push(x, y, bx, by);
  }
  return out;
}

/**
 * Trace faces with half-edges (2e: ea to eb, 2e + 1: eb to ea). At each
 * vertex the walk takes the next edge clockwise from the one it arrived
 * along, so bounded faces come out counter-clockwise (positive area) and
 * the outside of each component clockwise (negative area).
 */
function traceFaces(g) {
  const out = Array.from({ length: g.nv }, () => []);
  for (let e = 0; e < g.ne; e++) {
    if (!g.alive[e]) continue;
    out[g.ea[e]].push(e * 2);
    out[g.eb[e]].push(e * 2 + 1);
  }
  const from = (h) => (h & 1 ? g.eb[h >> 1] : g.ea[h >> 1]);
  const to = (h) => (h & 1 ? g.ea[h >> 1] : g.eb[h >> 1]);
  const pos = new Int32Array(g.ne * 2);
  for (let v = 0; v < g.nv; v++) {
    const list = out[v];
    if (list.length < 2) continue;
    const ang = new Map();
    for (const h of list) {
      const w = to(h);
      ang.set(h, Math.atan2(g.ys[w] - g.ys[v], g.xs[w] - g.xs[v]));
    }
    list.sort((a, b) => ang.get(a) - ang.get(b));
    for (let i = 0; i < list.length; i++) pos[list[i]] = i;
  }
  const faceOf = new Int32Array(g.ne * 2).fill(-1);
  const list = [];
  for (let e = 0; e < g.ne; e++) {
    if (!g.alive[e]) continue;
    for (const h0 of [e * 2, e * 2 + 1]) {
      if (faceOf[h0] >= 0) continue;
      const id = list.length;
      const ring = [];
      let h = h0;
      let guard = g.ne * 2 + 2;
      do {
        faceOf[h] = id;
        const v = from(h);
        ring.push(g.xs[v], g.ys[v]);
        const w = to(h);
        const around = out[w];
        const tw = h ^ 1;
        h = around[(pos[tw] - 1 + around.length) % around.length];
      } while (h !== h0 && --guard > 0);
      let bx0 = Infinity,
        by0 = Infinity,
        bx1 = -Infinity,
        by1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        if (ring[i] < bx0) bx0 = ring[i];
        if (ring[i] > bx1) bx1 = ring[i];
        if (ring[i + 1] < by0) by0 = ring[i + 1];
        if (ring[i + 1] > by1) by1 = ring[i + 1];
      }
      list.push({ ring, area: ringArea(ring), box: [bx0, by0, bx1, by1], v0: from(h0) });
    }
  }
  return { list, faceOf };
}

/** Connected component id per vertex over alive edges. */
function components(g) {
  const parent = new Int32Array(g.nv);
  for (let i = 0; i < g.nv; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let e = 0; e < g.ne; e++) {
    if (!g.alive[e]) continue;
    const a = find(g.ea[e]),
      b = find(g.eb[e]);
    if (a !== b) parent[a] = b;
  }
  const comp = new Int32Array(g.nv);
  for (let i = 0; i < g.nv; i++) comp[i] = find(i);
  return comp;
}

/** Drop vertices that lie on the straight line through their neighbours. */
function simplify(ring, tol) {
  const n = ring.length >> 1;
  if (n <= 3) return ring.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n,
      q = (i + 1) % n;
    const ax = ring[p * 2],
      ay = ring[p * 2 + 1];
    const x = ring[i * 2],
      y = ring[i * 2 + 1];
    const bx = ring[q * 2],
      by = ring[q * 2 + 1];
    const ex = bx - ax,
      ey = by - ay;
    const len = Math.hypot(ex, ey);
    const dist = len > 0 ? Math.abs((x - ax) * ey - (y - ay) * ex) / len : Infinity;
    const between = (x - ax) * ex + (y - ay) * ey > 0 && (bx - x) * ex + (by - y) * ey > 0;
    if (dist <= tol && between) continue;
    out.push(x, y);
  }
  return out.length >= 6 ? out : ring.slice();
}
