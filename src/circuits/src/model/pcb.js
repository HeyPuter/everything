// Board object geometry: bounds, hit testing, transforms, and the layers each
// object touches (used to rebuild only the affected render layers).

import { bboxEmpty, bboxAdd, bboxOfFlat, bboxUnion, distPointSeg, distPointPoly, distPointRect, distPointArc, arcBBox, rotate, norm360, pointInPoly } from '../core/geom.js';
import { placeFootprint } from './place.js';
import { graphicBox, textBox } from './sch.js';
import { copperLayers, flipLayer } from './layers.js';
import { mm } from '../core/units.js';

const fpBoxCache = new WeakMap();

/** Local bounds of a footprint (pads, graphics, courtyard). */
export function footprintBox(def) {
  const fp = def?.footprint;
  if (!fp) return { minX: -mm(0.5), minY: -mm(0.5), maxX: mm(0.5), maxY: mm(0.5) };
  let b = fpBoxCache.get(fp);
  if (b) return b;
  b = bboxEmpty();
  for (const p of fp.pads) {
    const r = Math.hypot(p.w, p.h) / 2;
    bboxAdd(b, p.x, p.y, p.rot ? r : 0);
    if (!p.rot) { bboxAdd(b, p.x - p.w / 2, p.y - p.h / 2); bboxAdd(b, p.x + p.w / 2, p.y + p.h / 2); }
  }
  for (const g of fp.graphics || []) { const gb = graphicBox(g); if (gb) b = bboxUnion(b, gb); }
  if (fp.courtyard) { bboxAdd(b, fp.courtyard.x1, fp.courtyard.y1); bboxAdd(b, fp.courtyard.x2, fp.courtyard.y2); }
  if (!(b.minX <= b.maxX)) b = { minX: -mm(0.5), minY: -mm(0.5), maxX: mm(0.5), maxY: mm(0.5) };
  fpBoxCache.set(fp, b);
  return b;
}

export function compFieldText(comp, name) {
  return name === 'designator' ? comp.designator : comp.value ?? '';
}

/** Designator/value text placement for a board component. */
export function compFieldPlacement(comp, name, def) {
  const f = comp.fields?.[name] || {};
  const fb = footprintBox(def);
  const h = f.h || mm(1);
  const hidden = f.hidden ?? name === 'value';
  // Default: designator beyond the footprint's top edge, value beyond its bottom
  // edge, turning with the part (the local offset has no x, so the bottom-side
  // mirror leaves it as is).
  const dx = f.dx ?? 0;
  const dy = f.dy ?? (name === 'designator' ? fb.maxY + h * 0.5 : fb.minY - h * 1.5);
  const [rx, ry] = f.dx === undefined && f.dy === undefined ? rotate(dx, dy, comp.rot || 0) : [dx, dy];
  const bottom = comp.side === 'bottom';
  const x = comp.x + rx, y = comp.y + ry;
  return { x, y, h, rot: f.rot ?? norm360(comp.rot || 0), hidden, layer: bottom ? 'bottomOverlay' : 'topOverlay', mirror: bottom };
}

export function pcbBounds(o, lib) {
  switch (o.t) {
    case 'comp': {
      const def = lib[o.comp];
      const fb = footprintBox(def);
      const b = bboxEmpty();
      const m = o.side === 'bottom' ? -1 : 1;
      for (const [x, y] of [[fb.minX, fb.minY], [fb.maxX, fb.minY], [fb.maxX, fb.maxY], [fb.minX, fb.maxY]]) {
        const [rx, ry] = rotate(x * m, y, o.rot || 0);
        bboxAdd(b, o.x + rx, o.y + ry);
      }
      const f = compFieldPlacement(o, 'designator', def);
      if (!f.hidden) return bboxUnion(b, textBox(o.designator, f.x, f.y, f.h, f.rot, { h: 'center', v: 'middle' }));
      return b;
    }
    case 'track': return bboxAdd(bboxAdd(bboxEmpty(), o.x1, o.y1, o.w / 2), o.x2, o.y2, o.w / 2);
    case 'arc': return arcBBox(o.cx, o.cy, o.r, o.a0, o.sweep, o.w / 2);
    case 'via': return { minX: o.x - o.d / 2, minY: o.y - o.d / 2, maxX: o.x + o.d / 2, maxY: o.y + o.d / 2 };
    case 'pad': { const r = Math.hypot(o.w, o.h) / 2; return { minX: o.x - r, minY: o.y - r, maxX: o.x + r, maxY: o.y + r }; }
    case 'fill': return { minX: Math.min(o.x1, o.x2), minY: Math.min(o.y1, o.y2), maxX: Math.max(o.x1, o.x2), maxY: Math.max(o.y1, o.y2) };
    case 'pour': case 'region': return bboxOfFlat(o.pts);
    case 'text': return textBox(o.text, o.x, o.y, o.h, o.rot || 0, o.align || {});
    case 'dim': {
      const b = bboxEmpty();
      const [nx, ny] = dimNormal(o);
      bboxAdd(b, o.x1, o.y1); bboxAdd(b, o.x2, o.y2);
      bboxAdd(b, o.x1 + nx * o.offset, o.y1 + ny * o.offset, o.h * 2);
      bboxAdd(b, o.x2 + nx * o.offset, o.y2 + ny * o.offset, o.h * 2);
      return b;
    }
    default: return bboxEmpty();
  }
}

export function dimNormal(o) {
  const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
  const l = Math.hypot(dx, dy) || 1;
  return [-dy / l, dx / l];
}

/** Layers an object draws on (pads expand to their copper span). */
export function objectLayers(o, lib, copperCount = 2) {
  switch (o.t) {
    case 'comp': {
      const out = new Set(['multi']);
      const def = lib[o.comp];
      const flip = o.side === 'bottom' ? flipLayer : (l) => l;
      out.add(o.side === 'bottom' ? 'bottomOverlay' : 'topOverlay');
      for (const g of def?.footprint?.graphics || []) out.add(flip(g.layer || 'topOverlay'));
      for (const p of def?.footprint?.pads || []) {
        if (p.side === 'thru') { out.add('multi'); for (const l of copperLayers(copperCount)) out.add(l); out.add('topSolder'); out.add('bottomSolder'); }
        else { const s = flip(p.side); out.add(s); out.add(s === 'top' ? 'topSolder' : 'bottomSolder'); out.add(s === 'top' ? 'topPaste' : 'bottomPaste'); }
      }
      return [...out];
    }
    case 'via': return ['multi', 'drill', ...copperLayers(copperCount)];
    case 'pad': return o.side === 'thru' ? ['multi', ...copperLayers(copperCount)] : [o.side];
    default: return [o.layer];
  }
}

/** Is the object on (or spanning) the given layer? */
export function onLayer(o, layer, lib, copperCount) {
  if (o.layer) return o.layer === layer;
  return objectLayers(o, lib, copperCount).includes(layer);
}

/** Distance from (x, y) to a pad in world space. */
export function padDistance(p, x, y) {
  if (p.shape === 'round') return Math.max(0, Math.hypot(x - p.x, y - p.y) - p.w / 2);
  const r = p.shape === 'oval' ? Math.min(p.w, p.h) / 2 : p.shape === 'roundrect' ? Math.min(p.w, p.h) * (p.radius ?? 0.25) : 0;
  return distPointRect(x, y, p.x, p.y, p.w, p.h, p.rot || 0, r);
}

/**
 * Picks: distance from (x, y) to the object restricted to visible layers.
 * Returns Infinity when the object is not on a pickable layer.
 */
export function pcbHitDistance(o, x, y, lib, { layers, copperCount = 2, pads = true } = {}) {
  const vis = (l) => !layers || layers.has(l);
  switch (o.t) {
    case 'track': return vis(o.layer) ? Math.max(0, distPointSeg(x, y, o.x1, o.y1, o.x2, o.y2) - o.w / 2) : Infinity;
    case 'arc': return vis(o.layer) ? Math.max(0, distPointArc(x, y, o.cx, o.cy, o.r, o.a0, o.sweep) - o.w / 2) : Infinity;
    case 'via': return vis('multi') || copperLayers(copperCount).some(vis) ? Math.max(0, Math.hypot(x - o.x, y - o.y) - o.d / 2) : Infinity;
    case 'pad': return Math.max(0, padDistance(o, x, y));
    case 'fill': {
      if (!vis(o.layer)) return Infinity;
      const b = pcbBounds(o);
      return Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minY - y, 0, y - b.maxY));
    }
    case 'pour': return vis(o.layer) ? polyOutlineDistance(o.pts, x, y) : Infinity;
    case 'region': return vis(o.layer) ? distPointPoly(x, y, o.pts, true) : Infinity;
    case 'text': {
      if (!vis(o.layer)) return Infinity;
      const b = pcbBounds(o);
      return Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minY - y, 0, y - b.maxY));
    }
    case 'dim': {
      if (!vis(o.layer)) return Infinity;
      const [nx, ny] = dimNormal(o);
      return distPointSeg(x, y, o.x1 + nx * o.offset, o.y1 + ny * o.offset, o.x2 + nx * o.offset, o.y2 + ny * o.offset);
    }
    case 'comp': {
      const def = lib[o.comp];
      const side = o.side === 'bottom' ? 'bottomOverlay' : 'topOverlay';
      let d = Infinity;
      const placed = placeFootprint(def, o, copperCount);
      if (pads) for (const p of placed.pads) {
        const pl = p.side === 'thru' ? 'multi' : p.side;
        if (vis(pl) || (p.side === 'thru' && copperLayers(copperCount).some(vis))) d = Math.min(d, padDistance(p, x, y));
      }
      if (vis(side) || vis(o.side)) {
        if (placed.courtyard && pointInPoly(x, y, placed.courtyard)) d = 0;
        else {
          const b = footprintBox(def);
          const [lx, ly] = rotate(x - o.x, y - o.y, -(o.rot || 0));
          const ux = o.side === 'bottom' ? -lx : lx;
          if (ux >= b.minX && ux <= b.maxX && ly >= b.minY && ly <= b.maxY) d = 0;
        }
      }
      return d;
    }
    default: return Infinity;
  }
}

function polyOutlineDistance(pts, x, y) {
  let d = Infinity;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) d = Math.min(d, distPointSeg(x, y, pts[j], pts[j + 1], pts[i], pts[i + 1]));
  return d;
}

/** Pick priority (lower wins when two objects are equally close). */
export const PCB_PICK_ORDER = { via: 0, pad: 0, track: 1, arc: 1, text: 2, dim: 2, comp: 3, fill: 4, region: 5, pour: 6 };

export function translatePcb(o, dx, dy) {
  switch (o.t) {
    case 'track': case 'fill': case 'dim': return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
    case 'arc': return { ...o, cx: o.cx + dx, cy: o.cy + dy };
    case 'pour': case 'region': return { ...o, pts: o.pts.map((v, i) => v + (i % 2 ? dy : dx)) };
    default: return { ...o, x: o.x + dx, y: o.y + dy };
  }
}

/** Rotates an object about (px, py) by deg degrees CCW. */
export function rotatePcb(o, px, py, deg) {
  const rp = (x, y) => { const [rx, ry] = rotate(x - px, y - py, deg); return [Math.round(px + rx), Math.round(py + ry)]; };
  switch (o.t) {
    case 'track': case 'dim': { const [x1, y1] = rp(o.x1, o.y1), [x2, y2] = rp(o.x2, o.y2); return { ...o, x1, y1, x2, y2 }; }
    case 'fill': {
      const pts = [o.x1, o.y1, o.x2, o.y1, o.x2, o.y2, o.x1, o.y2];
      if (deg % 90 === 0) { const [x1, y1] = rp(o.x1, o.y1), [x2, y2] = rp(o.x2, o.y2); return { ...o, x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) }; }
      const out = []; for (let i = 0; i < 8; i += 2) out.push(...rp(pts[i], pts[i + 1]));
      return { id: o.id, t: 'region', layer: o.layer, net: o.net, pts: out };
    }
    case 'arc': { const [cx, cy] = rp(o.cx, o.cy); return { ...o, cx, cy, a0: norm360(o.a0 + deg) }; }
    case 'pour': case 'region': { const out = []; for (let i = 0; i < o.pts.length; i += 2) out.push(...rp(o.pts[i], o.pts[i + 1])); return { ...o, pts: out }; }
    case 'comp': {
      const [x, y] = rp(o.x, o.y);
      const fields = o.fields ? Object.fromEntries(Object.entries(o.fields).map(([k, f]) => {
        if (f.dx === undefined) return [k, f];
        const [fx, fy] = rotate(f.dx, f.dy, deg);
        return [k, { ...f, dx: Math.round(fx), dy: Math.round(fy), rot: norm360((f.rot ?? o.rot ?? 0) + deg) }];
      })) : o.fields;
      return { ...o, x, y, rot: norm360((o.rot || 0) + deg), fields };
    }
    case 'pad': case 'text': { const [x, y] = rp(o.x, o.y); return { ...o, x, y, rot: norm360((o.rot || 0) + deg) }; }
    default: { const [x, y] = rp(o.x, o.y); return { ...o, x, y }; }
  }
}

/** Flips a component to the other side of the board (mirrors about its origin). */
export function flipComp(o) {
  const fields = o.fields ? Object.fromEntries(Object.entries(o.fields).map(([k, f]) => [k, f.dx === undefined ? f : { ...f, dx: -f.dx }])) : o.fields;
  return { ...o, side: o.side === 'bottom' ? 'top' : 'bottom', rot: norm360(-(o.rot || 0)), fields };
}

/** Pad rotation for display uses the placed footprint (see placeFootprint). */
export { placeFootprint };
