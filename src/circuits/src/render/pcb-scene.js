// Builds board drawing batches, one per layer, plus the board shape and the
// drill holes. Layers rebuild independently, so an edit on the top layer does
// not touch the bottom layer's buffers.

import { pack } from './color.js';
import { mm } from '../core/units.js';
import { placeFootprint } from '../model/place.js';
import { compFieldPlacement, dimNormal } from '../model/pcb.js';
import { layerColor } from './palette.js';
import { copperLayers } from '../model/layers.js';

const placedCache = new WeakMap();

/** Cached footprint placement (components are immutable values). */
export function placedOf(comp, lib, count) {
  const def = lib[comp.comp];
  const hit = placedCache.get(comp);
  if (hit && hit.def === def && hit.count === count) return hit.placed;
  const placed = placeFootprint(def, comp, count);
  placedCache.set(comp, { def, count, placed });
  return placed;
}

export function drawPadShape(b, p, color, grow = 0) {
  const w = p.w + 2 * grow, h = (p.shape === 'round' ? p.w : p.h) + 2 * grow;
  if (w <= 0 || h <= 0) return;
  switch (p.shape) {
    case 'round': b.circle(p.x, p.y, w / 2, color); break;
    case 'oval': b.rect(p.x, p.y, w, h, p.rot || 0, Math.min(w, h) / 2, color); break;
    case 'roundrect': b.rect(p.x, p.y, w, h, p.rot || 0, Math.min(p.w, p.h) * (p.radius ?? 0.25) + grow, color); break;
    default: b.rect(p.x, p.y, w, h, p.rot || 0, Math.max(0, grow), color);
  }
}

function drawGraphicPcb(b, g, color, defaultW) {
  const w = g.w || defaultW;
  switch (g.t) {
    case 'line': b.line(g.x1, g.y1, g.x2, g.y2, w, color); break;
    case 'polyline': b.polyline(g.pts, w, color); break;
    case 'poly': if (g.fill) b.poly([g.pts], color); else b.polyline(g.pts, w, color, true); break;
    case 'rect':
      if (g.fill) b.rect((g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2, Math.abs(g.x2 - g.x1), Math.abs(g.y2 - g.y1), 0, 0, color);
      else b.rectOutline(g.x1, g.y1, g.x2, g.y2, w, color);
      break;
    // A filled circle's outline adds half its width all round, as in Gerber.
    case 'circle': if (g.fill) b.circle(g.cx, g.cy, g.r + (g.w || 0) / 2, color); else b.ring(g.cx, g.cy, g.r, w, color); break;
    case 'arc': b.arc(g.cx, g.cy, g.r, g.a0, g.sweep, w, color); break;
    case 'text': b.text(g.text, g.x, g.y, g.size, color, { rot: g.rot || 0, align: g.align, mirror: !!g.mirror, upright: true }); break;
    default:
  }
}

/**
 * Emits the primitives of one object into per-layer batches.
 * sink(layer) returns the batch for a layer or null to skip it.
 */
export function emitPcbObject(o, sink, ctx) {
  const { lib, count, pal, colors, rules, pourFills } = ctx;
  const col = (l) => pack(layerColor(l, colors));
  switch (o.t) {
    case 'track': { const b = sink(o.layer); if (b) b.line(o.x1, o.y1, o.x2, o.y2, o.w, col(o.layer)); break; }
    case 'arc': { const b = sink(o.layer); if (b) b.arc(o.cx, o.cy, o.r, o.a0, o.sweep, o.w, col(o.layer)); break; }
    case 'fill': {
      const b = sink(o.layer);
      if (b) b.rect((o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2, Math.abs(o.x2 - o.x1), Math.abs(o.y2 - o.y1), 0, 0, col(o.layer));
      break;
    }
    case 'region': {
      const b = sink(o.layer);
      if (!b) break;
      if (o.layer === 'keepout') { b.poly([o.pts], pack(layerColor('keepout', colors), 0.25)); b.polyline(o.pts, 0, col(o.layer), true); }
      else b.poly([o.pts], col(o.layer));
      break;
    }
    case 'pour': {
      const b = sink(o.layer);
      if (!b) break;
      const fills = pourFills?.get(o.id);
      const c = col(o.layer);
      if (fills && !o.shelved) for (const poly of fills) b.poly(poly, c);
      // Outline shows the pour boundary even when unpoured.
      b.polyline(o.pts, 0, fills && !o.shelved ? pack(layerColor(o.layer, colors), 0.5) : c, true);
      break;
    }
    case 'text': {
      const b = sink(o.layer);
      if (b) b.text(o.text, o.x, o.y, o.h, col(o.layer), { rot: o.rot || 0, mirror: !!o.mirror, w: o.w, align: o.align });
      break;
    }
    case 'dim': {
      const b = sink(o.layer);
      if (!b) break;
      const c = col(o.layer), w = mm(0.1);
      const [nx, ny] = dimNormal(o);
      const ax = o.x1 + nx * o.offset, ay = o.y1 + ny * o.offset, bx = o.x2 + nx * o.offset, by = o.y2 + ny * o.offset;
      const ext = Math.sign(o.offset || 1) * mm(0.8);
      b.line(o.x1, o.y1, ax + nx * ext, ay + ny * ext, w, c);
      b.line(o.x2, o.y2, bx + nx * ext, by + ny * ext, w, c);
      b.line(ax, ay, bx, by, w, c);
      const len = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / len, uy = (by - ay) / len, ah = mm(1), aw = mm(0.35);
      b.poly([[ax, ay, ax + ux * ah + nx * aw, ay + uy * ah + ny * aw, ax + ux * ah - nx * aw, ay + uy * ah - ny * aw]], c);
      b.poly([[bx, by, bx - ux * ah + nx * aw, by - uy * ah + ny * aw, bx - ux * ah - nx * aw, by - uy * ah - ny * aw]], c);
      let ang = Math.atan2(uy, ux) * 180 / Math.PI;
      if (ang > 90 || ang <= -90) ang += 180;
      const label = o.label ?? ctx.formatLength?.(Math.hypot(o.x2 - o.x1, o.y2 - o.y1)) ?? '';
      b.text(label, (ax + bx) / 2 + nx * mm(0.5), (ay + by) / 2 + ny * mm(0.5), o.h || mm(1.2), c, { rot: ang, align: { h: 'center', v: 'bottom' } });
      break;
    }
    case 'via': {
      const m = sink('multi');
      if (m) m.circle(o.x, o.y, o.d / 2, pack(pal.via));
      const holes = sink('holes');
      if (holes) holes.circle(o.x, o.y, o.drill / 2, pack(pal.hole));
      for (const l of ['topSolder', 'bottomSolder']) {
        const b = sink(l);
        if (b && o.tented === false) b.circle(o.x, o.y, o.d / 2 + (rules?.maskExpansion || 0), col(l));
      }
      break;
    }
    case 'pad': emitPad({ ...o, layers: null }, sink, ctx); break;
    case 'comp': {
      const placed = placedOf(o, lib, count);
      const flipped = o.side === 'bottom';
      for (const g of placed.graphics) {
        const l = g.layer || (flipped ? 'bottomOverlay' : 'topOverlay');
        const b = sink(l);
        if (b) drawGraphicPcb(b, g, col(l), rules?.silkWidth || mm(0.15));
      }
      for (const p of placed.pads) emitPad(p, sink, ctx);
      for (const name of ['designator', 'value']) {
        const f = compFieldPlacement(o, name, lib[o.comp]);
        if (f.hidden) continue;
        const txt = name === 'designator' ? o.designator : o.value;
        const b = sink(f.layer);
        if (b && txt) b.text(txt, f.x, f.y, f.h, col(f.layer), { rot: f.rot, mirror: f.mirror, align: { h: 'center', v: 'middle' }, upright: true, w: f.h * 0.15 });
      }
      break;
    }
    default:
  }
}

function emitPad(p, sink, ctx) {
  const { pal, colors, rules } = ctx;
  const col = (l) => pack(layerColor(l, colors));
  if (p.side === 'thru') {
    const m = sink('multi');
    if (m) drawPadShape(m, p, pack(pal.multi));
    const holes = sink('holes');
    if (holes && p.drill) holes.circle(p.x, p.y, p.drill / 2, pack(p.plated === false ? pal.cutout : pal.hole));
    for (const l of ['topSolder', 'bottomSolder']) {
      const b = sink(l);
      if (b) drawPadShape(b, p, col(l), p.maskExpansion ?? rules?.maskExpansion ?? 0);
    }
    return;
  }
  const b = sink(p.side);
  if (b) drawPadShape(b, p, col(p.side));
  const mask = sink(p.side === 'top' ? 'topSolder' : 'bottomSolder');
  if (mask) drawPadShape(mask, p, col(p.side === 'top' ? 'topSolder' : 'bottomSolder'), p.maskExpansion ?? rules?.maskExpansion ?? 0);
  if (!p.noPaste) {
    const paste = sink(p.side === 'top' ? 'topPaste' : 'bottomPaste');
    if (paste) drawPadShape(paste, p, col(p.side === 'top' ? 'topPaste' : 'bottomPaste'), rules?.pasteExpansion || 0);
  }
}

/** Board shape: fill, cutouts and edge. */
export function buildBoardShape(b, board, pal) {
  b.clear();
  if (board?.outline?.length >= 6) {
    b.poly([board.outline, ...(board.cutouts || [])], pack(pal.boardFill));
    b.polyline(board.outline, mm(0.05), pack(pal.boardEdge), true);
    for (const c of board.cutouts || []) b.polyline(c, mm(0.05), pack(pal.boardEdge), true);
  }
  b.touch();
}

/**
 * Rebuilds the given layers' batches.
 * batches: Map<layer, Batch>; layers: iterable of layer ids to rebuild.
 */
export function buildPcbLayers(batches, layers, objects, ctx, hidden) {
  const want = new Set(layers);
  for (const l of want) batches.get(l)?.clear();
  const sink = (l) => (want.has(l) ? batches.get(l) || null : null);
  for (const o of objects) {
    if (hidden?.has(o.id)) continue;
    emitPcbObject(o, sink, ctx);
  }
  for (const l of want) batches.get(l)?.touch();
}

/** Draw order: bottom side first, the active layer last among copper. */
export function layerDrawOrder(count, active, flipped = false) {
  const copper = copperLayers(count);
  const bottomUp = [...copper].reverse();
  let order = [
    'mech2', 'bottomPaste', 'bottomSolder', 'bottomOverlay',
    ...bottomUp,
    'topSolder', 'topPaste', 'multi', 'holes', 'topOverlay', 'mech1', 'courtyard', 'keepout', 'drill',
  ];
  if (flipped) {
    order = ['mech2', 'topPaste', 'topSolder', 'topOverlay', ...copper, 'bottomSolder', 'bottomPaste', 'multi', 'holes', 'bottomOverlay', 'mech1', 'courtyard', 'keepout', 'drill'];
  }
  if (active && copper.includes(active)) {
    order = order.filter((l) => l !== active);
    const i = order.indexOf(flipped ? 'bottomSolder' : 'topSolder');
    order.splice(i, 0, active);
  } else if (active && order.includes(active)) {
    order = order.filter((l) => l !== active);
    order.splice(order.indexOf('holes') + 1, 0, active);
  }
  return order;
}
