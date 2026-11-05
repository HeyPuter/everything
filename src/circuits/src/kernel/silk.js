// Silkscreen over exposed copper. Board makers clip ink at solder mask
// openings, so silk crossing a pad is lost or smears onto the pad; this
// check reports each silkscreen object that overlaps a pad opening.

import RBush from 'rbush';
import { placeFootprint } from '../model/place.js';
import { padPolygon, itemDistance } from '../model/connectivity.js';
import { compFieldPlacement } from '../model/pcb.js';
import { arcToPoints } from '../core/geom.js';
import { textStrokes } from '../render/font.js';

const MAX = 500;

function maskItems(doc, library, copper, expansion) {
  const items = [];
  const add = (p, owner, label) => {
    const grown = { ...p, w: p.w + 2 * expansion, h: (p.shape === 'round' ? p.w : p.h) + 2 * expansion };
    const sides = p.side === 'thru' ? ['top', 'bottom'] : [p.side];
    const base = { owner, label, sides };
    const it = grown.shape === 'round' ? { ...base, kind: 'disc', x: p.x, y: p.y, r: grown.w / 2 } : { ...base, kind: 'poly', pts: padPolygon(grown) };
    const r = Math.hypot(grown.w, grown.h) / 2;
    items.push({ minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r, it });
  };
  for (const o of doc.objects || []) {
    if (o.t === 'comp') {
      for (const p of placeFootprint(library[o.comp], o, copper).pads) add(p, o.id, `${o.designator}-${p.num}`);
    } else if (o.t === 'pad') add(o, o.id, `pad ${o.num || ''}`.trim());
    else if (o.t === 'via' && o.tented === false) add({ x: o.x, y: o.y, w: o.d, h: o.d, shape: 'round', side: 'thru' }, o.id, 'via');
  }
  const tree = new RBush(16);
  tree.load(items);
  return tree;
}

/** Silk segments: { owner, side, x1, y1, x2, y2, r, label }. */
function silkSegments(doc, library, copper) {
  const out = [];
  const side = (layer) => (layer === 'topOverlay' ? 'top' : layer === 'bottomOverlay' ? 'bottom' : null);
  const pushPolyline = (pts, w, owner, s, label, closed = false) => {
    const n = pts.length;
    for (let i = 2; i < n; i += 2) out.push({ owner, side: s, x1: pts[i - 2], y1: pts[i - 1], x2: pts[i], y2: pts[i + 1], r: w / 2, label });
    if (closed && n >= 6) out.push({ owner, side: s, x1: pts[n - 2], y1: pts[n - 1], x2: pts[0], y2: pts[1], r: w / 2, label });
  };
  const graphic = (g, owner, label, defaultW) => {
    const s = side(g.layer);
    if (!s) return;
    const w = g.w || defaultW;
    switch (g.t) {
      case 'line': pushPolyline([g.x1, g.y1, g.x2, g.y2], w, owner, s, label); break;
      case 'polyline': pushPolyline(g.pts, w, owner, s, label); break;
      case 'poly': pushPolyline(g.pts, w, owner, s, label, true); break;
      case 'rect': pushPolyline([g.x1, g.y1, g.x2, g.y1, g.x2, g.y2, g.x1, g.y2], w, owner, s, label, true); break;
      case 'circle': pushPolyline(arcToPoints(g.cx, g.cy, g.r, 0, 360, 5000), w, owner, s, label); break;
      case 'arc': pushPolyline(arcToPoints(g.cx, g.cy, g.r, g.a0, g.sweep, 5000), w, owner, s, label); break;
      default:
    }
  };
  const silkW = doc.rules?.silkWidth || 150_000;
  for (const o of doc.objects || []) {
    if (o.t === 'comp') {
      const def = library[o.comp];
      for (const g of placeFootprint(def, o, copper).graphics) graphic(g, o.id, `${o.designator} outline`, silkW);
      for (const name of ['designator', 'value']) {
        const text = name === 'designator' ? o.designator : o.value;
        const f = compFieldPlacement(o, name, def);
        if (f.hidden || !text) continue;
        for (const pl of textStrokes(text, f.x, f.y, f.h, f.rot, { h: 'center', v: 'middle' }, f.mirror)) pushPolyline(pl, f.h * 0.15, o.id, f.layer === 'bottomOverlay' ? 'bottom' : 'top', `${o.designator} ${name}`);
      }
    } else if (o.t === 'track' || o.t === 'arc') {
      graphic(o.t === 'track' ? { ...o, t: 'line' } : o, o.id, 'silkscreen line', silkW);
    } else if (o.t === 'text' && side(o.layer)) {
      for (const pl of textStrokes(o.text, o.x, o.y, o.h, o.rot || 0, o.align, !!o.mirror)) pushPolyline(pl, o.w || o.h * 0.13, o.id, side(o.layer), `text "${o.text}"`);
    }
  }
  return out;
}

export function silkChecks(doc, library) {
  const copper = doc.board?.copper || 2;
  const expansion = doc.rules?.maskExpansion || 0;
  const pads = maskItems(doc, library, copper, expansion);
  const seen = new Set();
  const out = [];
  for (const s of silkSegments(doc, library, copper)) {
    if (out.length >= MAX) break;
    const box = { minX: Math.min(s.x1, s.x2) - s.r, minY: Math.min(s.y1, s.y2) - s.r, maxX: Math.max(s.x1, s.x2) + s.r, maxY: Math.max(s.y1, s.y2) + s.r };
    for (const { it } of pads.search(box)) {
      if (!it.sides.includes(s.side)) continue;
      const key = `${s.owner}|${it.owner}|${it.label}`;
      if (seen.has(key)) continue;
      if (itemDistance({ kind: 'seg', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, r: s.r }, it) < 0) {
        seen.add(key);
        const x = Math.round((s.x1 + s.x2) / 2), y = Math.round((s.y1 + s.y2) / 2);
        out.push({ rule: 'silk', severity: 'warning', message: `Silkscreen (${s.label}) overlaps pad ${it.label}`, x, y, layer: s.side === 'top' ? 'topOverlay' : 'bottomOverlay', ids: [s.owner, it.owner] });
      }
    }
  }
  return out;
}
