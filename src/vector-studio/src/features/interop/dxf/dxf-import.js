/**
 * DXF import (ASCII DXF, R12 through current versions).
 *
 * Entities: LINE, LWPOLYLINE and POLYLINE (with bulges), ARC, CIRCLE,
 * ELLIPSE, SPLINE (exact Bezier conversion for non-rational splines up to
 * degree 3, fitted otherwise), TEXT, MTEXT, SOLID/TRACE, 3DFACE, HATCH
 * (solid fills from polyline and edge boundaries), POINT, LEADER, INSERT
 * (blocks with scale, rotation and arrays, nested) and DIMENSION (its
 * block). Layers become layers (with their colors, visibility and lock),
 * colors come from the color index or true color (ByLayer/ByBlock
 * resolved), linetypes become dashes and lineweights stroke widths.
 * Drawing units ($INSUNITS) set the scale; the dialog can override it.
 */
import { aciColor, UNITS } from './common.js';
import { Builder } from '../pdf/build.js';
import { createPath, createCompound, createGroup, createText, DEFAULT_CHAR, DEFAULT_PARA } from '../../../model/nodes.js';
import { fitCurve } from '../../../model/bezier.js';
import { multiply } from '../../../lib/matrix.js';

/** Group code / value pairs. */
export function dxfPairs(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) {
      i--;
      continue;
    }
    pairs.push([code, lines[i + 1]]);
  }
  return pairs;
}

export function isDXF(text) {
  return /^\s*0\s*\r?\n\s*SECTION\s*\r?\n/.test(text.slice(0, 200)) || /^\s*999\s*\r?\n/.test(text.slice(0, 50));
}

/** Split pairs into entity records: [{ type, pairs }]. */
function records(pairs, from, to) {
  const out = [];
  let cur = null;
  for (let i = from; i < to; i++) {
    const [c, v] = pairs[i];
    if (c === 0) {
      cur = { type: v.trim(), pairs: [] };
      out.push(cur);
    } else if (cur) cur.pairs.push([c, v]);
  }
  return out;
}

function parseSections(pairs) {
  const sections = {};
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1].trim() === 'SECTION' && pairs[i + 1]?.[0] === 2) {
      const name = pairs[i + 1][1].trim();
      let j = i + 2;
      while (j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1].trim() === 'ENDSEC')) j++;
      sections[name] = { from: i + 2, to: j };
      i = j;
    }
  }
  return sections;
}

const g = (rec, code, d = undefined) => {
  for (const [c, v] of rec.pairs) if (c === code) return v.trim();
  return d;
};
const gn = (rec, code, d = 0) => {
  const v = g(rec, code);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

function readHeader(pairs, sec) {
  const h = {};
  if (!sec) return h;
  let key = null;
  for (let i = sec.from; i < sec.to; i++) {
    const [c, v] = pairs[i];
    if (c === 9) {
      key = v.trim();
      h[key] = {};
    } else if (key) h[key][c] = v.trim();
  }
  return h;
}

function readTables(pairs, sec) {
  const layers = new Map();
  const ltypes = new Map();
  if (!sec) return { layers, ltypes };
  for (const r of records(pairs, sec.from, sec.to)) {
    if (r.type === 'LAYER') {
      const name = g(r, 2, '0');
      const color = gn(r, 62, 7);
      const flags = gn(r, 70, 0);
      const tc = g(r, 420);
      layers.set(name, {
        name,
        color: tc !== undefined ? `#${(Number(tc) & 0xffffff).toString(16).padStart(6, '0')}` : aciColor(Math.abs(color) || 7),
        hidden: color < 0 || Boolean(flags & 1),
        locked: Boolean(flags & 4),
        ltype: g(r, 6, 'CONTINUOUS'),
        lineweight: gn(r, 370, -3),
      });
    } else if (r.type === 'LTYPE') {
      const name = g(r, 2, '');
      const dashes = r.pairs.filter(([c]) => c === 49).map(([, v]) => Number(v));
      if (name) ltypes.set(name.toUpperCase(), dashes);
    }
  }
  return { layers, ltypes };
}

function readBlocks(pairs, sec) {
  const blocks = new Map();
  if (!sec) return blocks;
  let cur = null;
  for (const r of records(pairs, sec.from, sec.to)) {
    if (r.type === 'BLOCK') {
      cur = { name: g(r, 2, ''), base: [gn(r, 10), gn(r, 20)], entities: [], layer: g(r, 8, '0') };
      blocks.set(cur.name, cur);
    } else if (r.type === 'ENDBLK') cur = null;
    else if (cur) cur.entities.push(r);
  }
  return blocks;
}

// ---- geometry ----

/** Cubic segments approximating an elliptical arc (angles in radians, direction by sign). */
function arcSegments(cx, cy, rx, ry, rot, a0, a1) {
  const out = [];
  const total = a1 - a0;
  const n = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2) - 1e-9));
  const step = total / n;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const pt = (a) => {
    const x = rx * Math.cos(a);
    const y = ry * Math.sin(a);
    return [cx + x * cr - y * sr, cy + x * sr + y * cr];
  };
  const dpt = (a) => {
    const x = -rx * Math.sin(a);
    const y = ry * Math.cos(a);
    return [x * cr - y * sr, x * sr + y * cr];
  };
  for (let i = 0; i < n; i++) {
    const t0 = a0 + step * i;
    const t1 = t0 + step;
    const k = (4 / 3) * Math.tan(step / 4);
    const p0 = pt(t0);
    const p1 = pt(t1);
    const d0 = dpt(t0);
    const d1 = dpt(t1);
    out.push({ c1: [p0[0] + k * d0[0], p0[1] + k * d0[1]], c2: [p1[0] - k * d1[0], p1[1] - k * d1[1]], p: p1 });
  }
  return { start: pt(a0), segments: out };
}

/** Bezier segments of a bulge arc from p0 to p1. */
function bulgeSegments(p0, p1, bulge) {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const c = Math.hypot(dx, dy);
  if (!c || Math.abs(bulge) < 1e-9) return [{ p: p1 }];
  const theta = 4 * Math.atan(bulge);
  const r = c / (2 * Math.sin(Math.abs(theta) / 2));
  const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const h = Math.sqrt(Math.max(0, r * r - (c / 2) ** 2));
  // Center lies left of the chord for positive bulges (counter-clockwise) when the arc is under 180 degrees.
  const nx = -dy / c;
  const ny = dx / c;
  const side = (bulge > 0) === Math.abs(theta) < Math.PI ? 1 : -1;
  const cx = mid[0] + nx * h * side;
  const cy = mid[1] + ny * h * side;
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
  const a1 = a0 + theta;
  return arcSegments(cx, cy, r, r, 0, a0, a1).segments;
}

/** Subpath builder in DXF coordinates: { pts: [{ p, c1?, c2? }], closed }. */
class Sub {
  constructor(x, y) {
    this.items = [{ p: [x, y] }];
    this.closed = false;
  }

  line(x, y) {
    this.items.push({ p: [x, y] });
  }

  curve(c1, c2, p) {
    this.items.push({ c1, c2, p });
  }

  add(seg) {
    if (seg.c1) this.curve(seg.c1, seg.c2, seg.p);
    else this.line(seg.p[0], seg.p[1]);
  }
}

function deBoor(k, x, U, P, p) {
  const d = [];
  for (let j = 0; j <= p; j++) d.push(P[j + k - p].slice());
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const den = U[j + 1 + k - r] - U[j + k - p];
      const a = den ? (x - U[j + k - p]) / den : 0;
      for (let c = 0; c < d[j].length; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
    }
  }
  return d[p];
}

/** Insert knot u once (Boehm). */
function insertKnot(U, P, p, u) {
  let k = p;
  while (k < U.length - p - 2 && U[k + 1] <= u) k++;
  const Q = [];
  for (let i = 0; i <= P.length; i++) {
    if (i <= k - p) Q.push(P[i]);
    else if (i > k) Q.push(P[i - 1]);
    else {
      const den = U[i + p] - U[i];
      const a = den ? (u - U[i]) / den : 0;
      Q.push(P[i].map((v, c) => (1 - a) * P[i - 1][c] + a * v));
    }
  }
  const NU = [...U.slice(0, k + 1), u, ...U.slice(k + 1)];
  return { U: NU, P: Q };
}

/** A spline entity as a subpath. */
function splineSub(rec) {
  const degree = gn(rec, 71, 3);
  const flags = gn(rec, 70, 0);
  const knots = rec.pairs.filter(([c]) => c === 40).map(([, v]) => Number(v));
  const weights = rec.pairs.filter(([c]) => c === 41).map(([, v]) => Number(v));
  const xs = rec.pairs.filter(([c]) => c === 10).map(([, v]) => Number(v));
  const ys = rec.pairs.filter(([c]) => c === 20).map(([, v]) => Number(v));
  const ctrl = xs.map((x, i) => [x, ys[i] ?? 0]);
  const fx = rec.pairs.filter(([c]) => c === 11).map(([, v]) => Number(v));
  const fy = rec.pairs.filter(([c]) => c === 21).map(([, v]) => Number(v));
  const closed = Boolean(flags & 1);
  if (ctrl.length < 2 && fx.length >= 2) {
    const anchors = fitCurve(fx.map((x, i) => ({ x, y: fy[i] ?? 0 })), 0.01);
    const s = new Sub(anchors[0].x, anchors[0].y);
    for (let i = 1; i < anchors.length; i++) s.curve([anchors[i - 1].ox, anchors[i - 1].oy], [anchors[i].ix, anchors[i].iy], [anchors[i].x, anchors[i].y]);
    s.closed = closed;
    return s;
  }
  if (ctrl.length < 2) return null;
  const p = Math.max(1, degree);
  const rational = weights.length === ctrl.length && weights.some((w) => Math.abs(w - 1) > 1e-9);
  const validKnots = knots.length === ctrl.length + p + 1;
  if (p === 1) {
    const s = new Sub(...ctrl[0]);
    for (const c of ctrl.slice(1)) s.line(c[0], c[1]);
    s.closed = closed;
    return s;
  }
  if (!rational && validKnots && p <= 3) {
    // Raise every interior knot to multiplicity p: the control polygon becomes Bezier segments.
    let U = knots.slice();
    let P = ctrl.map((c) => c.slice());
    const lo = U[p];
    const hi = U[U.length - p - 1];
    const interior = [...new Set(U.slice(p + 1, U.length - p - 1))].filter((u) => u > lo && u < hi);
    for (const u of interior) {
      let mult = U.filter((x) => Math.abs(x - u) < 1e-12).length;
      while (mult < p) {
        ({ U, P } = insertKnot(U, P, p, u));
        mult++;
      }
    }
    // Clamp unclamped ends by evaluating the end points.
    const start = deBoor(p, lo, U, P, p);
    const s = new Sub(start[0], start[1]);
    const segs = Math.round((P.length - 1) / p);
    if (Math.abs(U[0] - lo) < 1e-12 && Math.abs(U[U.length - 1] - hi) < 1e-12 && segs * p === P.length - 1) {
      for (let k = 0; k < segs; k++) {
        const q = P.slice(k * p, k * p + p + 1);
        if (p === 3) s.curve(q[1], q[2], q[3]);
        else {
          // Quadratic to cubic.
          const c1 = [q[0][0] + (2 / 3) * (q[1][0] - q[0][0]), q[0][1] + (2 / 3) * (q[1][1] - q[0][1])];
          const c2 = [q[2][0] + (2 / 3) * (q[1][0] - q[2][0]), q[2][1] + (2 / 3) * (q[1][1] - q[2][1])];
          s.curve(c1, c2, q[2]);
        }
      }
      s.closed = closed;
      return s;
    }
  }
  // Rational, higher degree or unusual knots: sample and fit.
  const U = validKnots ? knots : (() => {
    const n = ctrl.length;
    const u = [];
    for (let i = 0; i < n + p + 1; i++) u.push(i <= p ? 0 : i >= n ? n - p : i - p);
    return u;
  })();
  const W = rational ? weights : ctrl.map(() => 1);
  const H = ctrl.map((c, i) => [c[0] * W[i], c[1] * W[i], W[i]]);
  const lo = U[p];
  const hi = U[U.length - p - 1];
  const pts = [];
  const N = Math.max(32, ctrl.length * 12);
  for (let i = 0; i <= N; i++) {
    const x = lo + ((hi - lo) * i) / N;
    let k = p;
    while (k < U.length - p - 2 && U[k + 1] <= x) k++;
    const v = deBoor(k, Math.min(x, hi - 1e-12), U, H, p);
    pts.push({ x: v[0] / (v[2] || 1), y: v[1] / (v[2] || 1) });
  }
  const anchors = fitCurve(pts, 0.0005 * Math.max(1, spanOf(pts)) ** 2);
  const s = new Sub(anchors[0].x, anchors[0].y);
  for (let i = 1; i < anchors.length; i++) s.curve([anchors[i - 1].ox, anchors[i - 1].oy], [anchors[i].ix, anchors[i].iy], [anchors[i].x, anchors[i].y]);
  s.closed = closed;
  return s;
}

function spanOf(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return Math.max(x1 - x0, y1 - y0) / 100;
}

/** Vertices with bulges to a subpath. */
function polySub(verts, closed) {
  if (!verts.length) return null;
  const s = new Sub(verts[0].x, verts[0].y);
  const n = verts.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    if (Math.abs(a.bulge || 0) > 1e-9) for (const seg of bulgeSegments([a.x, a.y], [b.x, b.y], a.bulge)) s.add(seg);
    else s.line(b.x, b.y);
  }
  s.closed = closed;
  return s;
}

function lwpolyline(rec) {
  const verts = [];
  for (const [c, v] of rec.pairs) {
    if (c === 10) verts.push({ x: Number(v), y: 0, bulge: 0 });
    else if (c === 20 && verts.length) verts[verts.length - 1].y = Number(v);
    else if (c === 42 && verts.length) verts[verts.length - 1].bulge = Number(v);
  }
  return polySub(verts, Boolean(gn(rec, 70, 0) & 1));
}

/** MTEXT formatting codes removed, paragraphs as newlines. */
export function mtextPlain(s) {
  return s
    .replace(/\\P/g, '\n')
    .replace(/\\~/g, ' ')
    .replace(/\\[ACFHQTWfhcpqtw][^;]*;/g, '')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\S([^;^/#]*)[\^/#]([^;]*);/g, '$1/$2')
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\\/g, '\\')
    .replace(/\\\{/g, '{')
    .replace(/\\\}/g, '}')
    .replace(/[{}]/g, '');
}

/** TEXT special codes (%%d degree, %%p plus-minus, %%c diameter, %%u/%%o toggles). */
function textPlain(s) {
  return s
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[cC]/g, '⌀')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%%/g, '%')
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ---- conversion ----

class DXFConverter {
  constructor(data, { scale, families }) {
    this.d = data;
    this.scale = scale;
    this.out = new Builder();
    this.warnings = new Set();
    this.families = families || [];
    this.count = 0;
  }

  layerRec(name) {
    const L = this.d.layers.get(name) || { name, color: '#000000', hidden: false, locked: false, ltype: 'CONTINUOUS', lineweight: -3 };
    const rec = this.out.layerFor(`dxf:${name}`, name === '0' ? 'Layer 0' : name, { hidden: L.hidden, locked: L.locked });
    return { rec, L };
  }

  colorOf(e, ctx, L) {
    const tc = g(e, 420);
    if (tc !== undefined) return `#${(Number(tc) & 0xffffff).toString(16).padStart(6, '0')}`;
    const aci = gn(e, 62, 256);
    if (aci === 256) return L.color;
    if (aci === 0) return ctx.blockColor || L.color;
    return aciColor(Math.abs(aci));
  }

  dashOf(e, L, m) {
    let lt = (g(e, 6) || 'BYLAYER').toUpperCase();
    if (lt === 'BYLAYER') lt = (L.ltype || 'CONTINUOUS').toUpperCase();
    if (lt === 'CONTINUOUS' || lt === 'BYBLOCK') return [];
    const pat = this.d.ltypes.get(lt);
    if (!pat || !pat.length) return [];
    const s = (Number(this.d.header.$LTSCALE?.[40]) || 1) * gn(e, 48, 1) * scaleOf(m);
    // Zero-length dashes are dots (drawn by the round caps).
    return pat.map((v) => Math.abs(v) * s || 0.01);
  }

  widthOf(e, L) {
    let lw = gn(e, 370, -1);
    if (lw === -1) lw = L.lineweight;
    // Lineweights are printed sizes (hundredths of a millimeter).
    if (lw > 0) return (lw / 100) * (72 / 25.4);
    return 0.5;
  }

  /** Emit subpaths (DXF coordinates) as a path or compound with the entity's style. */
  emitPaths(subs, e, m, ctx, { fill = false } = {}) {
    subs = subs.filter(Boolean);
    if (!subs.length) return;
    const layerName = g(e, 8, '0');
    const { rec, L } = this.layerRec(ctx.layer && layerName === '0' ? ctx.layer : layerName);
    const color = this.colorOf(e, ctx, L);
    const style = fill
      ? { fill: { type: 'solid', color }, stroke: null, strokeWidth: 1 }
      : { fill: null, stroke: { type: 'solid', color }, strokeWidth: this.widthOf(e, L), strokeCap: 'round', strokeJoin: 'round', dash: this.dashOf(e, L, m) };
    const toAnchors = (s) => {
      const a = [];
      for (const it of s.items) {
        const p = app(m, it.p);
        if (it.c1 && a.length) {
          const c1 = app(m, it.c1);
          const c2 = app(m, it.c2);
          a[a.length - 1].ox = c1.x;
          a[a.length - 1].oy = c1.y;
          a.push({ x: p.x, y: p.y, ix: c2.x, iy: c2.y, ox: p.x, oy: p.y });
        } else a.push({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y });
      }
      if (s.closed && a.length > 1) {
        const f = a[0];
        const l = a[a.length - 1];
        if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) {
          f.ix = l.ix;
          f.iy = l.iy;
          a.pop();
        }
      }
      return a;
    };
    const list = subs.map((s) => ({ anchors: toAnchors(s), closed: s.closed })).filter((s) => s.anchors.length >= 2 || (s.anchors.length === 1 && !fill));
    if (!list.length) return;
    let node;
    if (list.length === 1) {
      const s = list[0];
      node = createPath(s.anchors.length === 1 ? [s.anchors[0], { ...s.anchors[0] }] : s.anchors, s.closed, style);
    } else {
      const kids = list.map((s) => this.out.add(createPath(s.anchors, s.closed, { fill: null, stroke: null })));
      node = createCompound(kids, style, { fillRule: 'evenodd' });
    }
    this.add(node, rec, ctx);
  }

  add(node, rec, ctx) {
    this.out.add(node);
    if (ctx.group) ctx.group.push(node.id);
    else {
      this.out.setLayer(rec);
      this.out.push(node.id, []);
    }
    this.count++;
  }

  entity(e, m, ctx, depth = 0) {
    if (this.count > 300000) return;
    const T = e.type;
    const n = (c, dflt = 0) => gn(e, c, dflt);
    const ext = n(230, 1) < 0 ? -1 : 1; // extrusion -Z mirrors x (common for mirrored arcs)
    const em = ext < 0 ? multiply(m, [-1, 0, 0, 1, 0, 0]) : m;
    switch (T) {
      case 'LINE': {
        const s = new Sub(n(10), n(20));
        s.line(n(11), n(21));
        this.emitPaths([s], e, m, ctx);
        break;
      }
      case 'LWPOLYLINE':
        this.emitPaths([lwpolyline(e)], e, em, ctx);
        break;
      case 'POLYLINE': {
        const flags = n(70);
        if (flags & 16 || flags & 64) {
          this.warnings.add('Polygon meshes and polyface meshes were skipped.');
          break;
        }
        this.emitPaths([polySub(e.vertices || [], Boolean(flags & 1))], e, em, ctx);
        break;
      }
      case 'CIRCLE': {
        const { start, segments } = arcSegments(n(10), n(20), n(40), n(40), 0, 0, Math.PI * 2);
        const s = new Sub(...start);
        segments.forEach((seg) => s.add(seg));
        s.closed = true;
        this.emitPaths([s], e, em, ctx);
        break;
      }
      case 'ARC': {
        const a0 = (n(50) * Math.PI) / 180;
        let a1 = (n(51) * Math.PI) / 180;
        while (a1 <= a0) a1 += Math.PI * 2;
        const { start, segments } = arcSegments(n(10), n(20), n(40), n(40), 0, a0, a1);
        const s = new Sub(...start);
        segments.forEach((seg) => s.add(seg));
        this.emitPaths([s], e, em, ctx);
        break;
      }
      case 'ELLIPSE': {
        const mx = n(11);
        const my = n(21);
        const rx = Math.hypot(mx, my);
        const ry = rx * n(40, 1);
        const t0 = n(41, 0);
        let t1 = n(42, Math.PI * 2);
        while (t1 <= t0) t1 += Math.PI * 2;
        const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-6;
        const { start, segments } = arcSegments(n(10), n(20), rx, ry, Math.atan2(my, mx), t0, t1);
        const s = new Sub(...start);
        segments.forEach((seg) => s.add(seg));
        s.closed = full;
        this.emitPaths([s], e, em, ctx);
        break;
      }
      case 'SPLINE':
        this.emitPaths([splineSub(e)], e, m, ctx);
        break;
      case 'SOLID':
      case 'TRACE':
      case '3DFACE': {
        const pts = [[n(10), n(20)], [n(11), n(21)], T === '3DFACE' ? [n(12), n(22)] : [n(13), n(23)], T === '3DFACE' ? [n(13), n(23)] : [n(12), n(22)]];
        const s = new Sub(...pts[0]);
        for (const p of pts.slice(1)) if (Math.hypot(p[0] - s.items[s.items.length - 1].p[0], p[1] - s.items[s.items.length - 1].p[1]) > 1e-12) s.line(...p);
        s.closed = true;
        this.emitPaths([s], e, em, ctx, { fill: T !== '3DFACE' });
        break;
      }
      case 'POINT': {
        const r = 0.5 / scaleOf(m);
        const { start, segments } = arcSegments(n(10), n(20), r, r, 0, 0, Math.PI * 2);
        const s = new Sub(...start);
        segments.forEach((seg) => s.add(seg));
        s.closed = true;
        this.emitPaths([s], e, m, ctx, { fill: true });
        break;
      }
      case 'LEADER': {
        const xs = e.pairs.filter(([c]) => c === 10).map(([, v]) => Number(v));
        const ys = e.pairs.filter(([c]) => c === 20).map(([, v]) => Number(v));
        if (xs.length >= 2) {
          const s = new Sub(xs[0], ys[0]);
          for (let i = 1; i < xs.length; i++) s.line(xs[i], ys[i] ?? 0);
          this.emitPaths([s], e, m, ctx);
        }
        break;
      }
      case 'HATCH':
        this.hatch(e, m, ctx);
        break;
      case 'TEXT':
      case 'ATTRIB':
      case 'MTEXT':
        this.text(e, m, ctx);
        break;
      case 'INSERT':
      case 'DIMENSION':
        this.insert(e, m, ctx, depth);
        break;
      case 'ATTDEF':
      case 'VIEWPORT':
      case 'SEQEND':
      case 'VERTEX':
        break;
      case 'IMAGE':
        this.warnings.add('Referenced images (IMAGE entities) are not embedded in DXF files and were skipped.');
        break;
      default:
        this.skipped = (this.skipped || new Set()).add(T);
    }
  }

  hatch(e, m, ctx) {
    const solid = gn(e, 70, 0) === 1;
    const subs = [];
    const p = e.pairs;
    let i = p.findIndex(([c]) => c === 91);
    const loops = i >= 0 ? Number(p[i][1]) : 0;
    i++;
    for (let l = 0; l < loops && i < p.length; l++) {
      while (i < p.length && p[i][0] !== 92) i++;
      const type = Number(p[i]?.[1] || 0);
      i++;
      if (type & 2) {
        // Polyline boundary.
        const hasBulge = Number(p[i]?.[1]) === 1;
        i++;
        const closed = Number(p[i]?.[1]) === 1;
        i++;
        const nv = Number(p[i]?.[1]);
        i++;
        const verts = [];
        for (let k = 0; k < nv && i < p.length; k++) {
          const v = { x: Number(p[i][1]), y: Number(p[i + 1][1]), bulge: 0 };
          i += 2;
          if (hasBulge && p[i]?.[0] === 42) {
            v.bulge = Number(p[i][1]);
            i++;
          }
          verts.push(v);
        }
        subs.push(polySub(verts, closed || true));
      } else {
        const ne = Number(p[i]?.[1]);
        i++;
        let s = null;
        for (let k = 0; k < ne && i < p.length; k++) {
          const et = Number(p[i][1]);
          i++;
          const val = () => Number(p[i++][1]);
          if (et === 1) {
            const x0 = val();
            const y0 = val();
            const x1 = val();
            const y1 = val();
            if (!s) s = new Sub(x0, y0);
            s.line(x1, y1);
          } else if (et === 2 || et === 3) {
            const cx = val();
            const cy = val();
            let rx;
            let ry;
            let rot = 0;
            if (et === 2) rx = ry = val();
            else {
              const mx = val();
              const my = val();
              rx = Math.hypot(mx, my);
              ry = rx * val();
              rot = Math.atan2(my, mx);
            }
            let a0 = (val() * Math.PI) / 180;
            let a1 = (val() * Math.PI) / 180;
            const ccw = Number(p[i]?.[1]) !== 0;
            i++;
            if (!ccw) {
              a0 = -a0;
              a1 = -a1;
            }
            while (ccw ? a1 <= a0 : a1 >= a0) a1 += ccw ? Math.PI * 2 : -Math.PI * 2;
            const r = arcSegments(cx, cy, rx, ry, rot, a0, a1);
            if (!s) s = new Sub(...r.start);
            r.segments.forEach((seg) => s.add(seg));
          } else if (et === 4) {
            // Spline edge: read until the next edge type code.
            const rec = { pairs: [] };
            while (i < p.length && !(p[i][0] === 72 && k + 1 < ne) && p[i][0] !== 97 && p[i][0] !== 92) rec.pairs.push(p[i++]);
            rec.pairs = rec.pairs.map(([c, v]) => [c === 94 ? 71 : c === 73 ? 70 : c === 95 ? 72 : c === 96 ? 73 : c, v]);
            const sp = splineSub(rec);
            if (sp) {
              if (!s) s = new Sub(...sp.items[0].p);
              sp.items.slice(1).forEach((it) => s.add(it));
            }
          }
        }
        if (s) {
          s.closed = true;
          subs.push(s);
        }
      }
      // Skip source boundary references.
      while (i < p.length && p[i][0] !== 92 && p[i][0] !== 75) i++;
    }
    if (!solid) this.warnings.add('Hatch patterns were imported as solid fills.');
    this.emitPaths(subs, e, m, ctx, { fill: true });
  }

  text(e, m, ctx) {
    const isM = e.type === 'MTEXT';
    let raw = isM ? e.pairs.filter(([c]) => c === 3).map(([, v]) => v).join('') + (g(e, 1, '') || '') : g(e, 1, '');
    if (!raw) return;
    const text = isM ? mtextPlain(raw) : textPlain(raw);
    const h = gn(e, 40, 1) || 1;
    const layerName = g(e, 8, '0');
    const { rec, L } = this.layerRec(ctx.layer && layerName === '0' ? ctx.layer : layerName);
    let x = gn(e, 10);
    let y = gn(e, 20);
    let rot = gn(e, 50, 0);
    let align = 'left';
    let baselineDrop = 0;
    if (isM) {
      const dx = g(e, 11);
      if (dx !== undefined && g(e, 50) === undefined) rot = (Math.atan2(gn(e, 21), gn(e, 11)) * 180) / Math.PI;
      const att = gn(e, 71, 1);
      align = ['left', 'center', 'right'][(att - 1) % 3];
      // MTEXT is positioned by its top (1-3), middle (4-6) or bottom (7-9) line.
      const lines = text.split('\n').length;
      const row = Math.floor((att - 1) / 3);
      baselineDrop = row === 0 ? h : row === 1 ? h / 2 - ((lines - 1) * h * 1.66) / 2 : -(lines - 1) * h * 1.66;
    } else {
      const ha = gn(e, 72, 0);
      const va = gn(e, 73, 0);
      if ((ha || va) && g(e, 11) !== undefined) {
        x = gn(e, 11);
        y = gn(e, 21);
      }
      align = ha === 1 || ha === 4 ? 'center' : ha === 2 ? 'right' : 'left';
      if (va === 3) baselineDrop = h;
      else if (va === 2 || ha === 4) baselineDrop = h / 2;
    }
    const color = this.colorOf(e, ctx, L);
    const wf = gn(e, 41, 1) || 1;
    // Local text space: origin at the insertion point, y down, size in drawing units.
    const r = (rot * Math.PI) / 180;
    const local = [Math.cos(r), Math.sin(r), Math.sin(r), -Math.cos(r), x, y];
    let M = multiply(m, local);
    const s = scaleOf(M);
    M = [M[0] / s, M[1] / s, M[2] / s, M[3] / s, M[4], M[5]];
    const style = (g(e, 7, '') || '').toLowerCase();
    const fam = this.families.find((f) => style && f.toLowerCase().replace(/\s/g, '') === style.replace(/\s/g, '')) || this.families.find((f) => /roboto|arial|helvetica|inter/i.test(f)) || 'Inter';
    // Text height is the capital height: the font size is about 1.4 times larger.
    const size = h * 1.4 * s;
    const node = createText(text, 0, baselineDrop * s, {
      transform: M,
      char: { ...DEFAULT_CHAR, fontFamily: fam, fontSize: Math.round(size * 1000) / 1000, horizontalScale: Math.round(wf * 100), leading: isM ? Math.round(h * 1.66 * s * 1000) / 1000 : null },
      para: { ...DEFAULT_PARA, align },
      fill: { type: 'solid', color },
    });
    this.add(node, rec, ctx);
  }

  insert(e, m, ctx, depth) {
    if (depth > 16) return;
    const block = this.d.blocks.get(g(e, 2, ''));
    if (!block) return;
    const layerName = g(e, 8, '0');
    const { rec, L } = this.layerRec(ctx.layer && layerName === '0' ? ctx.layer : layerName);
    const isDim = e.type === 'DIMENSION';
    const sx = isDim ? 1 : gn(e, 41, 1);
    const sy = isDim ? 1 : gn(e, 42, 1);
    const rot = isDim ? 0 : (gn(e, 50, 0) * Math.PI) / 180;
    const cols = Math.max(1, gn(e, 70, 1));
    const rows = Math.max(1, gn(e, 71, 1));
    const cs = gn(e, 44, 0);
    const rs = gn(e, 45, 0);
    const ix = isDim ? 0 : gn(e, 10);
    const iy = isDim ? 0 : gn(e, 20);
    const color = this.colorOf(e, ctx, L);
    const kids = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cr = Math.cos(rot);
        const sr = Math.sin(rot);
        const ox = c * cs;
        const oy = r * rs;
        const place = [cr * sx, sr * sx, -sr * sy, cr * sy, ix + cr * ox - sr * oy, iy + sr * ox + cr * oy];
        const bm = multiply(m, multiply(place, [1, 0, 0, 1, -block.base[0], -block.base[1]]));
        const inner = { group: kids, blockColor: color, layer: layerName === '0' ? ctx.layer : layerName };
        for (const be of block.entities) this.entity(be, bm, inner, depth + 1);
      }
    }
    if (!kids.length) return;
    const node = createGroup(kids, { name: block.name.startsWith('*') ? '' : block.name });
    this.out.add(node);
    if (ctx.group) ctx.group.push(node.id);
    else {
      this.out.setLayer(rec);
      this.out.push(node.id, []);
    }
  }
}

const app = (m, p) => ({ x: m[0] * p[0] + m[2] * p[1] + m[4], y: m[1] * p[0] + m[3] * p[1] + m[5] });
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/** Attach VERTEX records to their POLYLINE (and drop SEQEND). */
function joinPolylines(recs) {
  const out = [];
  let poly = null;
  for (const r of recs) {
    if (r.type === 'POLYLINE') {
      poly = r;
      poly.vertices = [];
      out.push(r);
    } else if (r.type === 'VERTEX' && poly) {
      if (gn(r, 70, 0) & 16) continue; // spline frame control point
      poly.vertices.push({ x: gn(r, 10), y: gn(r, 20), bulge: gn(r, 42, 0) });
    } else if (r.type === 'SEQEND') poly = null;
    else {
      poly = null;
      out.push(r);
    }
  }
  return out;
}

/** Read a DXF file's structure and units without converting. */
export function readDXF(text) {
  const pairs = dxfPairs(text);
  const sections = parseSections(pairs);
  if (!sections.ENTITIES && !sections.BLOCKS) throw new Error('This is not a DXF file, or it is a binary DXF (save it as ASCII DXF).');
  const header = readHeader(pairs, sections.HEADER);
  const { layers, ltypes } = readTables(pairs, sections.TABLES);
  const blocks = readBlocks(pairs, sections.BLOCKS);
  for (const b of blocks.values()) b.entities = joinPolylines(b.entities);
  const entities = sections.ENTITIES ? joinPolylines(records(pairs, sections.ENTITIES.from, sections.ENTITIES.to)) : [];
  const insunits = Number(header.$INSUNITS?.[70] ?? 0);
  const measurement = Number(header.$MEASUREMENT?.[70] ?? 1);
  const units = UNITS[insunits] ? insunits : 0;
  return { header, layers, ltypes, blocks, entities, units, unitLabel: UNITS[units].label, metric: measurement === 1, version: header.$ACADVER?.[1] || '' };
}

/**
 * Convert a DXF drawing. opts: { unitPt (points per drawing unit; default
 * from $INSUNITS, or 1 mm for unitless metric drawings), families }.
 * Returns { layers, nodes, bounds, warnings }.
 */
export function convertDXF(data, opts = {}) {
  const unitPt = opts.unitPt || UNITS[data.units].pt || (data.metric ? 72 / 25.4 : 72);
  const conv = new DXFConverter(data, { scale: unitPt, families: opts.families });
  const m = [unitPt, 0, 0, -unitPt, 0, 0];
  for (const e of data.entities) {
    if (gn(e, 67, 0) === 1) continue; // paper space
    try {
      conv.entity(e, m, {});
    } catch {
      conv.warnings.add('Some entities could not be read and were skipped.');
    }
  }
  const { layers, nodes } = conv.out.finish();
  // Keep the drawing's layer order (the table lists layers in creation order).
  const order = [...data.layers.keys()];
  layers.sort((a, b) => order.indexOf(a.key.slice(4)) - order.indexOf(b.key.slice(4)));
  const warnings = [...conv.warnings];
  if (conv.skipped?.size) warnings.push(`Unsupported entities were skipped: ${[...conv.skipped].slice(0, 8).join(', ')}.`);
  // Move the drawing to the origin.
  const shim = { get: (id) => nodes.get(id) };
  let bounds = null;
  for (const l of layers) for (const id of l.ids) bounds = unionBounds(bounds, nodeBoundsSafe(shim, nodes.get(id)));
  return { layers, nodes, bounds, warnings, unitPt };
}

import { nodeBounds } from '../../../model/geometry.js';
function nodeBoundsSafe(shim, n) {
  try {
    return nodeBounds(shim, n);
  } catch {
    return null;
  }
}
function unionBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
