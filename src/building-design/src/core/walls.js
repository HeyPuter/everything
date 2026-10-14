/**
 * Wall joins. Walls on the same level whose ends meet are joined:
 *
 *   - Ends that meet at one point form a node. The walls are sorted by the
 *     direction they leave the node in, and each pair of neighbors meets
 *     where their facing sides intersect (a miter for two walls). Nodes of
 *     three or more walls also get a hub polygon that fills the middle.
 *   - An end that touches the middle of another wall butts against that
 *     wall's face (a T junction); the face line is interrupted there.
 *   - Any other end is square.
 *
 * The result per wall is its outline: left and right face lines, with the
 * corners the joins produced, plus intervals of each face to leave undrawn.
 * Parameters along a wall are distances from the start of its centerline.
 */
import { add, sub, scale, dot, cross, dist, perp, lineIntersect, closestOnSegment } from './geom.js';
import { wallAxis, verticalExtent } from './model.js';

const NODE_TOL = 2; // mm: ends closer than this share a node
const T_TOL = 2;

/**
 * Compute the joined outlines of a set of walls (normally one level).
 * Returns { walls: Map<id, WallGeom>, hubs: [{ poly, ids, base, top }] }.
 *
 * WallGeom: { id, axis, L0, L1, R0, R1, poly, ends: [EndInfo, EndInfo],
 *             cuts: { left: [[u0,u1]], right: [[u0,u1]] }, base, top }
 */
export function solveWalls(doc, walls) {
  const geoms = new Map();
  for (const w of walls) {
    const axis = wallAxis(doc, w);
    if (axis.length < 1) continue;
    const { base, top } = verticalExtent(doc, w);
    const h = axis.half;
    geoms.set(w.id, {
      id: w.id,
      wall: w,
      axis,
      base,
      top,
      L0: add(axis.a, scale(axis.n, h)),
      R0: add(axis.a, scale(axis.n, -h)),
      L1: add(axis.b, scale(axis.n, h)),
      R1: add(axis.b, scale(axis.n, -h)),
      ends: [{ kind: 'free' }, { kind: 'free' }],
      cuts: { left: [], right: [] },
      poly: null,
    });
  }

  // Nodes: cluster joinable ends by their location point.
  const grid = new Map();
  const cell = (p) => `${Math.floor(p[0] / 50)},${Math.floor(p[1] / 50)}`;
  const endsList = [];
  for (const g of geoms.values()) {
    const w = g.wall;
    for (let e = 0; e < 2; e++) {
      if ((e === 0 && w.joinA === false) || (e === 1 && w.joinB === false)) continue;
      const p = e === 0 ? w.a : w.b;
      const rec = { g, e, p, node: null };
      endsList.push(rec);
      const k = cell(p);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(rec);
    }
  }
  const nodes = [];
  for (const rec of endsList) {
    if (rec.node) continue;
    const node = { ends: [rec], p: rec.p };
    rec.node = node;
    const cx = Math.floor(rec.p[0] / 50);
    const cy = Math.floor(rec.p[1] / 50);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const list = grid.get(`${cx + i},${cy + j}`);
        if (!list) continue;
        for (const o of list) if (!o.node && dist(o.p, rec.p) <= NODE_TOL && o.g !== rec.g) {
          o.node = node;
          node.ends.push(o);
        }
      }
    nodes.push(node);
  }

  // Spatial index of walls for T junctions.
  const wallGrid = new Map();
  const WG = 2000;
  for (const g of geoms.values()) {
    const { a, b } = g.axis;
    const pad = g.axis.half + T_TOL;
    const x0 = Math.floor((Math.min(a[0], b[0]) - pad) / WG);
    const x1 = Math.floor((Math.max(a[0], b[0]) + pad) / WG);
    const y0 = Math.floor((Math.min(a[1], b[1]) - pad) / WG);
    const y1 = Math.floor((Math.max(a[1], b[1]) + pad) / WG);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        if (!wallGrid.has(k)) wallGrid.set(k, []);
        wallGrid.get(k).push(g);
      }
  }

  const hubs = [];
  for (const node of nodes) {
    if (node.ends.length === 1) {
      solveT(node.ends[0], wallGrid, WG);
      continue;
    }
    solveNode(node, hubs);
  }

  for (const g of geoms.values()) {
    g.poly = [g.R0, g.R1, g.L1, g.L0];
  }
  return { walls: geoms, hubs };
}

/** Direction leaving the node into the wall body, and the wall's side faces as lines. */
function endFrame(rec) {
  const ax = rec.g.axis;
  const out = rec.e === 0 ? ax.dir : scale(ax.dir, -1);
  const origin = rec.e === 0 ? ax.a : ax.b;
  return { out, origin, half: ax.half };
}

function solveNode(node, hubs) {
  const list = node.ends.map((rec) => {
    const f = endFrame(rec);
    return { rec, ...f, ang: Math.atan2(f.out[1], f.out[0]) };
  });
  list.sort((x, y) => x.ang - y.ang);
  const m = list.length;
  // Corner between each neighbor pair (i, i+1): the counterclockwise face of i
  // meets the clockwise face of i+1.
  const corners = [];
  for (let i = 0; i < m; i++) {
    const A = list[i];
    const B = list[(i + 1) % m];
    const pa = add(A.origin, scale(perp(A.out), A.half));
    const pb = add(B.origin, scale(perp(B.out), -B.half));
    let pt = null;
    const angle = Math.abs(cross(A.out, B.out));
    if (angle > 0.02) {
      const hit = lineIntersect(pa, A.out, pb, B.out);
      if (hit && dist(hit.point, node.p) < 12 * Math.max(A.half, B.half) + 10) pt = hit.point;
    }
    if (!pt) {
      // Nearly parallel neighbors: meet at the node on A's face.
      pt = pa;
      if (dot(A.out, B.out) > 0.99) pt = add(node.p, scale(perp(A.out), Math.max(A.half, B.half)));
    }
    corners.push(pt);
  }
  for (let i = 0; i < m; i++) {
    const it = list[i];
    const ccw = corners[i];
    const cw = corners[(i - 1 + m) % m];
    const g = it.rec.g;
    if (it.rec.e === 0) {
      g.L0 = ccw;
      g.R0 = cw;
    } else {
      g.R1 = ccw;
      g.L1 = cw;
    }
    g.ends[it.rec.e] = { kind: m === 2 ? 'corner' : 'hub', with: list.filter((x) => x !== it).map((x) => x.rec.g.id), angle: m === 2 ? Math.abs(cross(list[0].out, list[1].out)) : 1 };
  }
  if (m >= 3) {
    let base = Infinity;
    let top = -Infinity;
    for (const it of list) {
      base = Math.min(base, it.rec.g.base);
      top = Math.max(top, it.rec.g.top);
    }
    hubs.push({ poly: corners, ids: list.map((x) => x.rec.g.id), base, top });
  }
}

function solveT(rec, wallGrid, WG) {
  const p = rec.p;
  const g = rec.g;
  const k = `${Math.floor(p[0] / WG)},${Math.floor(p[1] / WG)}`;
  const cands = wallGrid.get(k);
  if (!cands) return;
  const { out } = endFrame(rec);
  let best = null;
  for (const h of cands) {
    if (h === g) continue;
    if (Math.abs(cross(out, h.axis.dir)) < 0.05) continue; // parallel: no butt join
    const cp = closestOnSegment(p, h.axis.a, h.axis.b);
    const along = cp.t * h.axis.length;
    if (along < 1 || along > h.axis.length - 1) continue;
    const d = dist(cp.point, p);
    if (d > h.axis.half + T_TOL) continue;
    if (!best || d < best.d) best = { h, d };
  }
  if (!best) return;
  const h = best.h;
  // The branch body lies on the side of the host that `out` points to.
  const side = dot(out, h.axis.n) >= 0 ? 1 : -1;
  const faceP = add(h.axis.a, scale(h.axis.n, side * h.axis.half));
  const ax = g.axis;
  const lp = rec.e === 0 ? g.L0 : g.L1;
  const rp = rec.e === 0 ? g.R0 : g.R1;
  const hl = lineIntersect(lp, ax.dir, faceP, h.axis.dir);
  const hr = lineIntersect(rp, ax.dir, faceP, h.axis.dir);
  if (!hl || !hr) return;
  if (rec.e === 0) {
    g.L0 = hl.point;
    g.R0 = hr.point;
  } else {
    g.L1 = hl.point;
    g.R1 = hr.point;
  }
  g.ends[rec.e] = { kind: 'tee', host: h.id, side };
  // Interrupt the host face where the branch meets it.
  const u0 = dot(sub(hl.point, h.axis.a), h.axis.dir);
  const u1 = dot(sub(hr.point, h.axis.a), h.axis.dir);
  (side > 0 ? h.cuts.left : h.cuts.right).push([Math.min(u0, u1), Math.max(u0, u1)]);
}

/** Parameter along the wall axis of a point. */
export function axisParam(axis, p) {
  return dot(sub(p, axis.a), axis.dir);
}

/** Point on a wall face at axis parameter u (side +1 left, -1 right). */
export function facePoint(axis, u, side) {
  return add(add(axis.a, scale(axis.dir, u)), scale(axis.n, side * axis.half));
}

/**
 * Per-level cache of solved wall joins. Invalidated when any wall, wall
 * type or level changes.
 */
export class WallSolver {
  constructor(doc) {
    this.doc = doc;
    this.cache = new Map();
  }

  invalidate(levelId) {
    if (levelId === undefined) this.cache.clear();
    else this.cache.delete(levelId);
  }

  level(levelId) {
    let r = this.cache.get(levelId);
    if (!r) {
      const walls = this.doc.all('wall').filter((w) => w.levelId === levelId);
      r = solveWalls(this.doc, walls);
      this.cache.set(levelId, r);
    }
    return r;
  }

  wall(id) {
    const w = this.doc.get(id);
    if (!w || w.kind !== 'wall') return null;
    return this.level(w.levelId).walls.get(id) ?? null;
  }
}
