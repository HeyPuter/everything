// Schematic object geometry: bounds for the spatial index, hit testing, and
// the shapes of the editor-drawn objects (power ports, ports, net labels).

import { mil } from '../core/units.js';
import { bboxEmpty, bboxAdd, bboxOfFlat, bboxUnion, distPointSeg, distPointPoly, rotate, arcBBox, distPointArc, pointInPoly } from '../core/geom.js';
import { placeSymbol, fieldPosition } from './place.js';
import { textWidth, uprightText } from '../render/font.js';

export const SCH_TEXT = mil(70);        // default label/designator cap height
export const PIN_TEXT = mil(60);
export const LINE_W = mil(8);           // standard schematic stroke
export const WIRE_W = mil(10);
export const BUS_W = mil(30);
export const JUNCTION_R = mil(22);
export const PORT_H = mil(100);

const symBoxCache = new WeakMap();

/** Local bounding box of a symbol (pins and graphics, not fields). */
export function symbolBox(def) {
  if (!def) return { minX: -mil(100), minY: -mil(100), maxX: mil(100), maxY: mil(100) };
  let b = symBoxCache.get(def);
  if (b) return b;
  b = bboxEmpty();
  for (const p of def.symbol.pins) {
    bboxAdd(b, p.x, p.y);
    const r = (p.rot * Math.PI) / 180;
    bboxAdd(b, p.x + Math.cos(r) * p.length, p.y + Math.sin(r) * p.length);
  }
  for (const g of def.symbol.graphics) {
    const gb = graphicBox(g);
    if (gb) b = bboxUnion(b, gb);
  }
  if (!(b.minX <= b.maxX)) b = { minX: -mil(100), minY: -mil(100), maxX: mil(100), maxY: mil(100) };
  symBoxCache.set(def, b);
  return b;
}

export function graphicBox(g) {
  const pad = (g.w || 0) / 2;
  switch (g.t) {
    case 'line': return bboxAdd(bboxAdd(bboxEmpty(), g.x1, g.y1, pad), g.x2, g.y2, pad);
    case 'polyline': case 'poly': return bboxOfFlat(g.pts, pad);
    case 'rect': return { minX: Math.min(g.x1, g.x2) - pad, minY: Math.min(g.y1, g.y2) - pad, maxX: Math.max(g.x1, g.x2) + pad, maxY: Math.max(g.y1, g.y2) + pad };
    case 'circle': return { minX: g.cx - g.r - pad, minY: g.cy - g.r - pad, maxX: g.cx + g.r + pad, maxY: g.cy + g.r + pad };
    case 'arc': return arcBBox(g.cx, g.cy, g.r, g.a0, g.sweep, pad);
    case 'text': { const u = uprightText(g.rot || 0, g.align); return textBox(g.text, g.x, g.y, g.size, u.rot, u.align); }
    default: return null;
  }
}

/** Approximate box of a text anchored at (x, y). */
export function textBox(text, x, y, size, rot = 0, align = {}) {
  const lines = String(text ?? '').split('\n');
  const w = Math.max(...lines.map((l) => textWidth(l, size)), size * 0.5);
  const h = size * (1 + (lines.length - 1) * 1.6);
  let x0 = 0, y0 = 0;
  if (align?.h === 'center') x0 = -w / 2; else if (align?.h === 'right') x0 = -w;
  if (align?.v === 'middle') y0 = -h / 2; else if (align?.v === 'top') y0 = -h;
  if (lines.length > 1 && align?.v !== 'top' && align?.v !== 'middle') y0 = -(lines.length - 1) * size * 1.6;
  const b = bboxEmpty();
  for (const [cx, cy] of [[x0, y0 - size * 0.3], [x0 + w, y0 - size * 0.3], [x0 + w, y0 + h], [x0, y0 + h]]) {
    const [rx, ry] = rotate(cx, cy, rot);
    bboxAdd(b, x + rx, y + ry);
  }
  return b;
}

/** Display string for a part field. */
export function fieldText(part, name) {
  return name === 'designator' ? part.designator : part.value ?? '';
}

/**
 * Shapes of a power port in local coordinates (rot 0 = symbol above the
 * connection point, as for a supply rail). Returns { lines, polys, circles,
 * textPos } with textPos the label anchor.
 */
export function powerShape(style) {
  const L = mil(100), W = mil(100);
  switch (style) {
    case 'gnd':
      return {
        lines: [[0, 0, 0, -L * 0.6], [-W, -L * 0.6, W, -L * 0.6], [-W * 0.6, -L * 0.85, W * 0.6, -L * 0.85], [-W * 0.25, -L * 1.1, W * 0.25, -L * 1.1]],
        polys: [], circles: [], textPos: { x: 0, y: -L * 1.6, align: { h: 'center', v: 'top' } }, below: true,
      };
    case 'signalgnd':
      return {
        lines: [[0, 0, 0, -L * 0.6]], polys: [[-W, -L * 0.6, W, -L * 0.6, 0, -L * 1.3]], circles: [],
        textPos: { x: 0, y: -L * 1.8, align: { h: 'center', v: 'top' } }, below: true, hollow: true,
      };
    case 'earth':
      return {
        lines: [[0, 0, 0, -L * 0.6], [-W, -L * 0.6, W, -L * 0.6], [-W, -L * 0.6, -W * 1.4, -L * 1.0], [0, -L * 0.6, -W * 0.4, -L * 1.0], [W, -L * 0.6, W * 0.6, -L * 1.0]],
        polys: [], circles: [], textPos: { x: 0, y: -L * 1.5, align: { h: 'center', v: 'top' } }, below: true,
      };
    case 'arrow':
      return {
        lines: [[0, 0, 0, L * 0.6]], polys: [[-W * 0.45, L * 0.6, W * 0.45, L * 0.6, 0, L * 1.1]], circles: [],
        textPos: { x: 0, y: L * 1.3, align: { h: 'center', v: 'bottom' } },
      };
    case 'circle':
      return {
        lines: [[0, 0, 0, L * 0.6]], polys: [], circles: [[0, L * 0.8, L * 0.2]],
        textPos: { x: 0, y: L * 1.2, align: { h: 'center', v: 'bottom' } },
      };
    case 'wave': {
      const pts = [];
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        pts.push(-W * 0.6 + t * W * 1.2, L * 0.75 + Math.sin(t * Math.PI * 2) * L * 0.15);
      }
      return { lines: [[0, 0, 0, L * 0.6]], polys: [], circles: [], wave: pts, textPos: { x: 0, y: L * 1.15, align: { h: 'center', v: 'bottom' } } };
    }
    case 'bar':
    default:
      return {
        lines: [[0, 0, 0, L * 0.6], [-W * 0.75, L * 0.6, W * 0.75, L * 0.6]], polys: [], circles: [],
        textPos: { x: 0, y: L * 0.85, align: { h: 'center', v: 'bottom' } },
      };
  }
}

/** Outline of a port (sheet connector) in local coordinates; rot 0 points right. */
export function portShape(port) {
  const h = PORT_H / 2;
  const w = Math.max(mil(400), textWidth(port.name || '', SCH_TEXT) + mil(200));
  const tip = h;
  let pts;
  switch (port.io) {
    case 'out': pts = [0, -h, w - tip, -h, w, 0, w - tip, h, 0, h]; break;
    case 'in': pts = [tip, -h, w, -h, w, h, tip, h, 0, 0]; break;
    case 'bidir': pts = [tip, -h, w - tip, -h, w, 0, w - tip, h, tip, h, 0, 0]; break;
    default: pts = [0, -h, w, -h, w, h, 0, h];
  }
  return { pts, w };
}

const rot4 = (x, y, r) => rotate(x, y, r || 0);

/** World-space polygon of a port. */
export function portPolygon(o) {
  const { pts, w } = portShape(o);
  const out = [];
  for (let i = 0; i < pts.length; i += 2) {
    const [x, y] = rot4(pts[i], pts[i + 1], o.rot);
    out.push(o.x + x, o.y + y);
  }
  return { pts: out, w };
}

/** Connection points of a schematic object (where wires attach). */
export function connectionPoints(o, lib) {
  switch (o.t) {
    case 'part': return placeSymbol(lib[o.comp], o).pins.map((p) => [p.x, p.y]);
    case 'power': case 'label': case 'noerc': case 'junction': return [[o.x, o.y]];
    case 'port': {
      const { w } = portShape(o);
      const [x, y] = rot4(w, 0, o.rot);
      return [[o.x, o.y], [o.x + x, o.y + y]];
    }
    case 'wire': case 'bus': {
      const out = [];
      for (let i = 0; i < o.pts.length; i += 2) out.push([o.pts[i], o.pts[i + 1]]);
      return out;
    }
    default: return [];
  }
}

/** Bounding box used by the spatial index. */
export function schBounds(o, lib) {
  switch (o.t) {
    case 'part': {
      const def = lib[o.comp];
      const sb = symbolBox(def);
      const pl = placeSymbol(def, o);
      let b = bboxEmpty();
      for (const [x, y] of [[sb.minX, sb.minY], [sb.maxX, sb.minY], [sb.maxX, sb.maxY], [sb.minX, sb.maxY]]) {
        const [wx, wy] = [pl.t.a * x + pl.t.c * y + pl.t.e, pl.t.b * x + pl.t.d * y + pl.t.f];
        bboxAdd(b, wx, wy);
      }
      for (const name of ['designator', 'value']) {
        const f = fieldPosition(o, name, def);
        if (f.hidden) continue;
        const txt = fieldText(o, name);
        if (txt) b = bboxUnion(b, textBox(txt, f.x, f.y, SCH_TEXT));
      }
      return b;
    }
    case 'wire': return bboxOfFlat(o.pts, WIRE_W);
    case 'bus': return bboxOfFlat(o.pts, BUS_W);
    case 'gline': return bboxOfFlat(o.pts, o.w || LINE_W);
    case 'junction': return { minX: o.x - JUNCTION_R, minY: o.y - JUNCTION_R, maxX: o.x + JUNCTION_R, maxY: o.y + JUNCTION_R };
    case 'noerc': { const r = mil(40); return { minX: o.x - r, minY: o.y - r, maxX: o.x + r, maxY: o.y + r }; }
    case 'label': return bboxUnion(textBox(o.text, o.x, o.y + mil(15), SCH_TEXT, o.rot === 180 ? 0 : o.rot === 270 ? 90 : o.rot, o.rot === 180 || o.rot === 270 ? { h: 'right' } : {}), { minX: o.x - mil(20), minY: o.y - mil(20), maxX: o.x + mil(20), maxY: o.y + mil(20) });
    case 'power': {
      const s = powerShape(o.style);
      const b = bboxEmpty();
      bboxAdd(b, -mil(150), -mil(20));
      bboxAdd(b, mil(150), s.below ? -mil(130) : mil(130));
      const tw = textWidth(o.net, SCH_TEXT) / 2 + mil(20);
      bboxAdd(b, -tw, s.textPos.y + (s.below ? -SCH_TEXT - mil(20) : SCH_TEXT + mil(20)));
      bboxAdd(b, tw, s.textPos.y);
      const out = bboxEmpty();
      for (const [x, y] of [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]]) {
        const [rx, ry] = rot4(x, y, o.rot);
        bboxAdd(out, o.x + rx, o.y + ry);
      }
      return out;
    }
    case 'port': return bboxOfFlat(portPolygon(o).pts, mil(10));
    case 'text': { const u = uprightText(o.rot || 0); return textBox(o.text, o.x, o.y, o.size || SCH_TEXT, u.rot, u.align); }
    case 'grect': return { minX: Math.min(o.x1, o.x2), minY: Math.min(o.y1, o.y2), maxX: Math.max(o.x1, o.x2), maxY: Math.max(o.y1, o.y2) };
    case 'gcircle': return { minX: o.cx - o.r, minY: o.cy - o.r, maxX: o.cx + o.r, maxY: o.cy + o.r };
    default: return bboxEmpty();
  }
}

/** Distance from (x, y) to the object, for picking. 0 means inside. */
export function schHitDistance(o, x, y, lib) {
  switch (o.t) {
    case 'part': {
      const def = lib[o.comp];
      const pl = placeSymbol(def, o);
      let d = Infinity;
      // Body: anywhere inside the symbol box picks the part.
      const sb = symbolBox(def);
      const corners = [[sb.minX, sb.minY], [sb.maxX, sb.minY], [sb.maxX, sb.maxY], [sb.minX, sb.maxY]].flatMap(([lx, ly]) => [pl.t.a * lx + pl.t.c * ly + pl.t.e, pl.t.b * lx + pl.t.d * ly + pl.t.f]);
      if (pointInPoly(x, y, corners)) d = 0;
      for (const p of pl.pins) d = Math.min(d, distPointSeg(x, y, p.x, p.y, p.bx, p.by));
      return d;
    }
    case 'wire': case 'bus': case 'gline': {
      let d = Infinity;
      for (let i = 2; i < o.pts.length; i += 2) d = Math.min(d, distPointSeg(x, y, o.pts[i - 2], o.pts[i - 1], o.pts[i], o.pts[i + 1]));
      return d;
    }
    case 'port': return distPointPoly(x, y, portPolygon(o).pts, true);
    case 'grect': {
      const b = schBounds(o, lib);
      if (o.fill && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return 0;
      return Math.min(distPointSeg(x, y, b.minX, b.minY, b.maxX, b.minY), distPointSeg(x, y, b.maxX, b.minY, b.maxX, b.maxY), distPointSeg(x, y, b.maxX, b.maxY, b.minX, b.maxY), distPointSeg(x, y, b.minX, b.maxY, b.minX, b.minY));
    }
    case 'gcircle': {
      const r = Math.hypot(x - o.cx, y - o.cy);
      return o.fill && r <= o.r ? 0 : Math.abs(r - o.r);
    }
    case 'arc': return distPointArc(x, y, o.cx, o.cy, o.r, o.a0, o.sweep);
    default: {
      const b = schBounds(o, lib);
      const dx = Math.max(b.minX - x, 0, x - b.maxX), dy = Math.max(b.minY - y, 0, y - b.maxY);
      return Math.hypot(dx, dy);
    }
  }
}

/** Pick priority: smaller objects win over larger ones when overlapping. */
export const SCH_PICK_ORDER = { junction: 0, noerc: 0, label: 1, power: 1, port: 2, text: 2, wire: 3, bus: 3, part: 4, gline: 5, grect: 6, gcircle: 6 };

/** Moves a schematic object by (dx, dy), returning a new object. */
export function translateSch(o, dx, dy) {
  switch (o.t) {
    case 'wire': case 'bus': case 'gline': return { ...o, pts: o.pts.map((v, i) => v + (i % 2 ? dy : dx)) };
    case 'grect': return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
    case 'gcircle': return { ...o, cx: o.cx + dx, cy: o.cy + dy };
    default: return { ...o, x: o.x + dx, y: o.y + dy };
  }
}

/** Rotates a schematic object 90 degrees CCW about (px, py). */
export function rotateSch(o, px, py, deg = 90) {
  const rp = (x, y) => { const [rx, ry] = rotate(x - px, y - py, deg); return [Math.round(px + rx), Math.round(py + ry)]; };
  const mapPts = (pts) => { const out = []; for (let i = 0; i < pts.length; i += 2) out.push(...rp(pts[i], pts[i + 1])); return out; };
  switch (o.t) {
    case 'wire': case 'bus': case 'gline': return { ...o, pts: mapPts(o.pts) };
    case 'grect': { const [x1, y1] = rp(o.x1, o.y1), [x2, y2] = rp(o.x2, o.y2); return { ...o, x1, y1, x2, y2 }; }
    case 'gcircle': { const [cx, cy] = rp(o.cx, o.cy); return { ...o, cx, cy }; }
    case 'part': {
      const [x, y] = rp(o.x, o.y);
      const fields = o.fields ? Object.fromEntries(Object.entries(o.fields).map(([k, f]) => { const [fx, fy] = rotate(f.dx, f.dy, deg); return [k, { ...f, dx: Math.round(fx), dy: Math.round(fy) }]; })) : o.fields;
      return { ...o, x, y, rot: (((o.rot || 0) + deg) % 360 + 360) % 360, fields };
    }
    default: {
      const [x, y] = rp(o.x, o.y);
      return 'rot' in o || o.t === 'label' || o.t === 'power' || o.t === 'port' ? { ...o, x, y, rot: (((o.rot || 0) + deg) % 360 + 360) % 360 } : { ...o, x, y };
    }
  }
}

/** Mirrors a schematic object across the vertical line x = px (or horizontal y = py). */
export function mirrorSch(o, px, py, axis = 'x') {
  const mx = (x, y) => (axis === 'x' ? [2 * px - x, y] : [x, 2 * py - y]);
  const mapPts = (pts) => { const out = []; for (let i = 0; i < pts.length; i += 2) out.push(...mx(pts[i], pts[i + 1])); return out; };
  switch (o.t) {
    case 'wire': case 'bus': case 'gline': return { ...o, pts: mapPts(o.pts) };
    case 'grect': { const [x1, y1] = mx(o.x1, o.y1), [x2, y2] = mx(o.x2, o.y2); return { ...o, x1, y1, x2, y2 }; }
    case 'gcircle': { const [cx, cy] = mx(o.cx, o.cy); return { ...o, cx, cy }; }
    case 'part': {
      const [x, y] = mx(o.x, o.y);
      // Mirroring about y flips the part; about x is a flip plus a half turn.
      const rot = axis === 'x' ? (360 - (o.rot || 0)) % 360 : (540 - (o.rot || 0)) % 360;
      const fields = o.fields ? Object.fromEntries(Object.entries(o.fields).map(([k, f]) => [k, axis === 'x' ? { ...f, dx: -f.dx } : { ...f, dy: -f.dy }])) : o.fields;
      return { ...o, x, y, mirror: !o.mirror, rot, fields };
    }
    case 'port': case 'label': case 'power': {
      const [x, y] = mx(o.x, o.y);
      const r = o.rot || 0;
      // Ports and labels point along their rotation; a power port's symbol
      // stands a quarter turn from it (rot 0 is above the connection point).
      const across = o.t === 'power' ? axis === 'y' : axis === 'x';
      const rot = across ? (r === 0 ? 180 : r === 180 ? 0 : r) : (r === 90 ? 270 : r === 270 ? 90 : r);
      return { ...o, x, y, rot };
    }
    default: { const [x, y] = mx(o.x, o.y); return { ...o, x, y }; }
  }
}
