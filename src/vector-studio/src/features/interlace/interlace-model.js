/**
 * Interlace: overlapping objects that pass over and under each other.
 *
 *   node.live = { kind: 'interlace', zones: [{ subpaths: [{ anchors, closed }], order: [childId, ...] }] }
 *
 * The children draw as themselves in their own stacking order. Each zone
 * then draws copies of the objects it involves, in the zone's own order
 * (back to front), clipped to the zone's outline: inside the zone the
 * stacking is the zone's, everywhere else it is the children's. A zone
 * comes from clicking where objects overlap (the outline of their common
 * area around the click, computed by the geometry engine) or from a
 * freehand loop.
 */
import { registerLive, virtualId } from '../../model/live.js';
import { idRefHooks } from '../../model/document.js';
import { createGroup, DEFAULT_STYLE } from '../../model/nodes.js';
import { nodeBounds, rectsIntersect } from '../../model/geometry.js';
import { flattenPath, transformAnchors, pathBounds } from '../../model/bezier.js';
import { hitNode } from '../../render/hit.js';
import { transformedCopy } from '../repeat/virtual.js';
import { pointInPolys, windingNumber } from '../regions/planar.js';

export const isInterlace = (n) => n?.type === 'group' && n.live?.kind === 'interlace';

// Copies (paste, duplicate) keep their zones: the orders name the copied children.
idRefHooks.push((n, map) => (isInterlace(n) && n.live.zones?.length ? { ...n, live: { ...n.live, zones: n.live.zones.map((z) => ({ ...z, order: z.order.map((id) => map.get(id) || id) })) } } : n));

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** Bounds of a zone's outline. */
export function zoneBounds(zone) {
  let b = null;
  for (const sp of zone.subpaths) {
    const pb = pathBounds(sp.anchors, true);
    if (!pb) continue;
    b = b ? { x: Math.min(b.x, pb.x), y: Math.min(b.y, pb.y), w: Math.max(b.x + b.w, pb.x + pb.w) - Math.min(b.x, pb.x), h: Math.max(b.y + b.h, pb.y + pb.h) - Math.min(b.y, pb.y) } : pb;
  }
  return b;
}

const polyCache = new WeakMap();
function zonePolys(zone) {
  let p = polyCache.get(zone);
  if (!p) polyCache.set(zone, (p = zone.subpaths.map((sp) => flattenPath(sp.anchors, true, 0.2).map((q) => [q.x, q.y]))));
  return p;
}

/** Is a point inside a zone (even-odd: holes are outside)? */
export function inZone(zone, x, y) {
  const b = zoneBounds(zone);
  if (!b || x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return false;
  return pointInPolys(zonePolys(zone), x, y);
}

registerLive('interlace', {
  label: '<Interlace>',
  generate(doc, node) {
    const items = [...node.children];
    const extra = new Map();
    for (const z of node.live.zones || []) {
      const kids = [];
      for (const id of z.order) {
        const n = node.children.includes(id) ? doc.get(id) : null;
        if (!n || n.hidden) continue;
        const v = transformedCopy(doc, n, IDENTITY, extra, { base: 'il' });
        extra.set(v.id, v);
        kids.push(v.id);
      }
      if (!kids.length) continue;
      const mask = { id: virtualId('il'), type: 'compound', name: '', hidden: false, locked: false, ...DEFAULT_STYLE, effects: [], fill: null, stroke: null, strokeWidth: 0, fillRule: 'evenodd', children: [] };
      for (const sp of z.subpaths) {
        const p = { id: virtualId('il'), type: 'path', name: '', hidden: false, locked: false, ...DEFAULT_STYLE, effects: [], fill: null, stroke: null, anchors: sp.anchors, closed: true, parent: mask.id };
        extra.set(p.id, p);
        mask.children.push(p.id);
      }
      extra.set(mask.id, mask);
      const g = { id: virtualId('il'), type: 'group', name: 'Zone', clip: true, hidden: false, locked: false, opacity: 1, blendMode: 'normal', effects: [], children: [...kids, mask.id] };
      for (const k of g.children) extra.set(k, { ...extra.get(k), parent: g.id });
      extra.set(g.id, g);
      items.push(g.id);
    }
    return { items, extra };
  },
  transformParams(node, m) {
    return { live: { ...node.live, zones: (node.live.zones || []).map((z) => ({ ...z, subpaths: z.subpaths.map((sp) => ({ ...sp, anchors: transformAnchors(sp.anchors, m) })) })) } };
  },
});

/** Make an interlace group of objects (inside a transaction). Returns its id. */
export function makeInterlace(doc, ids) {
  const sorted = doc.sortByPaintOrder(ids).filter((id) => doc.has(id) && !doc.get(id).locked);
  if (sorted.length < 2) return null;
  const top = doc.get(sorted[sorted.length - 1]);
  const parent = doc.get(top.parent);
  const index = parent.children.indexOf(top.id) + 1;
  const g = createGroup([], { live: { kind: 'interlace', zones: [] } });
  doc.insert(g, parent.id, index);
  for (const id of sorted) doc.move(id, g.id);
  return g.id;
}

/** Release (inside a transaction): the objects go back as they were. */
export function releaseInterlace(doc, gid) {
  const g = doc.get(gid);
  if (!isInterlace(g)) return [];
  const parent = doc.get(g.parent);
  let index = parent.children.indexOf(gid);
  const kids = g.children.slice();
  for (const c of kids) doc.move(c, parent.id, index++);
  doc.remove(gid);
  return kids;
}

/** Children of the group drawn at a point (fill or stroke), any order. */
export function objectsAt(doc, g, x, y, tol = 0) {
  return g.children.filter((id) => {
    const n = doc.get(id);
    return n && !n.hidden && coversPoint(doc, n, x, y, tol);
  });
}

function coversPoint(doc, n, x, y, tol) {
  if (n.type === 'group') return n.children.some((c) => {
    const cn = doc.get(c);
    return cn && !cn.hidden && coversPoint(doc, cn, x, y, tol);
  });
  return hitNode(doc, n, x, y, tol);
}

/** The stacking order (back to front) at a point: the children's, rearranged by the zones there. */
export function orderAt(g, x, y) {
  let order = g.children.slice();
  for (const z of g.live.zones || []) {
    if (!inZone(z, x, y)) continue;
    order = applyZoneOrder(order, z.order);
  }
  return order;
}

/** Put `zoneOrder`'s ids into the slots those ids hold in `order`, in zone order. */
function applyZoneOrder(order, zoneOrder) {
  const set = new Set(zoneOrder);
  const slots = [];
  order.forEach((id, i) => set.has(id) && slots.push(i));
  const out = order.slice();
  const placed = zoneOrder.filter((id) => order.includes(id));
  slots.forEach((slot, k) => (out[slot] = placed[k]));
  return out;
}

/** Children whose bounds meet a zone's bounds, in stacking order. */
export function involvedIn(doc, g, zone) {
  const zb = zoneBounds(zone);
  if (!zb) return [];
  return g.children.filter((id) => {
    const b = nodeBounds(doc, doc.get(id));
    return b && rectsIntersect(b, zb);
  });
}

/**
 * Add or update a zone (inside a transaction). A zone that already holds
 * the point with about the same outline is replaced; a zone whose order
 * is the plain stacking order again is removed.
 */
export function setZone(doc, gid, zone, x, y) {
  const g = doc.get(gid);
  if (!isInterlace(g)) return;
  const zb = zoneBounds(zone);
  const near = (a, b) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1;
  let zones = (g.live.zones || []).filter((z) => !(inZone(z, x, y) && near(zoneBounds(z), zb)));
  const plain = g.children.filter((id) => zone.order.includes(id));
  if (!(plain.length === zone.order.length && plain.every((id, i) => id === zone.order[i]))) zones = [...zones, zone];
  doc.update(gid, { live: { ...g.live, zones } });
}

/**
 * Of a set of closed subpaths (an engine result), the piece around a
 * point: the smallest outer outline holding it and the holes inside that
 * outline. Null when the point is outside every piece.
 */
export function pieceAt(subpaths, x, y) {
  const info = subpaths
    .filter((sp) => sp.anchors.length > 2)
    .map((sp) => {
      const poly = flattenPath(sp.anchors, true, 0.2).map((p) => [p.x, p.y]);
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return { sp, poly, area: a / 2 };
    });
  if (!info.length || windingNumber(info.map((i) => i.poly), x, y) === 0) return null;
  const outerSign = Math.sign(info.reduce((best, i) => (Math.abs(i.area) > Math.abs(best.area) ? i : best)).area);
  const outers = info.filter((i) => Math.sign(i.area) === outerSign && pointInPolys([i.poly], x, y)).sort((a, b) => Math.abs(a.area) - Math.abs(b.area));
  const outer = outers[0];
  if (!outer) return null;
  const holes = info.filter((i) => Math.sign(i.area) !== outerSign && pointInPolys([outer.poly], i.poly[0][0], i.poly[0][1]));
  return [outer.sp, ...holes.map((h) => h.sp)].map((sp) => ({ anchors: sp.anchors, closed: true }));
}
