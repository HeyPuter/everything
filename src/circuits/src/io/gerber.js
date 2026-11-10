// Gerber RS-274X (X2) export: one file per copper, silkscreen, solder mask and
// paste layer plus the board profile. Coordinates use the 4.6 millimetre
// format, which is exactly one nanometre per unit, so design coordinates are
// written without rounding.

import { placeFootprint } from '../model/place.js';
import { copperLayers, spanLayers, LAYERS } from '../model/layers.js';
import { defaultRules } from '../model/schema.js';
import { compFieldPlacement, dimNormal } from '../model/pcb.js';
import { rotate, norm360, polyArea, arcToPoints } from '../core/geom.js';
import { textStrokes, strokeWidthFor } from '../render/font.js';
import { formatLength } from '../core/units.js';
import { defOf, fillOf, baseName, mmStr } from './common.js';

const MIN_APERTURE = 10_000; // 0.01 mm, used when a stroke has no width
const PROFILE_WIDTH = 100_000;
const MAX_ARC_RADIUS = 1e9; // 1 m: centre offsets (I, J) must fit the 4.6 format (< 10 000 mm)
export const SOFTWARE = 'Circuits';
export const SOFTWARE_VERSION = '0.1';

/** Builds one Gerber file. Apertures are collected while drawing and emitted first. */
export class GerberWriter {
  constructor({ fileFunction, polarity = 'Positive', origin = { x: 0, y: 0 }, date = null, comment = '' }) {
    this.fileFunction = fileFunction;
    this.polarity = polarity;
    this.ox = origin?.x || 0;
    this.oy = origin?.y || 0;
    this.date = date;
    this.comment = comment;
    this.apertures = new Map(); // key -> { code, def, func }
    this.macros = [];
    this.body = [];
    this.current = null;
    this.mode = 'G01';
    this.net = null;
    this.lpd = true;
    this.nextCode = 10;
    this.objects = 0;
  }

  coord(x, y) {
    return `X${Math.round(x - this.ox)}Y${Math.round(y - this.oy)}`;
  }

  aperture(key, def, func = null) {
    let ap = this.apertures.get(key);
    if (!ap) {
      ap = { code: this.nextCode++, def, func };
      this.apertures.set(key, ap);
    }
    return ap.code;
  }

  circle(d, func) {
    const dd = Math.max(Math.round(d), MIN_APERTURE);
    return this.aperture(`C${dd}${func || ''}`, `C,${mmStr(dd)}`, func);
  }

  macro(lines) {
    const name = `M${this.macros.length}`;
    this.macros.push(`%AM${name}*\n${lines.join('\n')}%`);
    return name;
  }

  use(code) {
    if (this.current !== code) { this.body.push(`D${code}*`); this.current = code; }
  }

  setNet(net) {
    const n = net || null;
    if (n === this.net) return;
    if (this.net !== null) this.body.push('%TD.N*%');
    if (n !== null) this.body.push(`%TO.N,${escapeAttr(n)}*%`);
    this.net = n;
  }

  polarityDark(dark) {
    if (dark === this.lpd) return;
    this.body.push(dark ? '%LPD*%' : '%LPC*%');
    this.lpd = dark;
  }

  linear() {
    if (this.mode !== 'G01') { this.body.push('G01*'); this.mode = 'G01'; }
  }

  flash(code, x, y) {
    this.use(code);
    this.body.push(`${this.coord(x, y)}D03*`);
    this.objects++;
  }

  /** Strokes a polyline with a round aperture of diameter w. */
  polyline(pts, w, closed = false, func = null) {
    if (!pts || pts.length < 2) return;
    const code = this.circle(w, func);
    this.use(code);
    this.linear();
    if (pts.length === 2) {
      this.body.push(`${this.coord(pts[0], pts[1])}D03*`);
      this.objects++;
      return;
    }
    this.body.push(`${this.coord(pts[0], pts[1])}D02*`);
    for (let i = 2; i < pts.length; i += 2) this.body.push(`${this.coord(pts[i], pts[i + 1])}D01*`);
    if (closed && (pts[pts.length - 2] !== pts[0] || pts[pts.length - 1] !== pts[1])) this.body.push(`${this.coord(pts[0], pts[1])}D01*`);
    this.objects++;
  }

  line(x1, y1, x2, y2, w, func = null) {
    if (x1 === x2 && y1 === y2) {
      this.flash(this.circle(w, func), x1, y1);
      return;
    }
    this.polyline([x1, y1, x2, y2], w, false, func);
  }

  /** Counter-clockwise arc of radius r from angle a0 sweeping sweep degrees. */
  arc(cx, cy, r, a0, sweep, w, func = null) {
    if (r > MAX_ARC_RADIUS) {
      // The centre offset would overflow the 4.6 format: draw short chords.
      const pts = arcToPoints(cx, cy, r, a0, Math.min(sweep, 360), 1000).map(Math.round);
      this.polyline(pts, w, false, func);
      return;
    }
    const code = this.circle(w, func);
    this.use(code);
    const full = sweep >= 360;
    const s = (a0 * Math.PI) / 180, e = ((a0 + (full ? 360 : sweep)) * Math.PI) / 180;
    const sx = Math.round(cx + r * Math.cos(s)), sy = Math.round(cy + r * Math.sin(s));
    const ex = full ? sx : Math.round(cx + r * Math.cos(e)), ey = full ? sy : Math.round(cy + r * Math.sin(e));
    this.body.push(`${this.coord(sx, sy)}D02*`);
    this.body.push(`G03${this.coord(ex, ey)}I${Math.round(cx - sx)}J${Math.round(cy - sy)}D01*`);
    this.mode = 'G03';
    this.objects++;
  }

  /** Filled region from one or more closed rings (each ring is filled; no holes). */
  region(rings) {
    const valid = rings.filter((r) => r && r.length >= 6);
    if (!valid.length) return;
    this.linear();
    this.body.push('G36*');
    for (const ring of valid) {
      this.body.push(`${this.coord(ring[0], ring[1])}D02*`);
      for (let i = 2; i < ring.length; i += 2) this.body.push(`${this.coord(ring[i], ring[i + 1])}D01*`);
      if (ring[ring.length - 2] !== ring[0] || ring[ring.length - 1] !== ring[1]) this.body.push(`${this.coord(ring[0], ring[1])}D01*`);
    }
    this.body.push('G37*');
    this.objects++;
  }

  toString() {
    const head = [
      `%TF.GenerationSoftware,${SOFTWARE},${SOFTWARE},${SOFTWARE_VERSION}*%`,
    ];
    if (this.date) head.push(`%TF.CreationDate,${this.date}*%`);
    head.push(`%TF.FileFunction,${this.fileFunction}*%`, `%TF.FilePolarity,${this.polarity}*%`);
    if (this.comment) head.push(`G04 ${this.comment.replace(/[*%]/g, '')}*`);
    head.push('%FSLAX46Y46*%', '%MOMM*%', '%LPD*%', 'G75*', 'G01*');
    const defs = [...this.macros];
    for (const ap of [...this.apertures.values()].sort((a, b) => a.code - b.code)) {
      if (ap.func) defs.push(`%TA.AperFunction,${ap.func}*%`);
      defs.push(`%ADD${ap.code}${ap.def}*%`);
      if (ap.func) defs.push('%TD*%');
    }
    const tail = [];
    if (this.net !== null) tail.push('%TD.N*%');
    tail.push('M02*');
    return [...head, ...defs, ...this.body, ...tail].join('\n') + '\n';
  }
}

function escapeAttr(s) {
  return String(s).replace(/[%*,\\]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const fmt = (nm) => mmStr(nm);
const CENTER = { h: 'center', v: 'middle' };

/**
 * Flashes a pad shape grown by expansion (negative shrinks). Rotated shapes
 * and rounded rectangles become aperture macros with the geometry baked in.
 */
export function flashPad(g, pad, expansion = 0, func = null) {
  const e = expansion || 0;
  const shape = pad.shape || 'rect';
  let w = pad.w + 2 * e;
  let h = (shape === 'round' ? pad.w : pad.h) + 2 * e;
  if (w <= 0 || h <= 0) return;
  const rot = norm360(pad.rot || 0);
  if (shape === 'round' || (shape === 'oval' && w === h)) {
    g.flash(g.circle(Math.min(w, h), func), pad.x, pad.y);
    return;
  }
  let radius = 0;
  if (shape === 'roundrect') radius = Math.max(0, Math.min(0.5, pad.radius ?? 0.25) * Math.min(pad.w, pad.h) + e);
  if (shape === 'oval') radius = Math.min(w, h) / 2;
  const quarter = rot % 90 === 0;
  if (quarter && (rot === 90 || rot === 270)) [w, h] = [h, w];
  if (quarter && shape === 'rect') {
    g.flash(g.aperture(`R${w}x${h}${func || ''}`, `R,${fmt(w)}X${fmt(h)}`, func), pad.x, pad.y);
    return;
  }
  if (quarter && shape === 'oval') {
    g.flash(g.aperture(`O${w}x${h}${func || ''}`, `O,${fmt(w)}X${fmt(h)}`, func), pad.x, pad.y);
    return;
  }
  // w and h are already swapped for quarter turns, so the macro needs no rotation then.
  const mrot = quarter ? 0 : rot;
  const key = `M${shape}:${w}:${h}:${mrot}:${radius}:${func || ''}`;
  let ap = g.apertures.get(key);
  if (!ap) {
    const name = g.macro(roundedRectMacro(w, h, Math.min(radius, Math.min(w, h) / 2), mrot));
    g.aperture(key, name, func);
    ap = g.apertures.get(key);
  }
  g.flash(ap.code, pad.x, pad.y);
}

/** Macro primitives for a rotated rectangle with rounded corners (radius may be 0). */
function roundedRectMacro(w, h, r, rot) {
  const out = [];
  const outline = (hw, hh) => {
    const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]].map(([x, y]) => rotate(x, y, rot));
    out.push(`4,1,4,${pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(',')},0*`);
  };
  if (r <= 0) {
    outline(w / 2, h / 2);
    return out;
  }
  if (w - 2 * r > 0) outline(w / 2 - r, h / 2);
  if (h - 2 * r > 0) outline(w / 2, h / 2 - r);
  const cx = w / 2 - r, cy = h / 2 - r;
  const centers = cx === 0 && cy === 0 ? [[0, 0]] : cx === 0 ? [[0, cy], [0, -cy]] : cy === 0 ? [[cx, 0], [-cx, 0]] : [[cx, cy], [-cx, cy], [-cx, -cy], [cx, -cy]];
  for (const [x, y] of centers) {
    const [rx, ry] = rotate(x, y, rot);
    out.push(`1,1,${fmt(2 * r)},${fmt(rx)},${fmt(ry)}*`);
  }
  return out;
}

/** Draws a footprint or board graphic primitive in world coordinates. */
function drawGraphic(g, prim, defaultWidth) {
  const w = prim.w > 0 ? prim.w : defaultWidth;
  switch (prim.t) {
    case 'line':
      g.line(prim.x1, prim.y1, prim.x2, prim.y2, w);
      break;
    case 'polyline':
      g.polyline(prim.pts, w, false);
      break;
    case 'poly':
      if (prim.fill) g.region([prim.pts]);
      else g.polyline(prim.pts, w, true);
      break;
    case 'rect': {
      const ring = [prim.x1, prim.y1, prim.x2, prim.y1, prim.x2, prim.y2, prim.x1, prim.y2];
      if (prim.fill) g.region([ring]);
      else g.polyline(ring, w, true);
      break;
    }
    case 'circle':
      if (prim.fill) g.flash(g.circle(2 * prim.r + (prim.w || 0)), prim.cx, prim.cy);
      else g.arc(prim.cx, prim.cy, prim.r, 0, 360, w);
      break;
    case 'arc':
      g.arc(prim.cx, prim.cy, prim.r, prim.a0, prim.sweep, w);
      break;
    case 'text': {
      const { text, x, y, size, rot, align, mirror } = prim;
      drawText(g, text, x, y, size, rot || 0, align, !!mirror, prim.w, true);
      break;
    }
    default:
      break;
  }
}

function drawText(g, text, x, y, size, rot, align, mirror, w, upright = false) {
  if (!text || !(size > 0)) return;
  const sw = w > 0 ? w : strokeWidthFor(size);
  let r = norm360(rot || 0);
  let al = align;
  // Same rule as the canvas: upright text is turned so it never reads upside down.
  if (upright && r > 90 && r <= 270) {
    r = norm360(r + 180);
    al = flipAlign(align);
  }
  for (const s of textStrokes(text, x, y, size, r, al, mirror)) g.polyline(s.map(Math.round), sw);
}

function flipAlign(align = {}) {
  const h = align.h === 'left' || !align.h ? 'right' : align.h === 'right' ? 'left' : 'center';
  const v = align.v === 'bottom' || !align.v ? 'top' : align.v === 'top' ? 'bottom' : 'middle';
  return { h, v };
}

/**
 * Pour fill polygons ({ net, rings }) of every pour on a layer, drawn largest
 * first: outer ring dark, holes clear. Sorting across all pours matters: a
 * clear hole erases everything drawn before it, so a pour sitting inside
 * another pour's hole must be drawn after that hole.
 */
function drawPolygonSet(g, polygons) {
  const list = polygons.filter((p) => p.rings && p.rings[0] && p.rings[0].length >= 6);
  list.sort((a, b) => Math.abs(polyArea(b.rings[0])) - Math.abs(polyArea(a.rings[0])));
  for (const { net, rings } of list) {
    g.polarityDark(true);
    g.setNet(net);
    g.region([rings[0]]);
    const holes = rings.slice(1).filter((r) => r.length >= 6);
    if (holes.length) {
      g.polarityDark(false);
      g.region(holes);
    }
  }
  g.polarityDark(true);
}

/** Resolves the board once: footprints, rules and helpers used by every layer. */
export function resolveBoard(boardDoc, library) {
  const board = boardDoc.board || {};
  const copper = board.copper || 2;
  const rules = { ...defaultRules(), ...(boardDoc.rules || {}) };
  const objects = boardDoc.objects || [];
  const comps = [];
  for (const o of objects) {
    if (o.t !== 'comp') continue;
    const def = defOf(library, o.comp);
    const placed = placeFootprint(def, o, copper);
    comps.push({ comp: o, def, placed });
  }
  return { board, copper, rules, objects, comps, origin: board.origin || { x: 0, y: 0 } };
}

/**
 * Visible designator and value texts of a component, placed exactly as the
 * board canvas draws them (and as the silkscreen check sees them).
 */
export function fieldTexts(comp, def) {
  const out = [];
  for (const name of ['designator', 'value']) {
    const text = name === 'designator' ? comp.designator : comp.value;
    if (!text) continue;
    const f = compFieldPlacement(comp, name, def);
    if (f.hidden) continue;
    const { x, y, h, rot, mirror, layer } = f;
    out.push({ text, x, y, h, rot, mirror, layer, w: h * 0.15 });
  }
  return out;
}

function padFunction(pad) {
  return pad.side === 'thru' ? 'ComponentPad' : 'SMDPad,CuDef';
}

function writeCopper(ctx, layer, opts) {
  const { objects, comps, copper, rules } = ctx;
  const order = copperLayers(copper);
  const n = order.indexOf(layer) + 1;
  const pos = layer === 'top' ? 'Top' : layer === 'bottom' ? 'Bot' : 'Inr';
  const g = new GerberWriter({ fileFunction: `Copper,L${n},${pos}`, origin: ctx.origin, date: opts.date });
  // Pours first so clear-polarity holes never erase other copper.
  const pourPolygons = [];
  for (const o of objects) {
    if (o.t !== 'pour' || o.layer !== layer) continue;
    for (const rings of fillOf(opts.pourFills, o.id) || []) {
      pourPolygons.push({ net: o.net, rings });
    }
  }
  drawPolygonSet(g, pourPolygons);
  for (const o of objects) {
    if (o.layer !== layer) continue;
    if (o.t === 'fill') { g.setNet(o.net); g.region([[o.x1, o.y1, o.x2, o.y1, o.x2, o.y2, o.x1, o.y2]]); }
    else if (o.t === 'region') { g.setNet(o.net); g.region([o.pts]); }
  }
  for (const o of objects) {
    if (o.layer !== layer) continue;
    if (o.t === 'track') { g.setNet(o.net); g.line(o.x1, o.y1, o.x2, o.y2, o.w, 'Conductor'); }
    else if (o.t === 'arc') { g.setNet(o.net); g.arc(o.cx, o.cy, o.r, o.a0, o.sweep, o.w, 'Conductor'); }
    else if (o.t === 'text') { g.setNet(null); drawText(g, o.text, o.x, o.y, o.h, o.rot || 0, o.align, !!o.mirror, o.w); }
  }
  for (const { placed } of comps) {
    g.setNet(null);
    for (const prim of placed.graphics) if (prim.layer === layer) drawGraphic(g, prim, rules.silkWidth);
    for (const pad of placed.pads) {
      if (!pad.layers.copper.includes(layer)) continue;
      if (pad.side === 'thru' && pad.plated === false && pad.w <= (pad.drill || 0)) continue;
      g.setNet(pad.net);
      flashPad(g, pad, 0, padFunction(pad));
    }
  }
  for (const o of objects) {
    if (o.t === 'pad') {
      const side = o.side || 'top';
      const layers = side === 'thru' ? order : [side];
      if (!layers.includes(layer)) continue;
      if (side === 'thru' && o.plated === false && o.w <= (o.drill || 0)) continue;
      g.setNet(o.net);
      flashPad(g, o, 0, side === 'thru' ? 'ComponentPad' : 'SMDPad,CuDef');
    } else if (o.t === 'via') {
      if (!spanLayers(o.from || 'top', o.to || 'bottom', copper).includes(layer)) continue;
      g.setNet(o.net);
      g.flash(g.circle(o.d, 'ViaPad'), o.x, o.y);
    }
  }
  g.setNet(null);
  return g;
}

/**
 * Draws a free board drawing (line, arc, text or filled shape) of a
 * non-copper layer, so every layer file shows what the canvas shows.
 */
function drawBoardDrawing(g, o, defaultWidth, units) {
  if (o.t === 'dim') drawDimension(g, o, units);
  else if (o.t === 'track') g.line(o.x1, o.y1, o.x2, o.y2, o.w || defaultWidth);
  else if (o.t === 'arc') g.arc(o.cx, o.cy, o.r, o.a0, o.sweep, o.w || defaultWidth);
  else if (o.t === 'text') drawText(g, o.text, o.x, o.y, o.h, o.rot || 0, o.align, !!o.mirror, o.w);
  else if (o.t === 'region') g.region([o.pts]);
  else if (o.t === 'fill') g.region([[o.x1, o.y1, o.x2, o.y1, o.x2, o.y2, o.x1, o.y2]]);
}

/**
 * A dimension with the geometry the canvas draws (see pcb-scene.js): two
 * extension lines, the dimension line with an arrowhead at each end, and the
 * measured length (or the stored label) above its middle.
 */
function drawDimension(g, o, units = 'mm') {
  const w = 100_000, ah = 1_000_000, aw = 350_000;
  const [nx, ny] = dimNormal(o);
  const off = o.offset || 0;
  const ax = o.x1 + nx * off, ay = o.y1 + ny * off, bx = o.x2 + nx * off, by = o.y2 + ny * off;
  const ext = Math.sign(off || 1) * 800_000;
  g.line(o.x1, o.y1, ax + nx * ext, ay + ny * ext, w);
  g.line(o.x2, o.y2, bx + nx * ext, by + ny * ext, w);
  g.line(ax, ay, bx, by, w);
  const len = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / len, uy = (by - ay) / len;
  g.region([[ax, ay, ax + ux * ah + nx * aw, ay + uy * ah + ny * aw, ax + ux * ah - nx * aw, ay + uy * ah - ny * aw]]);
  g.region([[bx, by, bx - ux * ah + nx * aw, by - uy * ah + ny * aw, bx - ux * ah - nx * aw, by - uy * ah - ny * aw]]);
  let ang = (Math.atan2(uy, ux) * 180) / Math.PI;
  if (ang > 90 || ang <= -90) ang += 180;
  const label = o.label ?? formatLength(Math.hypot(o.x2 - o.x1, o.y2 - o.y1), units);
  const align = { h: 'center', v: 'bottom' };
  drawText(g, label, (ax + bx) / 2 + nx * 500_000, (ay + by) / 2 + ny * 500_000, o.h || 1_200_000, ang, align, false, 0);
}

function writeOverlay(ctx, layer, opts) {
  const side = layer === 'topOverlay' ? 'Top' : 'Bot';
  const g = new GerberWriter({ fileFunction: `Legend,${side}`, origin: ctx.origin, date: opts.date });
  const { objects, comps, rules } = ctx;
  for (const o of objects) if (o.layer === layer) drawBoardDrawing(g, o, rules.silkWidth, opts.units);
  for (const { comp, def, placed } of comps) {
    for (const prim of placed.graphics) if (prim.layer === layer) drawGraphic(g, prim, rules.silkWidth);
    for (const f of fieldTexts(comp, def)) {
      if (f.layer === layer) drawText(g, f.text, f.x, f.y, f.h, f.rot, CENTER, f.mirror, f.w, true);
    }
  }
  return g;
}

function writeMask(ctx, layer, opts) {
  const side = layer === 'topSolder' ? 'Top' : 'Bot';
  const g = new GerberWriter({ fileFunction: `Soldermask,${side}`, polarity: 'Negative', origin: ctx.origin, date: opts.date });
  const { objects, comps, rules, copper } = ctx;
  const copperSide = layer === 'topSolder' ? 'top' : 'bottom';
  for (const { placed } of comps) {
    for (const prim of placed.graphics) if (prim.layer === layer) drawGraphic(g, prim, rules.silkWidth);
    for (const pad of placed.pads) {
      if (!pad.layers.mask.includes(layer)) continue;
      flashPad(g, pad, pad.maskExpansion ?? rules.maskExpansion);
    }
  }
  for (const o of objects) {
    if (o.t === 'pad') {
      const s = o.side || 'top';
      if (s !== 'thru' && s !== copperSide) continue;
      flashPad(g, o, o.maskExpansion ?? rules.maskExpansion);
    } else if (o.t === 'via' && (opts.untentVias || o.tented === false)) {
      if (!spanLayers(o.from || 'top', o.to || 'bottom', copper).includes(copperSide)) continue;
      g.flash(g.circle(o.d + 2 * rules.maskExpansion), o.x, o.y);
    } else if (o.layer === layer) drawBoardDrawing(g, o, 0, opts.units);
  }
  return g;
}

function writePaste(ctx, layer, opts) {
  const side = layer === 'topPaste' ? 'Top' : 'Bot';
  const g = new GerberWriter({ fileFunction: `Paste,${side}`, origin: ctx.origin, date: opts.date });
  const { objects, comps, rules } = ctx;
  const copperSide = layer === 'topPaste' ? 'top' : 'bottom';
  for (const { placed } of comps) {
    for (const prim of placed.graphics) if (prim.layer === layer) drawGraphic(g, prim, rules.silkWidth);
    for (const pad of placed.pads) {
      if (pad.noPaste || !pad.layers.paste.includes(layer)) continue;
      flashPad(g, pad, rules.pasteExpansion);
    }
  }
  for (const o of objects) {
    if (o.t === 'pad') {
      if ((o.side || 'top') === copperSide && !o.noPaste) flashPad(g, o, rules.pasteExpansion);
    } else if (o.layer === layer) drawBoardDrawing(g, o, 0, opts.units);
  }
  return g;
}

function writeProfile(ctx, opts) {
  const g = new GerberWriter({ fileFunction: 'Profile,NP', origin: ctx.origin, date: opts.date });
  const { board } = ctx;
  if (board.outline?.length >= 6) g.polyline(board.outline, PROFILE_WIDTH, true, 'Profile');
  for (const c of board.cutouts || []) if (c.length >= 6) g.polyline(c, PROFILE_WIDTH, true, 'Profile');
  return g;
}

function writeMechanical(ctx, layer, opts) {
  const g = new GerberWriter({ fileFunction: `Other,${LAYERS[layer]?.name.replace(/\s+/g, '') || layer}`, origin: ctx.origin, date: opts.date });
  const { objects, comps, rules } = ctx;
  for (const o of objects) if (o.layer === layer) drawBoardDrawing(g, o, rules.silkWidth, opts.units);
  for (const { placed } of comps) for (const prim of placed.graphics) if (prim.layer === layer) drawGraphic(g, prim, rules.silkWidth);
  return g;
}

/** File extension per layer. Inner copper layers are .G1, .G2, ... */
export function gerberExtension(layer, copper = 2) {
  const fixed = {
    top: 'GTL', bottom: 'GBL', topOverlay: 'GTO', bottomOverlay: 'GBO', topSolder: 'GTS', bottomSolder: 'GBS',
    topPaste: 'GTP', bottomPaste: 'GBP', profile: 'GKO', mech1: 'GM1', mech2: 'GM2',
  };
  if (fixed[layer]) return fixed[layer];
  const inner = copperLayers(copper).filter((l) => l !== 'top' && l !== 'bottom');
  const i = inner.indexOf(layer);
  return i >= 0 ? `G${i + 1}` : 'GBR';
}

/**
 * Exports every manufacturing layer of a board.
 * @param {object} boardDoc
 * @param {Map|object} library component definitions by id
 * @param {{pourFills?: Map|object, boardName?: string, date?: string, untentVias?: boolean, units?: 'mm'|'mil'}} opts
 *   units: the units dimensions are labelled in (as shown on the canvas)
 * @returns {{name:string, layer:string, content:string}[]}
 */
export function exportGerbers(boardDoc, library, opts = {}) {
  const ctx = resolveBoard(boardDoc, library);
  const name = baseName(opts.boardName || boardDoc.name);
  const files = [];
  const add = (layer, writer) => files.push({ name: `${name}.${gerberExtension(layer, ctx.copper)}`, layer, content: writer.toString() });
  for (const l of copperLayers(ctx.copper)) add(l, writeCopper(ctx, l, opts));
  add('topOverlay', writeOverlay(ctx, 'topOverlay', opts));
  add('bottomOverlay', writeOverlay(ctx, 'bottomOverlay', opts));
  add('topSolder', writeMask(ctx, 'topSolder', opts));
  add('bottomSolder', writeMask(ctx, 'bottomSolder', opts));
  add('topPaste', writePaste(ctx, 'topPaste', opts));
  add('bottomPaste', writePaste(ctx, 'bottomPaste', opts));
  add('profile', writeProfile(ctx, opts));
  for (const l of ['mech1', 'mech2']) {
    const w = writeMechanical(ctx, l, opts);
    if (w.objects > 0) add(l, w);
  }
  return files;
}
