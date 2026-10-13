/**
 * Clipping masks for DXF export. DXF has no clipping, so artwork inside a
 * clip group is cut to the mask before writing: fills become the
 * intersection of their shape and the mask (exact curves, through the
 * geometry engine), strokes become the polyline pieces inside the mask,
 * and images get a polygonal clip boundary. Nested masks intersect.
 *
 *   prepareDXF(doc, { ids }) -> { view, clipped: Map(id -> { fill, lines, image, text }) }
 *
 * `fill` is a list of subpaths (null when the shape has no part inside),
 * `lines` a list of polylines ([{ x, y }]), `image` a list of polygons
 * (document space) and `text` marks type that stays unclipped.
 */
import { exportView } from '../../io/export-view.js';
import { flattenPath } from '../../../model/bezier.js';
import { OP, runGeom } from '../../geometry/engine/index.js';

const TOL = 0.05;

function shapeSubpaths(view, n) {
  if (n.type === 'path') return [{ anchors: n.anchors, closed: n.closed }];
  if (n.type === 'compound') return (n.children || []).map((c) => view.get(c)).filter((c) => c?.anchors).map((c) => ({ anchors: c.anchors, closed: c.closed }));
  return [];
}

const recordsSubpaths = (recs) => recs.flatMap((r) => r.subpaths).filter((s) => s.anchors.length > 1);

/** Polygons of a region (closed, flattened). */
function polygons(subpaths) {
  return subpaths.map((s) => flattenPath(s.anchors, true, TOL)).filter((p) => p.length >= 3);
}

/** Nonzero winding of point p in polygons. */
function inside(polys, p) {
  let wn = 0;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a.y <= p.y) {
        if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) wn++;
      } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) wn--;
    }
  }
  return wn !== 0;
}

/** Parameters (0..1) where segment ab crosses the polygons' edges. */
function crossings(polys, a, b) {
  const out = [];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const c = poly[i];
      const d = poly[(i + 1) % poly.length];
      const ex = d.x - c.x;
      const ey = d.y - c.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
      const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
      if (t > 1e-9 && t < 1 - 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) out.push(t);
    }
  }
  return out.sort((x, y) => x - y);
}

/** The pieces of a polyline inside the region. */
export function clipPolyline(points, polys) {
  const out = [];
  let cur = null;
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const ts = [0, ...crossings(polys, a, b), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      const p0 = lerp(a, b, ts[k]);
      const p1 = lerp(a, b, ts[k + 1]);
      if (inside(polys, lerp(a, b, (ts[k] + ts[k + 1]) / 2))) {
        if (!cur) {
          cur = [p0];
          out.push(cur);
        }
        cur.push(p1);
      } else cur = null;
    }
  }
  return out.filter((l) => l.length >= 2);
}

/** Clip data for everything under clip groups in the export. */
export async function prepareDXF(doc, { ids = null } = {}) {
  const view = exportView(doc);
  const clipped = new Map();
  const visit = async (id, region, depth) => {
    const n = view.get(id);
    if (!n || n.hidden || depth > 64) return;
    if (n.type === 'group' || n.type === 'layer') {
      const kids = n.children || [];
      let next = region;
      let content = kids;
      if (n.clip && kids.length) {
        content = kids.slice(0, -1);
        const mask = view.get(kids[kids.length - 1]);
        const subs = mask ? shapeSubpaths(view, mask).filter((s) => s.anchors.length > 1) : [];
        if (subs.length) {
          const shape = { subpaths: subs.map((s) => ({ ...s, closed: true })), filled: true, evenodd: mask.fillRule === 'evenodd' };
          next = region ? recordsSubpaths(await runGeom(OP.INTERSECT, [{ subpaths: region, filled: true }, shape], [], { tol: 0.01 })) : shape.subpaths;
        }
      }
      for (const c of content) await visit(c, next, depth + 1);
      return;
    }
    if (!region) return;
    const polys = polygons(region);
    if (n.type === 'path' || n.type === 'compound') {
      const subs = shapeSubpaths(view, n);
      const rec = { fill: null, lines: [] };
      if (n.fill && subs.length) {
        const res = await runGeom(OP.INTERSECT, [{ subpaths: subs.map((s) => ({ ...s, closed: true })), filled: true, evenodd: n.fillRule === 'evenodd' }, { subpaths: region, filled: true }], [], { tol: 0.01 });
        rec.fill = recordsSubpaths(res);
      }
      if (n.stroke && n.strokeWidth > 0) {
        for (const s of subs) {
          const pts = flattenPath(s.anchors, s.closed, TOL);
          if (s.closed && pts.length) pts.push({ ...pts[0] });
          rec.lines.push(...clipPolyline(pts, polys));
        }
      }
      clipped.set(n.id, rec);
      return;
    }
    if (n.type === 'image') clipped.set(n.id, { image: polys });
    else if (n.type === 'text') clipped.set(n.id, { text: true });
  };
  const top = ids?.length ? ids : doc.root.children;
  for (const id of top) await visit(id, null, 0);
  // Exported selections inside clip groups keep the masks of their ancestors.
  if (ids?.length) {
    for (const id of ids) {
      const chain = [];
      for (let p = view.get(id)?.parent; p && p !== 'root'; p = view.get(p)?.parent) chain.unshift(p);
      if (!chain.some((p) => view.get(p)?.clip)) continue;
      let region = null;
      for (const p of chain) {
        const g = view.get(p);
        if (!g?.clip || !g.children?.length) continue;
        const mask = view.get(g.children[g.children.length - 1]);
        const subs = mask ? shapeSubpaths(view, mask) : [];
        if (!subs.length) continue;
        const shape = { subpaths: subs.map((s) => ({ ...s, closed: true })), filled: true };
        region = region ? recordsSubpaths(await runGeom(OP.INTERSECT, [{ subpaths: region, filled: true }, shape], [], { tol: 0.01 })) : shape.subpaths;
      }
      if (region) await visit(id, region, 0);
    }
  }
  return { view, clipped };
}
