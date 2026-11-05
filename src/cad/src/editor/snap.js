/**
 * Object snaps: find the most relevant precise point near the cursor
 * (endpoints, midpoints, centres, intersections, ...).
 */
import {
  endpoints,
  midpoints,
  centers,
  quadrants,
  nodes,
  perpendicularFrom,
  tangentsFrom,
  geometricCenter,
  closestPoint,
  toPrims,
  intersectPrims,
  transformEntity,
} from '../core/geom/index.js';
import { insertMatrix, mulMatrix } from '../core/tessellate.js';

export const SNAP_MODES = [
  { id: 'end', label: 'Endpoint', icon: 'snap-end' },
  { id: 'mid', label: 'Midpoint', icon: 'snap-mid' },
  { id: 'cen', label: 'Center', icon: 'snap-cen' },
  { id: 'gcen', label: 'Geometric center', icon: 'snap-gcen' },
  { id: 'node', label: 'Node', icon: 'snap-node' },
  { id: 'quad', label: 'Quadrant', icon: 'snap-quad' },
  { id: 'int', label: 'Intersection', icon: 'snap-int' },
  { id: 'ext', label: 'Extension', icon: 'snap-ext' },
  { id: 'ins', label: 'Insertion', icon: 'snap-ins' },
  { id: 'per', label: 'Perpendicular', icon: 'snap-per' },
  { id: 'tan', label: 'Tangent', icon: 'snap-tan' },
  { id: 'nea', label: 'Nearest', icon: 'snap-nea' },
];

export const DEFAULT_SNAPS = ['end', 'mid', 'cen', 'int', 'ext', 'node', 'quad', 'ins'];

// Lower wins when two candidates are about equally close.
const PRIORITY = { end: 0, int: 1, mid: 2, cen: 3, gcen: 3, node: 2, quad: 3, ins: 2, per: 4, tan: 4, ext: 6, nea: 8 };

const primCache = new WeakMap();
function primsOf(ent) {
  let p = primCache.get(ent);
  if (!p) {
    try {
      p = toPrims(ent);
    } catch {
      p = [];
    }
    primCache.set(ent, p);
  }
  return p;
}

const expandCache = new WeakMap();
const GEOMETRIC = new Set(['line', 'xline', 'ray', 'circle', 'arc', 'ellipse', 'polyline', 'spline', 'point', 'leader', 'hatch']);

/**
 * Geometric sub-entities of a block reference in world space. Cached per
 * reference and checked against the block definitions used, which are
 * replaced (not mutated) when a block is redefined.
 */
function expandInsert(drawing, ins, depth = 0, m0 = null, used = null) {
  if (!m0) {
    const hit = expandCache.get(ins);
    if (hit && hit.used.every(([name, b]) => drawing.blocks.get(name) === b)) return hit.list;
    used = [];
  }
  const block = drawing.blocks.get(ins.name);
  used.push([ins.name, block]);
  const list = [];
  if (block && depth < 4) {
    const m = m0 ? mulMatrix(m0, insertMatrix(ins, block)) : insertMatrix(ins, block);
    for (const e of block.entities) {
      if (e.type === 'insert') list.push(...expandInsert(drawing, e, depth + 1, m, used));
      else if (GEOMETRIC.has(e.type)) {
        try {
          list.push(transformEntity(e, m));
        } catch {
          /* skip */
        }
      }
    }
  }
  if (!m0) expandCache.set(ins, { used, list });
  return list;
}

function safe(fn, ...args) {
  try {
    return fn(...args) || [];
  } catch {
    return [];
  }
}

/**
 * Find the best snap near (x, y).
 *   ids      candidate entity ids (from the spatial index, aperture-sized query)
 *   radius   aperture in world units
 *   modes    Set of enabled mode ids
 *   base     the current base point (for perpendicular and tangent), or null
 * Returns { x, y, mode, id } or null.
 */
export function findSnap(drawing, ids, x, y, radius, modes, base) {
  const r2 = radius * radius;
  let best = null;
  let bestScore = Infinity;
  const consider = (px, py, mode, id) => {
    const d2 = (px - x) ** 2 + (py - y) ** 2;
    if (d2 > r2) return;
    // Distance in aperture fractions plus a small priority bias.
    const score = Math.sqrt(d2) / radius + PRIORITY[mode] * 0.08;
    if (score < bestScore) {
      bestScore = score;
      best = { x: px, y: py, mode, id };
    }
  };
  const addAll = (pts, mode, id) => {
    for (const p of pts) consider(p.x ?? p[0], p.y ?? p[1], mode, id);
  };

  // Gather geometric entities near the cursor, nearest first.
  const geo = [];
  for (const id of ids) {
    const ent = drawing.entities.get(id);
    if (!ent || !drawing.layerVisible(ent.layer)) continue;
    if (ent.type === 'insert') {
      if (modes.has('ins')) consider(ent.x, ent.y, 'ins', id);
      for (const sub of expandInsert(drawing, ent)) geo.push({ ent: sub, id });
    } else if (ent.type === 'text' || ent.type === 'mtext') {
      if (modes.has('ins')) consider(ent.x, ent.y, 'ins', id);
    } else if (ent.type === 'dimension') {
      if (modes.has('node')) {
        consider(ent.x1, ent.y1, 'node', id);
        consider(ent.x2, ent.y2, 'node', id);
      }
    } else geo.push({ ent, id });
  }
  const near = [];
  for (const g of geo) {
    let d = Infinity;
    try {
      const c = closestPoint(g.ent, x, y);
      d = c ? c.d ?? Math.hypot(c.x - x, c.y - y) : Infinity;
    } catch {
      /* ignore */
    }
    g.d = d;
    // Centres are reachable when the cursor is near the curve or the centre.
    if (d <= radius * 1.5 || g.ent.type === 'circle' || g.ent.type === 'arc' || g.ent.type === 'ellipse') near.push(g);
  }
  near.sort((a, b) => a.d - b.d);
  const top = near.slice(0, 24);

  for (const { ent, id, d } of top) {
    const onCurve = d <= radius;
    if (modes.has('end') && onCurve) addAll(safe(endpoints, ent), 'end', id);
    if (modes.has('mid') && onCurve) addAll(safe(midpoints, ent), 'mid', id);
    if (modes.has('cen')) addAll(safe(centers, ent), 'cen', id);
    if (modes.has('quad') && onCurve) addAll(safe(quadrants, ent), 'quad', id);
    if (modes.has('node')) addAll(safe(nodes, ent), 'node', id);
    if (modes.has('gcen') && onCurve) {
      const c = safe(geometricCenter, ent);
      if (c && (c.x !== undefined || c.length)) addAll(Array.isArray(c) ? c : [c], 'gcen', id);
    }
    if (base && onCurve) {
      if (modes.has('per')) addAll(safe(perpendicularFrom, ent, base.x, base.y), 'per', id);
      if (modes.has('tan')) addAll(safe(tangentsFrom, ent, base.x, base.y), 'tan', id);
    }
  }

  if (modes.has('int')) {
    const close = top.filter((g) => g.d <= radius).slice(0, 12);
    for (let i = 0; i < close.length; i++) {
      const pa = primsOf(close[i].ent);
      // Self intersections of polylines are not needed for snapping.
      for (let j = i + 1; j < close.length; j++) {
        const pb = primsOf(close[j].ent);
        for (const a of pa) {
          for (const b of pb) {
            for (const p of safe(intersectPrims, a, b)) consider(p.x, p.y, 'int', close[i].id);
          }
        }
      }
    }
  }

  if (!best && modes.has('nea') && top.length && top[0].d <= radius) {
    try {
      const c = closestPoint(top[0].ent, x, y);
      if (c) best = { x: c.x, y: c.y, mode: 'nea', id: top[0].id };
    } catch {
      /* ignore */
    }
  }
  return best;
}
