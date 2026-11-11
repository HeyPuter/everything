/**
 * Objects on Path: a live group of a path and objects placed along it.
 *
 *   node.live = { kind: 'onPath', path: childId, spacing: 'even'|'distance',
 *                 distance, align: 'center'|'above'|'below', rotate,
 *                 angle (extra turn of each object, degrees counterclockwise),
 *                 offset (0-1 of the path length), reverse }
 *
 * The path draws as itself; every other child draws as a copy whose
 * center sits on the path: spread evenly from the start offset to the end
 * (closed paths: all the way round), or a fixed distance apart. With
 * `rotate` each copy turns with the path direction; `align` puts the
 * object's center, bottom edge (above) or top edge (below) on the path.
 * The objects keep their own position in the document, so editing the
 * path or an object (in isolation mode) re-places everything.
 */
import { registerLive } from '../../model/live.js';
import { createGroup } from '../../model/nodes.js';
import { nodeBounds, transformPatches } from '../../model/geometry.js';
import { pathSampler } from '../../model/path-sampler.js';
import { pathLength } from '../../model/bezier.js';
import { multiply, translate, rotate, scaleFactor, rotation } from '../../lib/matrix.js';
import { transformedCopy } from './virtual.js';
import { idRefHooks } from '../../model/document.js';

export const ON_PATH_DEFAULTS = Object.freeze({ spacing: 'even', distance: 36, align: 'center', rotate: true, angle: 0, offset: 0, reverse: false });

export const isOnPath = (n) => n?.type === 'group' && n.live?.kind === 'onPath';

// Copies (paste, duplicate) follow their own copy of the path.
idRefHooks.push((n, map) => (isOnPath(n) && map.has(n.live.path) ? { ...n, live: { ...n.live, path: map.get(n.live.path) } } : n));

const samplerCache = new WeakMap();

/** The arc-length sampler of an objects-on-path group's path, or null. */
export function onPathSampler(doc, node) {
  const p = doc.get(node.live.path);
  if (!p || p.type !== 'path' || p.anchors.length < 2) return null;
  let s = samplerCache.get(p);
  if (!s) samplerCache.set(p, (s = pathSampler(p.anchors, p.closed)));
  return s;
}

/** Distances along the path of `count` objects. */
export function onPathPositions(live, length, closed, count) {
  const o = { ...ON_PATH_DEFAULTS, ...live };
  const a = Math.max(0, Math.min(1, o.offset)) * length;
  const out = [];
  if (!count || !(length > 0)) return out;
  if (o.spacing === 'distance') {
    const d = Math.max(0.01, o.distance);
    for (let i = 0; i < count; i++) {
      const s = a + i * d;
      if (!closed && s > length + 1e-6) break;
      if (closed && i * d >= length - 1e-6) break;
      out.push(s);
    }
    return out;
  }
  if (closed) {
    for (let i = 0; i < count; i++) out.push(a + (i * length) / count);
    return out;
  }
  if (count === 1) return [a + (length - a) / 2];
  for (let i = 0; i < count; i++) out.push(a + (i * (length - a)) / (count - 1));
  return out;
}

/** Matrices placing each object (child id -> matrix), in paint order. */
export function onPathPlacements(doc, node) {
  const sampler = onPathSampler(doc, node);
  const objs = node.children.filter((c) => c !== node.live.path).map((c) => doc.get(c)).filter((n) => n && !n.hidden);
  if (!sampler) return objs.map((n) => ({ node: n, m: null }));
  const o = { ...ON_PATH_DEFAULTS, ...node.live };
  const order = o.reverse ? objs.slice().reverse() : objs;
  const pos = onPathPositions(o, sampler.length, sampler.closed, order.length);
  const out = [];
  order.forEach((n, i) => {
    if (i >= pos.length) return;
    const b = nodeBounds(doc, n);
    if (!b) return;
    const p = sampler.at(pos[i]);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    // Local offset across the path: above puts the object's bottom edge on it.
    const dy = o.align === 'above' ? -b.h / 2 : o.align === 'below' ? b.h / 2 : 0;
    let m = translate(-cx, -cy);
    // `turned`: how far the objects themselves were turned with the group, undone when they turn with the path.
    const turn = (o.angle || 0) + (o.rotate ? o.turned || 0 : 0);
    if (turn) m = multiply(rotate(-turn), m);
    m = multiply(translate(0, dy), m);
    if (o.rotate) m = multiply(rotate((p.angle * 180) / Math.PI), m);
    m = multiply(translate(p.x, p.y), m);
    out.push({ node: n, m });
  });
  // Paint order stays the children's order whatever the direction.
  const rank = new Map(node.children.map((c, i) => [c, i]));
  return out.sort((x, y) => rank.get(x.node.id) - rank.get(y.node.id));
}

registerLive('onPath', {
  label: '<Objects on Path>',
  generate(doc, node) {
    const items = [];
    const extra = new Map();
    const path = doc.get(node.live.path);
    if (path && !path.hidden) items.push(path.id);
    for (const { node: n, m } of onPathPlacements(doc, node)) {
      if (!m) continue;
      const v = transformedCopy(doc, n, m, extra, { base: 'oop' });
      v.parent = node.id;
      extra.set(v.id, v);
      items.push(v.id);
    }
    return { items, extra };
  },
  transformParams(node, m) {
    const L = node.live;
    const patch = {};
    const s = scaleFactor(m);
    if (Math.abs(s - 1) > 1e-9 && L.spacing === 'distance') patch.distance = L.distance * s;
    // Rotating (or flipping) the group turns the objects and the path alike: objects that turn
    // with the path would turn twice, so the turn they got is recorded and taken off again.
    const flip = m[0] * m[3] - m[1] * m[2] < 0;
    const spin = flip ? (Math.atan2(-m[1], -m[0]) * 180) / Math.PI : rotation(m);
    const turned = flip ? spin + 180 - (L.turned || 0) : (L.turned || 0) + spin;
    const norm = ((((turned + 180) % 360) + 360) % 360) - 180;
    if (Math.abs(norm - (L.turned || 0)) > 1e-9) patch.turned = Math.abs(norm) < 1e-9 ? 0 : norm;
    // A flip mirrors the extra turn the objects take from the path.
    if (flip && L.angle) patch.angle = -L.angle;
    return Object.keys(patch).length ? { live: { ...L, ...patch } } : null;
  },
});

/**
 * The path objects attach to among `ids`: the key object when it is a path,
 * else the longest open path, else the longest path. Null without one.
 */
export function pickPath(doc, ids, key = null) {
  const paths = ids.map((id) => doc.get(id)).filter((n) => n?.type === 'path' && n.anchors.length >= 2);
  if (!paths.length) return null;
  if (key && paths.some((p) => p.id === key)) return key;
  const longest = (list) => list.reduce((best, p) => {
    const l = pathLength(p.anchors, p.closed);
    return !best || l > best.l ? { id: p.id, l } : best;
  }, null)?.id;
  return longest(paths.filter((p) => !p.closed)) || longest(paths);
}

/** Attach objects to a path (inside a transaction). Returns the group id. */
export function attachToPath(doc, ids, pathId, opts = {}) {
  const sorted = doc.sortByPaintOrder(ids).filter((id) => doc.has(id));
  if (!sorted.includes(pathId) || sorted.length < 2) return null;
  const top = doc.get(sorted[sorted.length - 1]);
  const parent = doc.get(top.parent);
  const index = parent.children.indexOf(top.id) + 1;
  const g = createGroup([], { live: { kind: 'onPath', path: pathId, ...ON_PATH_DEFAULTS, ...opts } });
  doc.insert(g, parent.id, index);
  // The path goes to the back; the objects keep their stacking order above it.
  doc.move(pathId, g.id);
  for (const id of sorted) if (id !== pathId) doc.move(id, g.id);
  return g.id;
}

/**
 * Release: the objects keep their places on the path (their copies' matrices
 * are applied to them) and everything goes back to the parent.
 */
export function releaseOnPath(doc, id) {
  const g = doc.get(id);
  if (!isOnPath(g)) return [];
  const placements = onPathPlacements(doc, g);
  for (const { node, m } of placements) {
    if (!m) continue;
    for (const [nid, patch] of transformPatches(doc, doc.get(node.id), m, {})) doc.update(nid, patch);
  }
  const parent = doc.get(g.parent);
  let index = parent.children.indexOf(id);
  const kids = g.children.slice();
  for (const c of kids) doc.move(c, parent.id, index++);
  doc.remove(id);
  return kids;
}
