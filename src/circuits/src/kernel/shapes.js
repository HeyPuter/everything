// Converts a board document into the flat shape records the geometry kernel
// reads (see wasm/kernel/src/shape.rs). Every copper item becomes a point,
// segment or polygon core grown by a radius, tagged with layer bits, a net
// index, a reference back to the document object and the clearance it needs.

import { placeFootprint, padLayers } from '../model/place.js';
import { COPPER_ORDER, copperLayers, spanLayers, isCopper } from '../model/layers.js';
import { arcToPoints } from '../core/geom.js';

export const KIND = { circle: 1, capsule: 2, roundrect: 3, poly: 4 };
export const FLAG = {
  pad: 1, thru: 2, via: 4, track: 8, fill: 16, pourFill: 32, keepout: 64, courtyard: 128, edge: 256,
};
export const LAYER_BIT = Object.fromEntries(COPPER_ORDER.map((l, i) => [l, i]));
export const COURTYARD_BIT = { top: 10, bottom: 11 };

const ARC_ERR = 500;

/** Bit mask for a list of copper layer ids. */
export function layerMask(layers) {
  let m = 0;
  for (const l of layers) if (l in LAYER_BIT) m |= 1 << LAYER_BIT[l];
  return m;
}

export function maskLayers(mask) {
  return COPPER_ORDER.filter((l) => mask & (1 << LAYER_BIT[l]));
}

/** Growable f64 buffer. */
export class F64Writer {
  constructor(size = 4096) {
    this.buf = new Float64Array(size);
    this.n = 0;
  }

  _grow(extra) {
    if (this.n + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + extra) size *= 2;
    const next = new Float64Array(size);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }

  push(...vals) {
    this._grow(vals.length);
    for (const v of vals) this.buf[this.n++] = v;
  }

  pushArray(arr) {
    this._grow(arr.length);
    this.buf.set(arr, this.n);
    this.n += arr.length;
  }

  result() {
    return this.buf.slice(0, this.n);
  }
}

/** Net class lookup: net name -> { width, clearance, viaDiameter, viaDrill }. */
export function netRules(doc) {
  const rules = doc.rules || {};
  const classOf = new Map();
  for (const [name, cls] of Object.entries(rules.netClasses || {})) {
    for (const n of cls.nets || []) classOf.set(n, name);
  }
  for (const [net, info] of Object.entries(doc.nets || {})) if (info?.class) classOf.set(net, info.class);
  const cache = new Map();
  return (net) => {
    if (cache.has(net)) return cache.get(net);
    const cls = net ? rules.netClasses?.[classOf.get(net)] : null;
    const r = {
      width: cls?.width || rules.trackWidth || 250_000,
      clearance: Math.max(rules.clearance || 0, cls?.clearance || 0),
      viaDiameter: cls?.viaDiameter || rules.viaDiameter || 600_000,
      viaDrill: cls?.viaDrill || rules.viaDrill || 300_000,
    };
    cache.set(net, r);
    return r;
  };
}

/**
 * Builds kernel records for a board.
 * @returns {{ records: Float64Array, count: number, refs: object[], nets: string[], netIndex: Map<string, number>, rings: number[][], copper: number, rulesFor: Function }}
 */
export function buildShapes(doc, library = {}, { pourFills = null } = {}) {
  const copper = doc.board?.copper || 2;
  const rules = doc.rules || {};
  const rulesFor = netRules(doc);
  const netSet = new Set(Object.keys(doc.nets || {}));
  for (const o of doc.objects || []) {
    if (o.net) netSet.add(o.net);
    if (o.t === 'comp') for (const n of Object.values(o.padNets || {})) if (n) netSet.add(n);
  }
  const nets = [...netSet].sort();
  const netIndex = new Map(nets.map((n, i) => [n, i]));
  const ni = (net) => (net ? netIndex.get(net) ?? -1 : -1);
  const clrOf = (net) => (net ? rulesFor(net).clearance : rules.clearance || 0);

  const w = new F64Writer(1 << 14);
  const refs = [];
  let count = 0;
  const head = (kind, mask, net, ref, flags, clr) => {
    w.push(kind, mask, ni(net), refs.length, flags, clr);
    refs.push(ref);
    count++;
  };
  const circle = (x, y, r, mask, net, ref, flags, clr = clrOf(net)) => {
    head(KIND.circle, mask, net, ref, flags, clr);
    w.push(x, y, r);
  };
  const capsule = (x1, y1, x2, y2, r, mask, net, ref, flags, clr = clrOf(net)) => {
    head(KIND.capsule, mask, net, ref, flags, clr);
    w.push(x1, y1, x2, y2, r);
  };
  const roundrect = (cx, cy, hw, hh, rot, radius, mask, net, ref, flags, clr = clrOf(net)) => {
    head(KIND.roundrect, mask, net, ref, flags, clr);
    w.push(cx, cy, hw, hh, rot, radius);
  };
  const poly = (rings, mask, net, ref, flags, clr = clrOf(net)) => {
    head(KIND.poly, mask, net, ref, flags, clr);
    w.push(rings.length);
    for (const r of rings) {
      w.push(r.length / 2);
      w.pushArray(r);
    }
  };

  const pad = (p, ref) => {
    const mask = layerMask(p.layers?.copper || padLayers(p.side, copper).copper);
    if (!mask) return;
    const flags = FLAG.pad | (p.side === 'thru' ? FLAG.thru : 0);
    const rot = p.rot || 0;
    const net = p.net || '';
    switch (p.shape) {
      case 'round':
        circle(p.x, p.y, p.w / 2, mask, net, ref, flags);
        break;
      case 'oval': {
        const long = Math.max(p.w, p.h), short = Math.min(p.w, p.h);
        const half = (long - short) / 2;
        const a = ((rot + (p.w >= p.h ? 0 : 90)) * Math.PI) / 180;
        const dx = Math.cos(a) * half, dy = Math.sin(a) * half;
        capsule(p.x - dx, p.y - dy, p.x + dx, p.y + dy, short / 2, mask, net, ref, flags);
        break;
      }
      case 'roundrect': {
        const ratio = p.radius ?? 0.25;
        roundrect(p.x, p.y, p.w / 2, p.h / 2, rot, Math.min(p.w, p.h) * Math.min(ratio, 0.5), mask, net, ref, flags);
        break;
      }
      default:
        roundrect(p.x, p.y, p.w / 2, p.h / 2, rot, 0, mask, net, ref, flags);
    }
  };

  const allCopper = layerMask(copperLayers(copper));
  for (const o of doc.objects || []) {
    switch (o.t) {
      case 'comp': {
        const def = library[o.comp];
        const placed = placeFootprint(def, o, copper);
        for (const p of placed.pads) {
          pad(p, { id: o.id, kind: 'pad', label: `Pad ${o.designator || '?'}-${p.num}`, net: p.net || '', designator: o.designator, pad: p.num });
        }
        if (placed.courtyard) {
          poly([placed.courtyard], 1 << COURTYARD_BIT[o.side === 'bottom' ? 'bottom' : 'top'], '', { id: o.id, kind: 'courtyard', label: `Component ${o.designator || '?'}` }, FLAG.courtyard, 0);
        }
        break;
      }
      case 'pad': {
        const p = { ...o, layers: padLayers(o.side, copper) };
        pad(p, { id: o.id, kind: 'pad', label: `Pad${o.num ? ` ${o.num}` : ''}`, net: o.net || '' });
        break;
      }
      case 'track': {
        if (!isCopper(o.layer)) break;
        const mask = 1 << LAYER_BIT[o.layer];
        capsule(o.x1, o.y1, o.x2, o.y2, o.w / 2, mask, o.net, { id: o.id, kind: 'track', label: 'Track', net: o.net || '' }, FLAG.track);
        break;
      }
      case 'arc': {
        if (!isCopper(o.layer)) break;
        const mask = 1 << LAYER_BIT[o.layer];
        const pts = arcToPoints(o.cx, o.cy, o.r, o.a0, o.sweep, ARC_ERR);
        const ref = { id: o.id, kind: 'arc', label: 'Arc', net: o.net || '' };
        for (let i = 0; i + 3 < pts.length; i += 2) capsule(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], o.w / 2, mask, o.net, ref, FLAG.track);
        break;
      }
      case 'via': {
        const mask = layerMask(spanLayers(o.from || 'top', o.to || 'bottom', copper));
        circle(o.x, o.y, o.d / 2, mask, o.net, { id: o.id, kind: 'via', label: 'Via', net: o.net || '' }, FLAG.via | FLAG.thru);
        break;
      }
      case 'fill': {
        const ref = { id: o.id, kind: 'fill', label: 'Fill', net: o.net || '' };
        const cx = (o.x1 + o.x2) / 2, cy = (o.y1 + o.y2) / 2;
        const hw = Math.abs(o.x2 - o.x1) / 2, hh = Math.abs(o.y2 - o.y1) / 2;
        if (o.layer === 'keepout') roundrect(cx, cy, hw, hh, 0, 0, allCopper, '', { ...ref, kind: 'keepout', label: 'Keep-out' }, FLAG.keepout, 0);
        else if (isCopper(o.layer)) roundrect(cx, cy, hw, hh, 0, 0, 1 << LAYER_BIT[o.layer], o.net, ref, FLAG.fill);
        break;
      }
      case 'region': {
        if (!o.pts || o.pts.length < 6) break;
        if (o.layer === 'keepout') poly([o.pts], allCopper, '', { id: o.id, kind: 'keepout', label: 'Keep-out' }, FLAG.keepout, 0);
        else if (isCopper(o.layer)) poly([o.pts], 1 << LAYER_BIT[o.layer], o.net, { id: o.id, kind: 'region', label: 'Region', net: o.net || '' }, FLAG.fill);
        break;
      }
      case 'pour': {
        const fill = pourFills?.get?.(o.id);
        if (!fill || !isCopper(o.layer)) break;
        const clr = Math.max(o.clearance || 0, clrOf(o.net));
        const ref = { id: o.id, kind: 'pour', label: `Pour${o.name ? ` ${o.name}` : ''}`, net: o.net || '' };
        for (const shape of fill) poly(shape, 1 << LAYER_BIT[o.layer], o.net, ref, FLAG.pourFill, clr);
        break;
      }
      default:
        break;
    }
  }
  const rings = [];
  if (doc.board?.outline?.length >= 6) rings.push(doc.board.outline);
  for (const c of doc.board?.cutouts || []) if (c.length >= 6) rings.push(c);
  return { records: w.result(), count, refs, nets, netIndex, rings, copper, rulesFor };
}

/** Encodes the shared prefix: shapes then board rings. */
export function writePrefix(w, shapes) {
  w.push(shapes.count);
  w.pushArray(shapes.records);
  w.push(shapes.rings.length);
  for (const r of shapes.rings) {
    w.push(r.length / 2);
    w.pushArray(r);
  }
}

/** Pours in fill order: lower priority number first, then document order. Shelved pours have no copper. */
export function pourOrder(doc) {
  return (doc.objects || [])
    .map((o, i) => [o, i])
    .filter(([o]) => o.t === 'pour' && !o.shelved && isCopper(o.layer) && o.pts?.length >= 6)
    .sort((a, b) => (a[0].priority ?? 0) - (b[0].priority ?? 0) || a[1] - b[1])
    .map(([o]) => o);
}
