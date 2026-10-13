/**
 * Object > Expand, "Expand Gradient To": a gradient fill becomes either a
 * gradient mesh, or a number of solid-filled steps (bands across a linear
 * gradient, rings of a radial one) inside a clipping mask of the object's
 * own outline. A stroke stays as a separate unfilled copy above the steps.
 */
import { isGradient, sampleStops } from '../../model/gradients.js';
import { gradientGeometry, nodeBounds } from '../../model/geometry.js';
import { ellipse } from '../../model/shapes.js';
import { createPath } from '../../model/nodes.js';
import { subpathsOf, nodeFromSubpaths, styleOf, groupOf } from './nodes-io.js';

const anchor = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });

/** Solid paint for a gradient position (stop opacity kept). */
function solidAt(paint, t) {
  const s = sampleStops(paint.stops || [], t);
  return { type: 'solid', color: s.color, ...(s.opacity < 1 ? { opacity: s.opacity } : {}) };
}

/**
 * Step shapes for a gradient over bounds b: [{ anchors, paint }] back to
 * front. Linear gradients give `steps` bands across the gradient axis (the
 * first and last reach past the bounds); radial ones give a covering
 * rectangle and `steps` nested ellipses.
 */
export function gradientSteps(paint, b, steps) {
  const n = Math.max(1, Math.round(steps));
  const g = gradientGeometry(paint, b);
  const t = (i) => (n === 1 ? 0.5 : i / (n - 1));
  const reach = Math.hypot(b.w, b.h) + Math.hypot(g.x2 - g.x1, g.y2 - g.y1) + 1;
  const out = [];
  if (paint.type === 'radial') {
    const r = g.r || Math.max(b.w, b.h) / 2;
    const cx = g.x1;
    const cy = g.y1;
    const angle = Math.atan2(g.y2 - g.y1, g.x2 - g.x1);
    const aspect = paint.aspect || 1;
    const big = Math.max(reach, r * 2 + 1);
    out.push({ anchors: [anchor(cx - big, cy - big), anchor(cx + big, cy - big), anchor(cx + big, cy + big), anchor(cx - big, cy + big)], paint: solidAt(paint, 1) });
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const turn = (p) => ({ x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos });
    for (let k = n; k >= 1; k--) {
      const rr = (r * k) / n;
      const pts = ellipse(cx - rr, cy - rr * aspect, rr * 2, rr * 2 * aspect).map((a) => {
        const p = turn(a);
        const i = turn({ x: a.ix, y: a.iy });
        const o = turn({ x: a.ox, y: a.oy });
        return { x: p.x, y: p.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y };
      });
      out.push({ anchors: pts, paint: solidAt(paint, t(k - 1)) });
    }
    return out;
  }
  const len = Math.hypot(g.x2 - g.x1, g.y2 - g.y1) || 1;
  const ux = (g.x2 - g.x1) / len;
  const uy = (g.y2 - g.y1) / len;
  const at = (s) => ({ x: g.x1 + ux * len * s, y: g.y1 + uy * len * s });
  for (let i = 0; i < n; i++) {
    const a = i === 0 ? at(-reach / len) : at(i / n);
    const z = i === n - 1 ? at(1 + reach / len) : at((i + 1) / n);
    // Perpendicular to the axis.
    const px = -uy * reach;
    const py = ux * reach;
    out.push({ anchors: [anchor(a.x + px, a.y + py), anchor(z.x + px, z.y + py), anchor(z.x - px, z.y - py), anchor(a.x - px, a.y - py)], paint: solidAt(paint, t(i)) });
  }
  return out;
}

/** Built items ({ node, descendants }) replacing a gradient-filled node by `steps` solid steps. */
export function expandGradientItems(doc, node, steps) {
  const b = nodeBounds(doc, node);
  if (!b || !isGradient(node.fill)) return null;
  // Opacity, blend mode and effects move to the object that replaces the node.
  const style = { ...styleOf(node), opacity: 1, blendMode: 'normal', effects: [] };
  const bands = gradientSteps(node.fill, b, steps).map((s) => ({ node: createPath(s.anchors, true, { ...style, fill: s.paint, stroke: null }), descendants: [] }));
  const sps = subpathsOf(doc, node);
  const mask = nodeFromSubpaths(sps, { fill: null, stroke: null }, node.type === 'compound' ? { fillRule: node.fillRule } : {});
  if (!mask) return null;
  const clip = groupOf([...bands, mask], { clip: true });
  const items = [clip];
  if (node.stroke && node.strokeWidth > 0) {
    const outline = nodeFromSubpaths(sps, { ...style, fill: null }, node.type === 'compound' ? { fillRule: node.fillRule } : {});
    if (outline) items.push(outline);
  }
  const keep = { name: node.name || '', opacity: node.opacity ?? 1, blendMode: node.blendMode || 'normal', ...(node.effects?.length ? { effects: node.effects } : {}) };
  return items.length === 1 ? (Object.assign(clip.node, keep), clip) : groupOf(items, keep);
}
