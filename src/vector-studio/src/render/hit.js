/**
 * Hit testing in document space.
 *
 * Exact fill and stroke tests use the browser's isPointInPath and
 * isPointInStroke on the cached Path2D objects, after a cheap bounds reject,
 * so clicking matches what is drawn (curves, joins, fill rule).
 */
import { shapePathOf, renderPathOf } from './draw.js';
import { liveDef, liveArtwork } from '../model/live.js';
import { visualBounds, nodeBounds, rectsIntersect, inflate, unionRect } from '../model/geometry.js';
import { flattenPath } from '../model/bezier.js';
import { apply, invert } from '../lib/matrix.js';
import { layoutText, hitTextLocal } from '../model/text-layout.js';
import { hasAppearanceStack, layerAppearanceArtwork } from '../model/appearance.js';

let hitCtx = null;
function hctx() {
  if (!hitCtx) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    hitCtx = c.getContext('2d');
  }
  return hitCtx;
}

/** Point-in-node test for leaf nodes. tol is in document units. */
export function hitNode(doc, node, x, y, tol, { outline = false, fillOnly = false } = {}) {
  const livePath = (node.type === 'path' || node.type === 'compound') && !outline && liveDef(node);
  // A live path is clickable on its artwork and on its own outline.
  const vb = livePath ? unionRect(visualBounds(doc, node), nodeBounds(doc, node)) : visualBounds(doc, node);
  // Allocation-free bounds reject: hover runs this for every object.
  if (!vb || x < vb.x - tol || x > vb.x + vb.w + tol || y < vb.y - tol || y > vb.y + vb.h + tol) return false;
  if (livePath) {
    if (liveHit(doc, node, x, y, tol, { fillOnly })) return true;
    return !fillOnly && hitShape(doc, node, x, y, tol, true, false);
  }
  // Type with geometry effects is hit where its effected outlines are.
  if (node.type === 'text' && !outline && liveDef(node)) return Boolean(liveHit(doc, node, x, y, tol, { outline, fillOnly }));
  if (node.type === 'path' || node.type === 'compound') return hitShape(doc, node, x, y, tol, outline, fillOnly);
  if (node.type === 'text' || node.type === 'image') {
    const inv = invert(node.transform);
    const p = apply(inv, x, y);
    const t = tol / Math.max(1e-6, Math.hypot(node.transform[0], node.transform[1]));
    if (node.type === 'text') return hitTextLocal(layoutText(node), p.x, p.y, t);
    const r = { x: 0, y: 0, w: node.width, h: node.height };
    return p.x >= r.x - t && p.x <= r.x + r.w + t && p.y >= r.y - t && p.y <= r.y + r.h + t;
  }
  if (liveDef(node)) return Boolean(liveHit(doc, node, x, y, tol, { outline, fillOnly }));
  return false;
}

/** Exact fill and stroke test for a path or compound path (no bounds reject). */
function hitShape(doc, node, x, y, tol, outline, fillOnly) {
  const ctx = hctx();
  const path = outline ? shapePathOf(doc, node) : renderPathOf(doc, node);
  if (!path) return false;
  const filled = !outline && node.fill;
  const rule = node.fillRule || 'nonzero';
  if (filled && ctx.isPointInPath(path, x, y, rule)) return true;
  if (fillOnly) return false;
  ctx.lineWidth = Math.max(outline ? 0 : node.stroke ? node.strokeWidth || 0 : 0, tol * 2);
  ctx.lineJoin = node.strokeJoin || 'miter';
  ctx.lineCap = node.strokeCap || 'butt';
  return ctx.isPointInStroke(path, x, y);
}

/**
 * Hit test a live object's generated artwork. Returns the real source
 * object that was hit (for source children drawn as themselves), the live
 * object's first leaf when generated artwork was hit (so the Selection tool
 * picks the live object), or null.
 */
function liveHit(doc, node, x, y, tol, opts) {
  const { items, vdoc } = liveArtwork(doc, node);
  // The generated node that was hit, or null.
  const leafHit = (n) => {
    if (!n || n.hidden) return null;
    if (n.type === 'group' && !liveDef(n)) {
      for (let i = n.children.length - 1; i >= 0; i--) {
        const r = leafHit(vdoc.get(n.children[i]));
        if (r) return r;
      }
      return null;
    }
    return hitNode(vdoc, n, x, y, tol, opts) ? n : null;
  };
  for (let i = items.length - 1; i >= 0; i--) {
    const n = items[i];
    const real = doc.get(n.id) === n && n.parent === node.id;
    if (real) {
      if (n.hidden || n.locked || (opts.skip && opts.skip.has(n.id))) continue;
      if (n.type === 'group' || liveDef(n)) {
        const r = n.type === 'group' ? hitChildren(doc, n, x, y, tol, opts) : hitNode(doc, n, x, y, tol, opts) ? n : null;
        if (r) return r;
      } else if ((!opts.filter || opts.filter(n)) && hitNode(doc, n, x, y, tol, opts)) return n;
      continue;
    }
    const v = leafHit(n);
    if (!v) continue;
    // A generated copy that names its source (effects on a group) picks that object.
    const src = v.source ? doc.get(v.source) : null;
    if (src && !src.locked && !src.hidden) return src;
    return firstLeaf(doc, node) || node;
  }
  return null;
}

function firstLeaf(doc, node) {
  if (!node.children?.length) return null;
  for (const c of node.children) {
    const n = doc.get(c);
    if (!n) continue;
    if (n.type === 'group') {
      const l = firstLeaf(doc, n);
      if (l) return l;
    } else return n;
  }
  return null;
}

function clipContains(doc, group, x, y) {
  const mask = doc.get(group.children[group.children.length - 1]);
  if (!mask) return true;
  if (mask.type === 'path' || mask.type === 'compound') {
    const path = shapePathOf(doc, mask);
    return hctx().isPointInPath(path, x, y, mask.fillRule || 'nonzero');
  }
  const b = nodeBounds(doc, mask);
  return b ? x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h : true;
}

/**
 * Topmost leaf under a document point, or null. Skips hidden and locked
 * objects. Compound paths are returned as a whole (their children are not
 * separately clickable unless `intoCompound`).
 */
export function hitTest(doc, x, y, tol, opts = {}) {
  const { outline = false, intoCompound = false, filter = null, skip = null } = opts;
  const layers = doc.root.children;
  for (let li = layers.length - 1; li >= 0; li--) {
    const layer = doc.get(layers[li]);
    if (!layer || layer.hidden || layer.locked) continue;
    const o = { outline: outline || layer.outline, intoCompound, filter, skip };
    const r = hitChildren(doc, layer, x, y, tol, o) || (!o.outline && hasAppearanceStack(layer) ? layerStackHit(doc, layer, x, y, tol, o) : null);
    if (r) return r;
  }
  return null;
}

/**
 * A layer's own fills and strokes paint copies of its objects: a click on
 * them picks the object the copy was made from.
 */
function layerStackHit(doc, layer, x, y, tol, opts) {
  const { items, vdoc } = layerAppearanceArtwork(doc, layer);
  const leaf = (n) => {
    if (!n || n.hidden) return null;
    if (n.type === 'group' && !liveDef(n)) {
      for (let i = n.children.length - 1; i >= 0; i--) {
        const r = leaf(vdoc.get(n.children[i]));
        if (r) return r;
      }
      return null;
    }
    return n.source && hitNode(vdoc, n, x, y, tol, opts) ? n : null;
  };
  for (let i = items.length - 1; i >= 0; i--) {
    // The contents were hit tested as the layer's children already.
    if (doc.get(items[i].id) === items[i]) continue;
    const v = leaf(items[i]);
    const src = v && doc.get(v.source);
    if (!src || src.hidden || (doc.isLocked ? doc.isLocked(src.id) : src.locked) || (opts.skip && opts.skip.has(src.id))) continue;
    // A path of a compound path picks the compound.
    const pick = src.parent && doc.get(src.parent)?.type === 'compound' && !opts.intoCompound ? doc.get(src.parent) : src;
    if (opts.filter && !opts.filter(pick)) continue;
    return pick;
  }
  return null;
}

function hitChildren(doc, container, x, y, tol, opts) {
  const kids = container.children;
  if (container.type === 'group' && container.clip && kids.length) {
    if (!clipContains(doc, container, x, y)) {
      // The clipping path's own outline is still clickable.
      const mask = doc.get(kids[kids.length - 1]);
      if (mask && !mask.hidden && !mask.locked && hitNode(doc, mask, x, y, tol, { outline: true })) return mask;
      return null;
    }
  }
  for (let i = kids.length - 1; i >= 0; i--) {
    const n = doc.get(kids[i]);
    if (!n || n.hidden || n.locked) continue;
    if (opts.skip && opts.skip.has(n.id)) continue;
    if (liveDef(n) && n.type !== 'path' && n.type !== 'compound') {
      const r = liveHit(doc, n, x, y, tol, opts);
      if (r) return r;
      continue;
    }
    if (n.type === 'group') {
      const r = hitChildren(doc, n, x, y, tol, opts);
      if (r) return r;
      continue;
    }
    if (n.type === 'compound' && opts.intoCompound) {
      const r = hitNode(doc, n, x, y, tol, opts);
      if (r) {
        for (let j = n.children.length - 1; j >= 0; j--) {
          const c = doc.get(n.children[j]);
          if (c && hitNode(doc, { ...c, fill: n.fill, stroke: n.stroke, strokeWidth: n.strokeWidth }, x, y, tol, { outline: true })) return c;
        }
        return n;
      }
      continue;
    }
    if (opts.filter && !opts.filter(n)) continue;
    if (hitNode(doc, n, x, y, tol, opts)) return n;
  }
  return null;
}

function segIntersectsRect(x0, y0, x1, y1, r) {
  // Liang-Barsky clip test.
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - r.x, r.x + r.w - x0, y0 - r.y, r.y + r.h - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

/** Does a node's geometry touch a rect (marquee selection semantics)? */
export function nodeTouchesRect(doc, node, r) {
  const b = nodeBounds(doc, node);
  if (!b || !rectsIntersect(b, r)) return false;
  if (b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h) return true;
  if (node.type === 'path') {
    const pts = flattenPath(node.anchors, node.closed, 0.5);
    for (let i = 0; i < pts.length - 1; i++) if (segIntersectsRect(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, r)) return true;
    if (pts.length === 1) return segIntersectsRect(pts[0].x, pts[0].y, pts[0].x, pts[0].y, r);
    if (node.fill && node.closed) return hctx().isPointInPath(shapePathOf(doc, node), r.x + r.w / 2, r.y + r.h / 2);
    return false;
  }
  if (node.type === 'compound') {
    for (const c of node.children) {
      const cn = doc.get(c);
      if (cn && nodeTouchesRect(doc, { ...cn, fill: null }, r)) return true;
    }
    return Boolean(node.fill) && hctx().isPointInPath(shapePathOf(doc, node), r.x + r.w / 2, r.y + r.h / 2, node.fillRule || 'nonzero');
  }
  return true; // text, image: bounds overlap is enough
}

/** Leaves (and compounds) whose geometry touches a rect. */
export function marqueeHits(doc, r, { intoCompound = false, includeLocked = false } = {}) {
  const out = [];
  const visit = (container) => {
    const isClip = container.type === 'group' && container.clip;
    for (const id of container.children) {
      const n = doc.get(id);
      if (!n || n.hidden || (!includeLocked && n.locked)) continue;
      // Objects whose contents live in their own space (perspective) are hit as a whole.
      if (n.type === 'group' && !liveDef(n)?.ownSpace) {
        visit(n);
        continue;
      }
      if (n.type === 'compound' && intoCompound) {
        for (const c of n.children) {
          const cn = doc.get(c);
          if (cn && nodeTouchesRect(doc, { ...cn, fill: null }, r)) out.push(cn);
        }
        continue;
      }
      if (nodeTouchesRect(doc, n, r)) out.push(n);
    }
    return isClip;
  };
  for (const id of doc.root.children) {
    const layer = doc.get(id);
    if (!layer || layer.hidden || layer.locked) continue;
    visit(layer);
  }
  return out;
}

/** Anchors of a path inside a rect. */
export function anchorsInRect(node, r) {
  const out = [];
  node.anchors.forEach((a, i) => {
    if (a.x >= r.x && a.x <= r.x + r.w && a.y >= r.y && a.y <= r.y + r.h) out.push(i);
  });
  return out;
}

/** Ray-casting point-in-polygon for lasso selection. */
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
