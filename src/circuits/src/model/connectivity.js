// Board copper connectivity: which copper items touch, the islands each net
// forms, and the ratsnest (shortest set of unrouted connections joining the
// islands of every net, a minimum spanning tree).

import RBush from 'rbush';
import { distSegSeg, distPointSeg, pointInPoly, rectCorners, arcToPoints, circleToPoly } from '../core/geom.js';
import { placeFootprint } from './place.js';
import { copperLayers, isCopper } from './layers.js';

/** Converts a pad to a polygon (rounded corners approximated). */
export function padPolygon(p) {
  if (p.shape === 'round') return circleToPoly(p.x, p.y, p.w / 2, Math.max(1000, p.w / 200));
  if (p.shape === 'rect') return rectCorners(p.x, p.y, p.w, p.h, p.rot || 0);
  const r = p.shape === 'oval' ? Math.min(p.w, p.h) / 2 : Math.min(p.w, p.h) * (p.radius ?? 0.25);
  if (r <= 0) return rectCorners(p.x, p.y, p.w, p.h, p.rot || 0);
  const hw = p.w / 2 - r, hh = p.h / 2 - r;
  const out = [];
  const corners = [[hw, -hh, 270], [hw, hh, 0], [-hw, hh, 90], [-hw, -hh, 180]];
  const c = Math.cos(((p.rot || 0) * Math.PI) / 180), s = Math.sin(((p.rot || 0) * Math.PI) / 180);
  for (const [cx, cy, a0] of corners) {
    const arc = arcToPoints(cx, cy, r, a0, 90, Math.max(1000, r / 50));
    for (let i = 0; i < arc.length; i += 2) out.push(p.x + arc[i] * c - arc[i + 1] * s, p.y + arc[i] * s + arc[i + 1] * c);
  }
  return out;
}

/**
 * Collects copper items from a board.
 * Each item: { id, objId, kind:'seg'|'disc'|'poly', layers:string[], net, ... , anchor:[x,y][] , isPad }
 */
export function copperItems(board, objects, lib, pourFills) {
  const count = board.copper || 2;
  const all = copperLayers(count);
  const items = [];
  for (const o of objects) {
    switch (o.t) {
      case 'comp': {
        const pl = placeFootprint(lib[o.comp], o, count);
        for (const p of pl.pads) {
          const layers = p.layers.copper.filter((l) => all.includes(l));
          if (!layers.length || (p.side === 'thru' && p.plated === false && p.w <= (p.drill || 0))) continue;
          const base = { objId: o.id, layers, net: p.net || '', isPad: true, pad: p, ref: o.designator, anchors: [[p.x, p.y]] };
          if (p.shape === 'round') items.push({ ...base, kind: 'disc', x: p.x, y: p.y, r: p.w / 2 });
          else items.push({ ...base, kind: 'poly', pts: padPolygon(p) });
        }
        break;
      }
      case 'pad': {
        const layers = o.side === 'thru' ? all : [o.side];
        const base = { objId: o.id, layers, net: o.net || '', isPad: true, pad: o, anchors: [[o.x, o.y]] };
        if (o.shape === 'round') items.push({ ...base, kind: 'disc', x: o.x, y: o.y, r: o.w / 2 });
        else items.push({ ...base, kind: 'poly', pts: padPolygon(o) });
        break;
      }
      case 'track':
        if (isCopper(o.layer) && all.includes(o.layer)) items.push({ objId: o.id, kind: 'seg', layers: [o.layer], net: o.net || '', x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, r: o.w / 2, anchors: [[o.x1, o.y1], [o.x2, o.y2]] });
        break;
      case 'arc':
        if (isCopper(o.layer) && all.includes(o.layer)) {
          const pts = arcToPoints(o.cx, o.cy, o.r, o.a0, o.sweep, 2000);
          for (let i = 2; i < pts.length; i += 2) items.push({ objId: o.id, kind: 'seg', layers: [o.layer], net: o.net || '', x1: pts[i - 2], y1: pts[i - 1], x2: pts[i], y2: pts[i + 1], r: o.w / 2, anchors: i === 2 ? [[pts[0], pts[1]]] : i === pts.length - 2 ? [[pts[i], pts[i + 1]]] : [] });
        }
        break;
      case 'via': {
        const a = all.indexOf(o.from), b = all.indexOf(o.to);
        const layers = a >= 0 && b >= 0 ? all.slice(Math.min(a, b), Math.max(a, b) + 1) : all;
        items.push({ objId: o.id, kind: 'disc', layers, net: o.net || '', x: o.x, y: o.y, r: o.d / 2, anchors: [[o.x, o.y]] });
        break;
      }
      case 'fill':
        if (isCopper(o.layer) && all.includes(o.layer)) items.push({ objId: o.id, kind: 'poly', layers: [o.layer], net: o.net || '', pts: [o.x1, o.y1, o.x2, o.y1, o.x2, o.y2, o.x1, o.y2], anchors: [[(o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2]] });
        break;
      case 'region':
        if (isCopper(o.layer) && all.includes(o.layer)) items.push({ objId: o.id, kind: 'poly', layers: [o.layer], net: o.net || '', pts: o.pts, anchors: [[o.pts[0], o.pts[1]]] });
        break;
      case 'pour': {
        const fills = pourFills?.get(o.id);
        if (!fills || !isCopper(o.layer)) break;
        for (const poly of fills) {
          if (!poly[0] || poly[0].length < 6) continue;
          items.push({ objId: o.id, kind: 'poly', layers: [o.layer], net: o.net || '', pts: poly[0], holes: poly.slice(1), anchors: [], pour: true });
        }
        break;
      }
      default:
    }
  }
  items.forEach((it, i) => { it.id = i; it.box = itemBox(it); });
  return items;
}

function itemBox(it) {
  if (it.kind === 'seg') return { minX: Math.min(it.x1, it.x2) - it.r, minY: Math.min(it.y1, it.y2) - it.r, maxX: Math.max(it.x1, it.x2) + it.r, maxY: Math.max(it.y1, it.y2) + it.r };
  if (it.kind === 'disc') return { minX: it.x - it.r, minY: it.y - it.r, maxX: it.x + it.r, maxY: it.y + it.r };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < it.pts.length; i += 2) {
    const x = it.pts[i], y = it.pts[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function polyEdgesDist(pts, fn) {
  let d = Infinity;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    d = Math.min(d, fn(pts[j], pts[j + 1], pts[i], pts[i + 1]));
    if (d <= 0) return 0;
  }
  return d;
}

const ringBoxCache = new WeakMap();
function ringBox(pts) {
  let b = ringBoxCache.get(pts);
  if (!b) {
    b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < b.minX) b.minX = pts[i];
      if (pts[i] > b.maxX) b.maxX = pts[i];
      if (pts[i + 1] < b.minY) b.minY = pts[i + 1];
      if (pts[i + 1] > b.maxY) b.maxY = pts[i + 1];
    }
    ringBoxCache.set(pts, b);
  }
  return b;
}

// Holes of a pour fill, indexed by box once (a large pour has thousands).
const holeIndexCache = new WeakMap();
function holesNear(holes, box) {
  if (!holes?.length) return [];
  if (holes.length <= 16) return holes.filter((h) => h.length >= 6 && boxGap(ringBox(h), box) === 0);
  let tree = holeIndexCache.get(holes);
  if (!tree) {
    tree = new RBush(16);
    tree.load(holes.filter((h) => h.length >= 6).map((h) => ({ ...ringBox(h), h })));
    holeIndexCache.set(holes, tree);
  }
  return tree.search(box).map((e) => e.h);
}

function insideHoles(x, y, holes) {
  for (const h of holesNear(holes, { minX: x, minY: y, maxX: x, maxY: y })) if (pointInPoly(x, y, h)) return true;
  return false;
}

const boxGap = (a, b) => Math.hypot(Math.max(a.minX - b.maxX, b.minX - a.maxX, 0), Math.max(a.minY - b.maxY, b.minY - a.maxY, 0));

/**
 * Smallest fn(edge) over every ring of a polygon item: its outline and its
 * holes. A hole's edge is copper too (the inside of a pour clearance or a
 * thermal gap). Rings whose box is farther from `near` than the best so far
 * are skipped.
 */
function ringsEdgesDist(it, near, fn) {
  let d = Infinity;
  // Holes around the item first: they usually decide (thermal gaps, clearances).
  const touching = holesNear(it.holes, near);
  for (const h of touching) {
    d = Math.min(d, polyEdgesDist(h, fn));
    if (d <= 0) return 0;
  }
  d = Math.min(d, polyEdgesDist(it.pts, fn));
  if (d <= 0 || !it.holes?.length) return d;
  const reach = { minX: near.minX - d, minY: near.minY - d, maxX: near.maxX + d, maxY: near.maxY + d };
  for (const h of holesNear(it.holes, reach)) {
    if (touching.includes(h) || boxGap(ringBox(h), near) >= d) continue;
    d = Math.min(d, polyEdgesDist(h, fn));
    if (d <= 0) return 0;
  }
  return d;
}

/** Edge-to-edge distance between two copper items (<= 0 when touching). */
export function itemDistance(a, b) {
  if (a.kind === 'poly' && b.kind !== 'poly') return itemDistance(b, a);
  if (a.kind === 'disc' && b.kind === 'seg') return itemDistance(b, a);
  if (a.kind === 'seg') {
    if (b.kind === 'seg') return distSegSeg(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2) - a.r - b.r;
    if (b.kind === 'disc') return distPointSeg(b.x, b.y, a.x1, a.y1, a.x2, a.y2) - a.r - b.r;
    // seg vs poly
    if ((pointInPoly(a.x1, a.y1, b.pts) && !insideHoles(a.x1, a.y1, b.holes)) || (pointInPoly(a.x2, a.y2, b.pts) && !insideHoles(a.x2, a.y2, b.holes))) return -1;
    const near = { minX: Math.min(a.x1, a.x2), minY: Math.min(a.y1, a.y2), maxX: Math.max(a.x1, a.x2), maxY: Math.max(a.y1, a.y2) };
    return ringsEdgesDist(b, near, (x1, y1, x2, y2) => distSegSeg(a.x1, a.y1, a.x2, a.y2, x1, y1, x2, y2)) - a.r;
  }
  if (a.kind === 'disc') {
    if (b.kind === 'disc') return Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
    if (pointInPoly(a.x, a.y, b.pts) && !insideHoles(a.x, a.y, b.holes)) return -1;
    const near = { minX: a.x, minY: a.y, maxX: a.x, maxY: a.y };
    return ringsEdgesDist(b, near, (x1, y1, x2, y2) => distPointSeg(a.x, a.y, x1, y1, x2, y2)) - a.r;
  }
  // poly vs poly
  for (let i = 0; i < a.pts.length; i += 2) if (pointInPoly(a.pts[i], a.pts[i + 1], b.pts) && !insideHoles(a.pts[i], a.pts[i + 1], b.holes)) return -1;
  for (let i = 0; i < b.pts.length; i += 2) if (pointInPoly(b.pts[i], b.pts[i + 1], a.pts) && !insideHoles(b.pts[i], b.pts[i + 1], a.holes)) return -1;
  // Edges of every ring: a pad whose corners sit in a pour's thermal gaps
  // still meets the pour's copper along the gap (hole) edges.
  let d = Infinity;
  for (const ra of a.holes ? [a.pts, ...a.holes] : [a.pts]) {
    if (ra.length < 6) continue;
    const near = ringBox(ra);
    d = Math.min(d, ringsEdgesDist(b, near, (x1, y1, x2, y2) => polyEdgesDist(ra, (x3, y3, x4, y4) => distSegSeg(x1, y1, x2, y2, x3, y3, x4, y4))));
    if (d <= 0) return 0;
  }
  return d;
}

const sharesLayer = (a, b) => a.layers.some((l) => b.layers.includes(l));

class DSU {
  constructor(n) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
  find(a) { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[Math.max(a, b)] = Math.min(a, b); return a !== b; }
}

/**
 * Analyses board connectivity.
 * Returns { items, islandOf (item index -> root), ratsnest: [{net,x1,y1,x2,y2}],
 *   unrouted: Map<net, count>, shorts: [{a, b, x, y}], netItems: Map<net, objIds Set> }
 */
export function analyseBoard(boardDoc, objects, lib, { pourFills } = {}) {
  const items = copperItems(boardDoc.board, objects, lib, pourFills);
  const tree = new RBush(16);
  tree.load(items.map((it) => ({ ...it.box, it })));
  const dsu = new DSU(items.length);
  const shorts = [];
  const shortSeen = new Set();
  for (const a of items) {
    for (const { it: b } of tree.search(a.box)) {
      if (b.id <= a.id || !sharesLayer(a, b)) continue;
      // Pads of one component never short each other through the footprint itself.
      if (a.isPad && b.isPad && a.objId === b.objId && a.pad.num === b.pad.num) { dsu.union(a.id, b.id); continue; }
      if (itemDistance(a, b) > 0) continue;
      if (a.net && b.net && a.net !== b.net) {
        const k = a.objId < b.objId ? `${a.objId}|${b.objId}` : `${b.objId}|${a.objId}`;
        if (!shortSeen.has(k)) {
          shortSeen.add(k);
          const anc = a.anchors[0] || b.anchors[0] || [a.box.minX, a.box.minY];
          shorts.push({ a: a.objId, b: b.objId, netA: a.net, netB: b.net, x: anc[0], y: anc[1] });
        }
        continue;
      }
      dsu.union(a.id, b.id);
    }
  }
  // Same-numbered pads of one footprint (e.g. a split thermal pad) are connected internally.
  const padGroups = new Map();
  for (const it of items) {
    if (!it.isPad || !it.pad.num) continue;
    const k = `${it.objId}:${it.pad.num}`;
    if (padGroups.has(k)) dsu.union(padGroups.get(k), it.id); else padGroups.set(k, it.id);
  }

  // Ratsnest per net: MST over anchor points, joining distinct islands.
  const byNet = new Map();
  for (const it of items) {
    if (!it.net) continue;
    let list = byNet.get(it.net);
    if (!list) byNet.set(it.net, (list = []));
    list.push(it);
  }
  const ratsnest = [];
  const unrouted = new Map();
  for (const [net, list] of byNet) {
    const islands = new Map();
    for (const it of list) {
      const root = dsu.find(it.id);
      let isl = islands.get(root);
      if (!isl) islands.set(root, (isl = { pts: [], hasPad: false }));
      if (it.isPad) isl.hasPad = true;
      for (const p of it.anchors) isl.pts.push(p);
    }
    // Only islands that carry pads need joining; stray tracks of a net count as copper to reach.
    const isl = [...islands.values()].filter((i) => i.pts.length && (i.hasPad || islands.size > 1));
    if (isl.length < 2) continue;
    const lines = mstIslands(isl);
    for (const l of lines) ratsnest.push({ net, ...l });
    unrouted.set(net, lines.length);
  }
  return { items, dsu, ratsnest, unrouted, shorts };
}

// Islands with at least this many anchors are searched through a grid.
const GRID_MIN = 48;

/**
 * Buckets an island's anchors into a uniform grid (about one anchor per
 * cell) for nearestAnchor. Null when the anchors have no finite extent.
 */
function anchorGrid(pts) {
  const n = pts.length;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[i][0], y = pts[i][1];
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const w = maxX - minX, h = maxY - minY;
  if (!Number.isFinite(w + h)) return null;
  const cell = Math.max(Math.sqrt((w * h) / n), Math.max(w, h) / n, 1);
  const nx = Math.floor(w / cell) + 1, ny = Math.floor(h / cell) + 1;
  const cellOf = new Int32Array(n);
  const start = new Int32Array(nx * ny + 1);
  for (let i = 0; i < n; i++) {
    const gx = Math.min(nx - 1, Math.max(0, Math.floor((pts[i][0] - minX) / cell)));
    const gy = Math.min(ny - 1, Math.max(0, Math.floor((pts[i][1] - minY) / cell)));
    cellOf[i] = (gy || 0) * nx + (gx || 0);
    start[cellOf[i] + 1]++;
  }
  for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  // Anchors of a cell stay in their original order.
  const fill = start.slice(0, nx * ny);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[fill[cellOf[i]]++] = i;
  return { pts, minX, minY, maxX, maxY, cell, nx, ny, start, order };
}

let nearD = 0, nearI = -1;

/**
 * The grid's anchor closest to a point, among those no farther than `limit`
 * (squared); of several equally close, the first in the island's own order.
 * Leaves the squared distance in nearD and the index (-1: none) in nearI.
 */
function nearestAnchor(g, bx, by, limit) {
  const { pts, cell, nx, ny, start, order } = g;
  let bd = limit, bi = -1;
  const cx = Math.min(nx - 1, Math.max(0, Math.floor((bx - g.minX) / cell)));
  const cy = Math.min(ny - 1, Math.max(0, Math.floor((by - g.minY) / cell)));
  // How far the point lies outside the grid on each axis.
  const ox = Math.max(g.minX - bx, bx - g.maxX, 0), oy = Math.max(g.minY - by, by - g.maxY, 0);
  for (let r = 0; ; r++) {
    const x0 = cx - r, x1 = cx + r, y0 = cy - r, y1 = cy + r;
    if (x0 < 0 && y0 < 0 && x1 >= nx && y1 >= ny) break;
    if (r > 0) {
      // Anchors not seen yet are at least r - 1 cells away along one axis
      // (with a margin for rounding where anchors sit on cell borders).
      const reach = (r - 1) * cell * (1 - 1e-6);
      if (Math.min((reach + ox) ** 2 + oy * oy, ox * ox + (reach + oy) ** 2) > bd) break;
    }
    for (let gy = Math.max(y0, 0), gyEnd = Math.min(y1, ny - 1); gy <= gyEnd; gy++) {
      // The ring's top and bottom rows in full, only the two end cells of the rows between.
      const full = gy === y0 || gy === y1;
      for (let gx = full ? Math.max(x0, 0) : x0; gx <= x1 && gx < nx; gx += full ? 1 : x1 - x0) {
        if (gx < 0) continue;
        const c = gy * nx + gx;
        for (let k = start[c], end = start[c + 1]; k < end; k++) {
          const i = order[k];
          const d = (pts[i][0] - bx) ** 2 + (pts[i][1] - by) ** 2;
          if (d < bd || (d === bd && (bi < 0 || i < bi))) { bd = d; bi = i; }
        }
      }
    }
  }
  nearD = bd;
  nearI = bi;
}

/**
 * Prim's algorithm over islands using their closest anchor pairs. Each island
 * that joins the tree is compared with every island still outside it: anchor
 * by anchor when it is small, through a grid of its anchors when it is large
 * (a routed net has few islands with thousands of anchors each). Both ways
 * choose the same pair, the first of the closest in anchor order.
 */
export function mstIslands(islands) {
  const n = islands.length;
  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const bestPair = new Array(n);
  inTree[0] = 1;
  const relax = (from) => {
    const A = islands[from].pts;
    const grid = A.length >= GRID_MIN ? anchorGrid(A) : null;
    for (let j = 0; j < n; j++) {
      if (inTree[j]) continue;
      const B = islands[j].pts;
      if (grid) {
        let bd = best[j], pa = -1, pb = -1;
        for (let k = 0; k < B.length; k++) {
          const bx = B[k][0], by = B[k][1];
          if (!Number.isFinite(bx + by)) continue;
          nearestAnchor(grid, bx, by, bd);
          if (nearI >= 0 && (nearD < bd || (pa >= 0 && nearI < pa))) { bd = nearD; pa = nearI; pb = k; }
        }
        if (pa >= 0) { best[j] = bd; bestPair[j] = { x1: A[pa][0], y1: A[pa][1], x2: B[pb][0], y2: B[pb][1] }; }
        continue;
      }
      for (const [ax, ay] of A) for (const [bx, by] of B) {
        const d = (ax - bx) ** 2 + (ay - by) ** 2;
        if (d < best[j]) { best[j] = d; bestPair[j] = { x1: ax, y1: ay, x2: bx, y2: by }; }
      }
    }
  };
  relax(0);
  const out = [];
  for (let k = 1; k < n; k++) {
    let m = -1;
    for (let j = 0; j < n; j++) if (!inTree[j] && (m < 0 || best[j] < best[m])) m = j;
    if (m < 0 || best[m] === Infinity) break;
    inTree[m] = 1;
    out.push(bestPair[m]);
    relax(m);
  }
  return out;
}

/** Ids of every object electrically joined to the given object (same island). */
export function connectedObjects(analysis, objId) {
  const roots = new Set();
  for (const it of analysis.items) if (it.objId === objId) roots.add(analysis.dsu.find(it.id));
  const out = new Set();
  for (const it of analysis.items) if (roots.has(analysis.dsu.find(it.id))) out.add(it.objId);
  return out;
}
