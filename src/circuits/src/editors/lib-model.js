// Component editor model: converts a ComponentDef to editable objects and
// back, and the geometry the editor needs for them (bounds, picking,
// transforms), plus pad arrays and validation.
//
// Symbol objects: { t: 'pin', ...Pin }, graphics ({ t: 'line' | 'rect' | ... }),
// and two anchors { t: 'anchor', which: 'designator' | 'value', x, y }.
// Footprint objects: { t: 'pad', ...Pad } and graphics carrying a layer.
// Component settings live in a 'libmeta' object in the symbol store and
// footprint settings in an 'fpmeta' object in the footprint store.

import { mil, mm } from '../core/units.js';
import { bboxEmpty, bboxAdd, bboxUnion, bboxValid, distPointSeg, distPointArc, pointInPoly, makeTransform } from '../core/geom.js';
import { graphicBox, textBox } from '../model/sch.js';
import { padDistance } from '../model/pcb.js';
import { transformGraphic } from '../model/place.js';
import { overlappingPads } from '../model/library/footprints.js';

export const LIB_META_TYPES = new Set(['libmeta', 'fpmeta']);
export const FP_LAYERS = ['topOverlay', 'mech1', 'courtyard', 'top', 'bottomOverlay'];
export const GRAPHIC_TYPES = new Set(['line', 'polyline', 'rect', 'circle', 'arc', 'poly', 'text']);

const strip = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'id' && k !== 't') out[k] = v;
  return out;
};
const stripId = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'id') out[k] = v;
  return out;
};

/** Splits a definition into editable objects. */
export function defToObjects(def) {
  const sym = def.symbol || { pins: [], graphics: [] };
  const rest = { ...def };
  delete rest.symbol;
  delete rest.footprint;
  const libmeta = {
    ...structuredClone(rest), defId: def.id, id: 'libmeta', t: 'libmeta',
    showPinNames: sym.showPinNames, showPinNumbers: sym.showPinNumbers,
  };
  const symbolObjs = [libmeta];
  for (const p of sym.pins || []) symbolObjs.push({ t: 'pin', ...structuredClone(p) });
  for (const g of sym.graphics || []) symbolObjs.push(structuredClone(g));
  if (sym.designatorPos) symbolObjs.push({ t: 'anchor', which: 'designator', x: sym.designatorPos.x, y: sym.designatorPos.y });
  if (sym.valuePos) symbolObjs.push({ t: 'anchor', which: 'value', x: sym.valuePos.x, y: sym.valuePos.y });
  const fp = def.footprint;
  const fpmeta = { id: 'fpmeta', t: 'fpmeta', enabled: fp ? true : undefined, name: fp?.name || '', description: fp?.description, courtyard: fp?.courtyard ? { ...fp.courtyard } : undefined, body: fp?.body ? { ...fp.body } : undefined, dupPads: fp?.dupPads };
  const footprintObjs = [fpmeta];
  for (const p of fp?.pads || []) footprintObjs.push({ t: 'pad', ...structuredClone(p) });
  for (const g of fp?.graphics || []) footprintObjs.push(structuredClone(g));
  return { symbol: symbolObjs, footprint: footprintObjs };
}

/** Rebuilds a definition from editor objects (as produced by defToObjects). */
export function objectsToDef(symbolObjs, footprintObjs) {
  const libmeta = symbolObjs.find((o) => o.t === 'libmeta') || {};
  const { showPinNames, showPinNumbers, defId, ...meta } = strip(libmeta);
  if (defId) meta.id = defId;
  const symbol = { pins: [], graphics: [] };
  for (const o of symbolObjs) {
    if (o.t === 'pin') symbol.pins.push(strip(o));
    else if (GRAPHIC_TYPES.has(o.t)) symbol.graphics.push(stripId(o));
    else if (o.t === 'anchor') symbol[o.which === 'designator' ? 'designatorPos' : 'valuePos'] = { x: o.x, y: o.y };
  }
  if (showPinNames === false) symbol.showPinNames = false;
  if (showPinNumbers === false) symbol.showPinNumbers = false;
  const fpmeta = footprintObjs.find((o) => o.t === 'fpmeta') || {};
  let footprint = null;
  const pads = footprintObjs.filter((o) => o.t === 'pad').map(strip);
  const graphics = footprintObjs.filter((o) => GRAPHIC_TYPES.has(o.t)).map(stripId);
  // The "Has a footprint" switch decides; while it is unset (a symbol-only
  // component), drawing pads or graphics adds a footprint.
  if (fpmeta.enabled ?? (pads.length > 0 || graphics.length > 0)) {
    footprint = { name: fpmeta.name || meta.name || 'Footprint', pads, graphics };
    if (fpmeta.description) footprint.description = fpmeta.description;
    if (fpmeta.courtyard) footprint.courtyard = { ...fpmeta.courtyard };
    if (fpmeta.body) footprint.body = { ...fpmeta.body };
    if (fpmeta.dupPads) footprint.dupPads = true;
  }
  return { ...meta, symbol, footprint };
}

/** Copies a definition under a new id and name for "edit a copy". */
export function copyDef(def, id, name) {
  const out = structuredClone(def);
  out.id = id;
  out.name = name;
  return out;
}

// ---- Geometry ----

export function pinEnd(p) {
  const r = (p.rot * Math.PI) / 180;
  return [Math.round(p.x + Math.cos(r) * p.length), Math.round(p.y + Math.sin(r) * p.length)];
}

export function libBounds(o) {
  switch (o.t) {
    case 'pin': {
      const [bx, by] = pinEnd(o);
      return bboxAdd(bboxAdd(bboxEmpty(), o.x, o.y, mil(20)), bx, by, mil(40));
    }
    case 'pad': {
      const rot = (((o.rot || 0) % 360) + 360) % 360;
      if (o.shape === 'round' || rot % 90 === 0) {
        const h = o.shape === 'round' ? o.w : o.h;
        const [hw, hh] = rot % 180 === 0 || o.shape === 'round' ? [o.w / 2, h / 2] : [h / 2, o.w / 2];
        return { minX: o.x - hw, minY: o.y - hh, maxX: o.x + hw, maxY: o.y + hh };
      }
      const r = Math.hypot(o.w, o.h) / 2;
      return { minX: o.x - r, minY: o.y - r, maxX: o.x + r, maxY: o.y + r };
    }
    case 'anchor': return { minX: o.x - mil(40), minY: o.y - mil(40), maxX: o.x + mil(40), maxY: o.y + mil(40) };
    default: {
      if (LIB_META_TYPES.has(o.t)) return { minX: 1, minY: 1, maxX: 0, maxY: 0 };
      return graphicBox(o) || { minX: 1, minY: 1, maxX: 0, maxY: 0 };
    }
  }
}

const boxDist = (b, x, y) => Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minY - y, 0, y - b.maxY));

function segsDist(pts, x, y, closed) {
  let d = Infinity;
  const n = pts.length;
  for (let i = 2; i < n; i += 2) d = Math.min(d, distPointSeg(x, y, pts[i - 2], pts[i - 1], pts[i], pts[i + 1]));
  if (closed && n >= 6) d = Math.min(d, distPointSeg(x, y, pts[n - 2], pts[n - 1], pts[0], pts[1]));
  return d;
}

/** Distance from (x, y) to an object for picking (0 = inside). */
export function libHitDistance(o, x, y) {
  const hw = (o.w || 0) / 2;
  switch (o.t) {
    case 'pin': { const [bx, by] = pinEnd(o); return distPointSeg(x, y, o.x, o.y, bx, by); }
    case 'pad': return padDistance(o, x, y);
    case 'anchor': return Math.max(0, Math.hypot(x - o.x, y - o.y) - mil(30));
    case 'line': return Math.max(0, distPointSeg(x, y, o.x1, o.y1, o.x2, o.y2) - hw);
    case 'polyline': return Math.max(0, segsDist(o.pts, x, y, false) - hw);
    case 'poly': return o.fill && pointInPoly(x, y, o.pts) ? 0 : Math.max(0, segsDist(o.pts, x, y, true) - hw);
    case 'rect': {
      const pts = [o.x1, o.y1, o.x2, o.y1, o.x2, o.y2, o.x1, o.y2];
      return o.fill && pointInPoly(x, y, pts) ? 0 : Math.max(0, segsDist(pts, x, y, true) - hw);
    }
    case 'circle': { const d = Math.hypot(x - o.cx, y - o.cy); return o.fill && d <= o.r ? 0 : Math.max(0, Math.abs(d - o.r) - hw); }
    case 'arc': return Math.max(0, distPointArc(x, y, o.cx, o.cy, o.r, o.a0, o.sweep) - hw);
    case 'text': return boxDist(textBox(o.text, o.x, o.y, o.size, o.rot || 0, o.align || {}), x, y);
    default: return Infinity;
  }
}

export const LIB_PICK_ORDER = { anchor: 0, pin: 1, pad: 1, text: 2, line: 3, arc: 3, polyline: 3, circle: 4, rect: 4, poly: 4 };

export function translateLib(o, dx, dy) {
  switch (o.t) {
    case 'line': return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
    case 'rect': return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
    case 'circle': case 'arc': return { ...o, cx: o.cx + dx, cy: o.cy + dy };
    case 'polyline': case 'poly': return { ...o, pts: o.pts.map((v, i) => v + (i % 2 ? dy : dx)) };
    default: return { ...o, x: o.x + dx, y: o.y + dy };
  }
}

const norm = (a) => ((a % 360) + 360) % 360;

/** Rotates by deg (a multiple of 90) about (cx, cy). */
export function rotateLib(o, cx, cy, deg = 90) {
  const t = makeTransform(0, 0, deg);
  const rp = (x, y) => [Math.round(cx + t.a * (x - cx) + t.c * (y - cy)), Math.round(cy + t.b * (x - cx) + t.d * (y - cy))];
  if (o.t === 'pin' || o.t === 'pad' || o.t === 'anchor') {
    const [x, y] = rp(o.x, o.y);
    if (o.t === 'anchor') return { ...o, x, y };
    return { ...o, x, y, rot: norm((o.rot || 0) + deg) };
  }
  return roundGraphic({ ...transformGraphic(transformGraphic(o, makeTransform(-cx, -cy, 0)), makeTransform(cx, cy, deg)), id: o.id });
}

/** Mirrors across the vertical line x = cx (axis 'x') or horizontal y = cy (axis 'y'). */
export function mirrorLib(o, cx, cy, axis = 'x') {
  if (axis === 'y') return rotateLib(mirrorLib(o, cx, cy, 'x'), cx, cy, 180);
  if (o.t === 'pin') return { ...o, x: 2 * cx - o.x, rot: norm(180 - o.rot) };
  if (o.t === 'pad') return { ...o, x: 2 * cx - o.x, rot: norm(-(o.rot || 0)) };
  if (o.t === 'anchor') return { ...o, x: 2 * cx - o.x };
  const g = transformGraphic(transformGraphic(o, makeTransform(-cx, -cy, 0)), makeTransform(cx, cy, 0, true));
  // Mirrored text stays readable in a symbol.
  if (g.t === 'text') g.mirror = !!o.mirror;
  return roundGraphic({ ...g, id: o.id });
}

function roundGraphic(g) {
  const out = { ...g };
  for (const k of ['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'x', 'y', 'r']) if (typeof out[k] === 'number') out[k] = Math.round(out[k]);
  if (out.pts) out.pts = out.pts.map(Math.round);
  if (out.layer === undefined) delete out.layer;
  return out;
}

export function boundsOfAll(objs) {
  let b = bboxEmpty();
  for (const o of objs) { const ob = libBounds(o); if (bboxValid(ob)) b = bboxUnion(b, ob); }
  return b;
}

// ---- Pins and pads ----

/** Next pin number or name: '7' -> '8', 'A3' -> 'A4', 'D0' -> 'D1'; others unchanged. */
export function nextLabel(s) {
  const m = /^(.*?)(\d+)$/.exec(String(s ?? ''));
  if (!m) return s;
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0');
}

/**
 * Generates a pad array centred on (cx, cy).
 * order: 'rows' (left to right, top row first), 'columns' (top to bottom,
 * left column first) or 'around' (counter-clockwise from the top left, as
 * dual in-line packages are numbered: down the left column, up the right).
 */
export function padArray({ rows = 1, cols = 1, pitchX = mm(2.54), pitchY = mm(2.54), start = 1, order = 'rows', template = {}, cx = 0, cy = 0 } = {}) {
  const pads = [];
  const x0 = cx - ((cols - 1) * pitchX) / 2, y0 = cy + ((rows - 1) * pitchY) / 2;
  const cells = [];
  if (order === 'columns') for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) cells.push([r, c]);
  else if (order === 'around') {
    for (let c = 0; c < cols; c++) {
      const down = c % 2 === 0;
      for (let k = 0; k < rows; k++) cells.push([down ? k : rows - 1 - k, c]);
    }
  } else for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
  let n = Number(start) || 1;
  for (const [r, c] of cells) {
    pads.push({
      t: 'pad', shape: 'round', w: mm(1.6), h: mm(1.6), side: 'thru', drill: mm(0.8), plated: true, rot: 0, ...template,
      num: String(n++), x: Math.round(x0 + c * pitchX), y: Math.round(y0 - r * pitchY),
    });
  }
  if (pads.length && (template.firstSquare ?? true) && pads[0].side === 'thru') pads[0] = { ...pads[0], shape: 'rect', h: pads[0].h || pads[0].w };
  for (const p of pads) delete p.firstSquare;
  return pads;
}

/** Courtyard rectangle around pads and graphics with a margin, on a 0.05 mm grid. */
export function courtyardFor(objs, margin = mm(0.25)) {
  const b = boundsOfAll(objs.filter((o) => o.t === 'pad' || (GRAPHIC_TYPES.has(o.t) && o.layer !== 'courtyard')));
  if (!bboxValid(b)) return null;
  const g = mm(0.05);
  return {
    x1: Math.floor((b.minX - margin) / g) * g, y1: Math.floor((b.minY - margin) / g) * g,
    x2: Math.ceil((b.maxX + margin) / g) * g, y2: Math.ceil((b.maxY + margin) / g) * g,
  };
}

/**
 * Checks a component: returns [{ severity: 'error'|'warning'|'info', message }].
 */
export function validateComponent(def) {
  const out = [];
  const pins = def.symbol?.pins || [];
  const pads = def.footprint?.pads || [];
  if (!pins.length) out.push({ severity: 'warning', message: 'The symbol has no pins.' });
  const seen = new Map();
  for (const p of pins) seen.set(p.num, (seen.get(p.num) || 0) + 1);
  const dupPins = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  if (dupPins.length) out.push({ severity: 'error', message: `Duplicate pin numbers: ${dupPins.join(', ')}` });
  if (pins.some((p) => !p.num)) out.push({ severity: 'error', message: 'Some pins have no number.' });
  if (!def.prefix) out.push({ severity: 'warning', message: 'The designator prefix is empty.' });
  if (def.footprint) {
    const padNums = new Map();
    for (const p of pads) if (p.num) padNums.set(p.num, (padNums.get(p.num) || 0) + 1);
    const map = def.pinMap || {};
    const padFor = (n) => map[n] ?? n;
    const noPad = pins.map((p) => p.num).filter((n) => n && !padNums.has(padFor(n)));
    if (noPad.length) out.push({ severity: 'warning', message: `Pins without a pad: ${[...new Set(noPad)].join(', ')}` });
    const pinPads = new Set(pins.map((p) => padFor(p.num)));
    const noPin = [...padNums.keys()].filter((n) => !pinPads.has(n));
    if (noPin.length) out.push({ severity: 'info', message: `Pads without a pin: ${noPin.join(', ')}` });
    const dupPads = [...padNums].filter(([, n]) => n > 1).map(([k]) => k);
    if (dupPads.length && !def.footprint.dupPads) out.push({ severity: 'warning', message: `Pads sharing a number: ${dupPads.join(', ')}` });
    const clash = overlappingPads(pads);
    if (clash) out.push({ severity: 'error', message: `Pads ${clash[0]} and ${clash[1]} overlap, shorting them together.` });
    for (const p of pads) if (p.side === 'thru' && !(p.drill > 0)) { out.push({ severity: 'error', message: `Pad ${p.num || '?'} is through-hole without a drill.` }); break; }
    for (const p of pads) if (p.side === 'thru' && p.drill >= Math.min(p.w, p.shape === 'round' ? p.w : p.h)) { out.push({ severity: 'error', message: `Pad ${p.num || '?'} has a hole as large as the pad.` }); break; }
  }
  return out;
}
