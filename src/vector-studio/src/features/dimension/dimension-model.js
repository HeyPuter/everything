/**
 * Dimensions: measurement annotations as live artwork. A dimension is a
 * leaf node of type 'dimension' that stores the points it measures and
 * where its dimension line sits; its lines, extension lines, end marks and
 * value label are generated, so the value always matches the geometry.
 *
 *   { type: 'dimension', kind: 'linear' | 'angular' | 'radial',
 *     orient,            linear: 'aligned' | 'horizontal' | 'vertical' | 'rotated'
 *                       radial: 'radius' | 'diameter'
 *     angle,             linear 'rotated': direction in degrees (counterclockwise)
 *     p1, p2,            linear: the measured points; angular: the ends of the
 *                       two arms; radial: the center and a point on the circle
 *     vertex,            angular: the corner
 *     at,                a point the dimension line (linear), arc (angular) or
 *                       label (radial) passes through
 *     labelShift,        label offset along the dimension line or arc
 *     attach,            { of: own id, p1, p2, vertex: ref } or null, where
 *                       ref = { id, anchor: i } (a path's anchor) or
 *                       { id, box: [fx, fy] } (a point of an object's bounds)
 *     dim }              display options, see DIM_DEFAULTS
 *
 * Attached points follow the objects they were placed on: move or reshape
 * the object and the dimension keeps measuring it, the dimension line
 * keeping its distance. `attach.of` names the dimension the references were
 * made for, so a pasted copy (which gets a new id) measures its own stored
 * points instead of the original's objects.
 */
import { uid } from '../../lib/ids.js';
import { DEFAULT_CHAR, DEFAULT_PARA } from '../../model/nodes.js';
import { layoutText } from '../../model/text-layout.js';
import { nodeBounds } from '../../model/geometry.js';

/** Units a dimension can show; factors are points per unit. */
export const DIM_UNITS = {
  pt: { label: 'Points', abbr: 'pt', factor: 1 },
  px: { label: 'Pixels', abbr: 'px', factor: 1 },
  pc: { label: 'Picas', abbr: 'pc', factor: 12 },
  in: { label: 'Inches', abbr: 'in', factor: 72 },
  ft: { label: 'Feet', abbr: 'ft', factor: 864 },
  ftin: { label: 'Feet & Inches', abbr: '', factor: 864 },
  yd: { label: 'Yards', abbr: 'yd', factor: 2592 },
  mm: { label: 'Millimeters', abbr: 'mm', factor: 72 / 25.4 },
  cm: { label: 'Centimeters', abbr: 'cm', factor: 72 / 2.54 },
  m: { label: 'Meters', abbr: 'm', factor: 7200 / 2.54 },
};

export const END_STYLES = { arrow: 'Filled Arrow', open: 'Open Arrow', tick: 'Tick', dot: 'Dot', none: 'None' };

export const DIM_DEFAULTS = Object.freeze({
  units: 'auto', // 'auto': the scale's real-world unit, else the document's units
  precision: 2, // decimal places
  showUnits: true,
  scale: Object.freeze({ on: false, paper: 1, paperUnit: 'in', real: 1, realUnit: 'ft' }),
  prefix: '',
  suffix: '',
  symbol: true, // radial: R / Ø before the value
  fontFamily: 'Inter',
  fontSize: 9,
  textColor: '#1a1a1a',
  labelPosition: 'above', // 'above' | 'center' | 'below'
  labelOrientation: 'aligned', // 'aligned' | 'horizontal'
  lineColor: '#1a1a1a',
  lineWidth: 0.75,
  ends: 'arrow',
  endSize: 7,
  extension: true,
  extGap: 2,
  extOvershoot: 4,
  centerMark: true,
});

export const isDimension = (n) => n?.type === 'dimension';

/** Options merged with defaults. */
export function dimOptions(o = {}) {
  return { ...DIM_DEFAULTS, ...o, scale: { ...DIM_DEFAULTS.scale, ...(o.scale || {}) } };
}

/** How many points a kind needs before its line is placed. */
export const POINTS_NEEDED = { linear: 2, angular: 3, radial: 2 };

export const KIND_LABELS = { linear: 'Linear', angular: 'Angular', radial: 'Radial' };

/** A new dimension. `pts`: { p1, p2, vertex? }; `at` defaults to a short offset. */
export function createDimension(kind, pts, { orient, angle = 0, at, attach = null, dim = {}, extra = {} } = {}) {
  const id = uid('d');
  const node = {
    id,
    type: 'dimension',
    name: '',
    kind,
    orient: orient || (kind === 'radial' ? 'radius' : kind === 'linear' ? 'aligned' : undefined),
    angle,
    p1: { ...pts.p1 },
    p2: { ...pts.p2 },
    ...(kind === 'angular' ? { vertex: { ...pts.vertex } } : {}),
    at: null,
    labelShift: 0,
    attach: attach ? { ...attach, of: id } : null,
    dim: dimOptions(dim),
    opacity: 1,
    blendMode: 'normal',
    effects: [],
    hidden: false,
    locked: false,
    ...extra,
  };
  node.at = at ? { ...at } : defaultAt(node);
  return node;
}

function defaultAt(node) {
  const { p1, p2 } = node;
  if (node.kind === 'angular') {
    const v = node.vertex;
    const r = 0.6 * Math.min(dist(v, p1), dist(v, p2)) || 20;
    const a = midAngle(v, p1, p2);
    return { x: v.x + Math.cos(a) * r, y: v.y + Math.sin(a) * r };
  }
  if (node.kind === 'radial') {
    const u = unit(sub(p2, p1));
    return { x: p2.x + u.x * 20, y: p2.y + u.y * 20 };
  }
  const { d, n } = linearFrame(node, p1, p2);
  void d;
  return { x: (p1.x + p2.x) / 2 - n.x * 20, y: (p1.y + p2.y) / 2 - n.y * 20 };
}

// ---- small vector helpers ----

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b, s = 1) => ({ x: a.x + b.x * s, y: a.y + b.y * s });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function unit(v, fallback = { x: 1, y: 0 }) {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l } : fallback;
}
/** Angle into (-PI, PI]. */
function normAngle(a) {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  if (x > Math.PI) x -= 2 * Math.PI;
  return x;
}
const angleOf = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);
function midAngle(v, a, b) {
  const a0 = angleOf(v, a);
  return a0 + normAngle(angleOf(v, b) - a0) / 2;
}
/** Text angle that reads left to right (vertical text reads bottom to top). */
function readable(a) {
  let x = normAngle(a);
  if (x > Math.PI / 2 - 1e-6) x -= Math.PI;
  else if (x < -Math.PI / 2 - 1e-6) x += Math.PI;
  return x;
}

// ---- values and labels ----

/** The unit a dimension shows its lengths in. */
export function displayUnit(o, docUnits = 'pt') {
  if (o.units && o.units !== 'auto' && DIM_UNITS[o.units]) return o.units;
  if (o.scale?.on && DIM_UNITS[o.scale.realUnit]) return o.scale.realUnit;
  return DIM_UNITS[docUnits] ? docUnits : 'pt';
}

/** A drawn length (points) as a real-world length (points) through the drawing scale. */
export function realLength(pt, o) {
  const s = o.scale;
  if (!s?.on) return pt;
  const paper = (Number(s.paper) || 0) * (DIM_UNITS[s.paperUnit]?.factor || 1);
  const real = (Number(s.real) || 0) * (DIM_UNITS[s.realUnit]?.factor || 1);
  return paper > 0 ? (pt / paper) * real : pt;
}

export function formatNumber(v, precision = 2) {
  const p = Math.max(0, Math.min(6, Math.round(precision)));
  const s = (Math.round(v * 10 ** p) / 10 ** p).toFixed(p);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

/** A length in points as the dimension shows it: "12.50 mm", 3' 4.5". */
export function formatDimLength(pt, o, docUnits = 'pt') {
  const unitKey = displayUnit(o, docUnits);
  const real = realLength(pt, o);
  if (unitKey === 'ftin') {
    const p = Math.max(0, Math.min(4, Math.round(o.precision)));
    const total = Math.abs(real) / 72;
    let ft = Math.floor(total / 12 + 1e-9);
    let inch = Math.round((total - ft * 12) * 10 ** p) / 10 ** p;
    if (inch >= 12) {
      ft += 1;
      inch -= 12;
    }
    return `${real < 0 ? '-' : ''}${ft}' ${formatNumber(inch, p)}"`;
  }
  const u = DIM_UNITS[unitKey];
  const n = formatNumber(real / u.factor, o.precision);
  return o.showUnits && u.abbr ? `${n} ${u.abbr}` : n;
}

export function formatDimAngle(deg, o) {
  return `${formatNumber(deg, o.precision)}°`;
}

// ---- attachments ----

/** The document point a reference names, or null when it no longer resolves. */
export function refPoint(doc, ref) {
  const n = ref && doc.get(ref.id);
  if (!n) return null;
  if (ref.anchor != null) {
    const a = n.anchors?.[ref.anchor];
    return a ? { x: a.x, y: a.y } : null;
  }
  if (ref.box) {
    const b = nodeBounds(doc, n);
    return b ? { x: b.x + ref.box[0] * b.w, y: b.y + ref.box[1] * b.h } : null;
  }
  return null;
}

const POINT_KEYS = ['p1', 'p2', 'vertex'];

/** True when the dimension's references were made for it (not a pasted copy). */
export function isAttached(node) {
  const a = node?.attach;
  return Boolean(a && a.of === node.id && POINT_KEYS.some((k) => a[k]));
}

/** The objects a dimension's points follow. */
export function attachedNodes(doc, node) {
  if (!isAttached(node)) return [];
  return POINT_KEYS.map((k) => node.attach[k] && doc.get(node.attach[k].id)).filter(Boolean);
}

/** The measured points with attachments applied. */
export function resolvePoints(doc, node) {
  const out = { p1: node.p1, p2: node.p2, vertex: node.vertex || null };
  if (!doc || !isAttached(node)) return out;
  for (const k of POINT_KEYS) {
    const p = node.attach[k] && refPoint(doc, node.attach[k]);
    if (p) out[k] = p;
  }
  return out;
}

// ---- layout ----

const measureCache = new Map();

/** Width and height of a label in the dimension's type. */
export function measureLabel(text, o) {
  const key = `${o.fontFamily}|${o.fontSize}|${text}`;
  let m = measureCache.get(key);
  if (!m) {
    const lay = layoutText({ type: 'text', kind: 'point', text, x: 0, y: 0, width: 0, height: 0, transform: [1, 0, 0, 1, 0, 0], char: { ...DEFAULT_CHAR, fontFamily: o.fontFamily, fontSize: o.fontSize }, para: { ...DEFAULT_PARA } });
    m = { w: lay.bounds?.w || text.length * o.fontSize * 0.55, h: o.fontSize };
    if (measureCache.size > 500) measureCache.clear();
    measureCache.set(key, m);
  }
  return m;
}

/** Direction along the dimension line and its normal for a linear dimension. */
export function linearFrame(node, p1, p2) {
  let d;
  const o = node.orient || 'aligned';
  if (o === 'horizontal') d = { x: 1, y: 0 };
  else if (o === 'vertical') d = { x: 0, y: 1 };
  else if (o === 'rotated') {
    const a = ((node.angle || 0) * Math.PI) / 180;
    d = { x: Math.cos(a), y: -Math.sin(a) };
  } else d = unit(sub(p2, p1));
  return { d, n: { x: -d.y, y: d.x } };
}

/**
 * The geometry of a dimension: { value, text, segments: [[a, b]], arcs:
 * [{ cx, cy, r, a0, sweep }], ends: [{ x, y, ux, uy }], label: { x, y,
 * angle, w, h }, track: [points along the dimension line], effective:
 * { p1, p2, vertex, at } (the drawn points, attachments applied) }.
 */
export function dimensionLayout(node, pts = node, docUnits = 'pt') {
  const o = dimOptions(node.dim);
  if (node.kind === 'angular') return angularLayout(node, pts, o);
  if (node.kind === 'radial') return radialLayout(node, pts, o, docUnits);
  return linearLayout(node, pts, o, docUnits);
}

/** Layout of a dimension in a document (attachments applied, the document's units). */
export function layoutIn(doc, node) {
  return dimensionLayout(node, resolvePoints(doc, node), doc?.root?.units);
}

const labelGap = (o) => Math.max(1.5, o.fontSize * 0.3) + o.lineWidth / 2;

function linearLayout(node, pts, o, docUnits) {
  // The offset of the line comes from the stored points; it applies to the resolved ones.
  const S = linearFrame(node, node.p1, node.p2);
  const midS = { x: (node.p1.x + node.p2.x) / 2, y: (node.p1.y + node.p2.y) / 2 };
  const off = dot(sub(node.at || midS, midS), S.n);
  const { p1, p2 } = pts;
  const { d, n } = linearFrame(node, p1, p2);
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const base = add(mid, n, off);
  const t1 = dot(sub(p1, base), d);
  const t2 = dot(sub(p2, base), d);
  const e1 = add(base, d, t1);
  const e2 = add(base, d, t2);
  const value = Math.abs(t2 - t1);
  const text = `${o.prefix}${formatDimLength(value, o, docUnits)}${o.suffix}`;
  const out = { value, text, segments: [], arcs: [], ends: [], track: [e1, e2], effective: { p1, p2, vertex: null, at: base } };
  // Extension lines from the measured points to just past the dimension line.
  if (o.extension) {
    for (const [p, e] of [[p1, e1], [p2, e2]]) {
      const v = sub(e, p);
      const len = Math.hypot(v.x, v.y);
      if (len <= o.extGap + 0.01) continue;
      const u = unit(v);
      out.segments.push([add(p, u, o.extGap), add(e, u, o.extOvershoot)]);
    }
  }
  const lo = Math.min(t1, t2);
  const hi = Math.max(t1, t2);
  const { w, h } = measureLabel(text, o);
  const horizontal = o.labelOrientation === 'horizontal';
  const angle = horizontal ? 0 : readable(Math.atan2(d.y, d.x));
  const c = (lo + hi) / 2 + (node.labelShift || 0);
  // Half the label's extent along the line, and how far off the line it must sit.
  const along = horizontal ? (Math.abs(d.x) * w + Math.abs(d.y) * h) / 2 : w / 2;
  const gap = labelGap(o);
  const center = add(base, d, c);
  let lc = center;
  if (o.labelPosition !== 'center') {
    const up = { x: Math.sin(angle), y: -Math.cos(angle) };
    const sideUp = o.labelPosition === 'above' ? up : { x: -up.x, y: -up.y };
    const hn = (Math.abs(n.x) * w + Math.abs(n.y) * h) / 2;
    const t = horizontal ? (hn + gap) / Math.max(Math.abs(dot(sideUp, n)), 0.2) : h / 2 + gap;
    lc = add(center, sideUp, t);
  }
  out.label = { x: lc.x, y: lc.y, angle, w, h };
  // End marks point outward; too short a line puts arrows outside, pointing in.
  const room = hi - lo;
  const inline = o.labelPosition === 'center';
  const need = 2.4 * o.endSize + (inline ? 2 * (along + gap) : 0);
  const outside = (o.ends === 'arrow' || o.ends === 'open') && room < need;
  let from = Math.min(lo, c - along);
  let to = Math.max(hi, c + along);
  if (outside) {
    from = Math.min(from, lo - o.endSize * 1.6);
    to = Math.max(to, hi + o.endSize * 1.6);
  }
  const pieces = inline ? cut([from, to], c - along - gap, c + along + gap) : [[from, to]];
  for (const [a, b] of pieces) out.segments.push([add(base, d, a), add(base, d, b)]);
  const eLo = add(base, d, lo);
  const eHi = add(base, d, hi);
  out.ends.push({ x: eLo.x, y: eLo.y, ux: outside ? d.x : -d.x, uy: outside ? d.y : -d.y });
  out.ends.push({ x: eHi.x, y: eHi.y, ux: outside ? -d.x : d.x, uy: outside ? -d.y : d.y });
  out.dir = d;
  return out;
}

/** An interval with [a, b] removed: up to two pieces. */
function cut([from, to], a, b) {
  const out = [];
  if (a > from) out.push([from, Math.min(a, to)]);
  if (b < to) out.push([Math.max(b, from), to]);
  return out.filter(([x, y]) => y - x > 1e-6);
}

function angularLayout(node, pts, o) {
  const VS = node.vertex;
  const r = Math.max(1, dist(node.at || VS, VS));
  const aS = angleOf(VS, node.p1);
  const deltaS = normAngle(angleOf(VS, node.p2) - aS);
  const atS = normAngle(angleOf(VS, node.at || VS) - aS);
  // The side the arc was placed on: the angle between the arms, or the outside (reflex) one.
  const inside = deltaS >= 0 ? atS >= -1e-9 && atS <= deltaS + 1e-9 : atS <= 1e-9 && atS >= deltaS - 1e-9;
  const V = pts.vertex || VS;
  const A = pts.p1;
  const B = pts.p2;
  const a0 = angleOf(V, A);
  const delta = normAngle(angleOf(V, B) - a0);
  const sweep = inside || Math.abs(delta) < 1e-9 ? delta : delta - Math.sign(delta) * 2 * Math.PI;
  const value = (Math.abs(sweep) * 180) / Math.PI;
  const text = `${o.prefix}${formatDimAngle(value, o)}${o.suffix}`;
  const mid = a0 + sweep / 2;
  const at = { x: V.x + Math.cos(mid) * r, y: V.y + Math.sin(mid) * r };
  const out = { value, text, segments: [], arcs: [], ends: [], effective: { p1: A, p2: B, vertex: V, at } };
  if (o.extension) {
    for (const X of [A, B]) {
      const dX = dist(V, X);
      if (r <= dX + o.extGap) continue;
      const u = unit(sub(X, V));
      out.segments.push([add(X, u, o.extGap), add(V, u, r + o.extOvershoot)]);
    }
  }
  const { w, h } = measureLabel(text, o);
  const horizontal = o.labelOrientation === 'horizontal';
  const sgn = sweep < 0 ? -1 : 1;
  const theta = mid + (node.labelShift || 0) / r;
  const radial = { x: Math.cos(theta), y: Math.sin(theta) };
  const angle = horizontal ? 0 : readable(theta + Math.PI / 2);
  const gap = labelGap(o);
  const along = horizontal ? (Math.abs(radial.y) * w + Math.abs(radial.x) * h) / 2 : w / 2;
  const across = horizontal ? (Math.abs(radial.x) * w + Math.abs(radial.y) * h) / 2 : h / 2;
  const lr = o.labelPosition === 'above' ? r + gap + across : o.labelPosition === 'below' ? Math.max(0, r - gap - across) : r;
  out.label = { x: V.x + radial.x * lr, y: V.y + radial.y * lr, angle, w, h };
  const arcLen = r * Math.abs(sweep);
  const inline = o.labelPosition === 'center';
  const need = 2.4 * o.endSize + (inline ? 2 * (along + gap) : 0);
  const outside = (o.ends === 'arrow' || o.ends === 'open') && arcLen < need;
  // The arc, from the first arm to the second, reaching the label when it is moved past an end.
  const t0 = 0;
  const t1 = Math.abs(sweep);
  const tl = sgn * (theta - a0);
  let from = Math.min(t0, tl - along / r);
  let to = Math.max(t1, tl + along / r);
  if (outside) {
    from = Math.min(from, -(o.endSize * 1.6) / r);
    to = Math.max(to, t1 + (o.endSize * 1.6) / r);
  }
  const pieces = inline ? cut([from, to], tl - (along + gap) / r, tl + (along + gap) / r) : [[from, to]];
  for (const [p, q] of pieces) out.arcs.push({ cx: V.x, cy: V.y, r, a0: a0 + sgn * p, sweep: sgn * (q - p) });
  const tan = (t) => ({ x: -Math.sin(t) * sgn, y: Math.cos(t) * sgn });
  const s0 = tan(a0);
  const s1 = tan(a0 + sweep);
  const P0 = { x: V.x + Math.cos(a0) * r, y: V.y + Math.sin(a0) * r };
  const P1 = { x: V.x + Math.cos(a0 + sweep) * r, y: V.y + Math.sin(a0 + sweep) * r };
  out.ends.push({ x: P0.x, y: P0.y, ux: outside ? s0.x : -s0.x, uy: outside ? s0.y : -s0.y });
  out.ends.push({ x: P1.x, y: P1.y, ux: outside ? -s1.x : s1.x, uy: outside ? -s1.y : s1.y });
  out.track = arcPoints(V.x, V.y, r, a0, sweep);
  out.sweepSign = sgn;
  out.radius = r;
  return out;
}

function radialLayout(node, pts, o, docUnits) {
  const CS = node.p1;
  const PS = node.p2;
  const uS = unit(sub(PS, CS));
  const lead = dot(sub(node.at || PS, PS), uS);
  const C = pts.p1;
  const P = pts.p2;
  const r = dist(C, P);
  const u = unit(sub(P, C), uS);
  const diameter = node.orient === 'diameter';
  const value = diameter ? 2 * r : r;
  const sym = o.symbol ? (diameter ? 'Ø' : 'R') : '';
  const text = `${sym}${o.prefix}${formatDimLength(value, o, docUnits)}${o.suffix}`;
  const D = r + lead;
  const out = { value, text, segments: [], arcs: [], ends: [], effective: { p1: C, p2: P, vertex: null, at: add(P, u, lead) } };
  const { w, h } = measureLabel(text, o);
  const horizontal = o.labelOrientation === 'horizontal';
  const angle = horizontal ? 0 : readable(Math.atan2(u.y, u.x));
  const along = horizontal ? (Math.abs(u.x) * w + Math.abs(u.y) * h) / 2 : w / 2;
  const gap = labelGap(o);
  const n = { x: -u.y, y: u.x };
  const start = diameter ? -r : 0;
  const center = add(C, u, D);
  let lc = center;
  if (o.labelPosition !== 'center') {
    const up = { x: Math.sin(angle), y: -Math.cos(angle) };
    const sideUp = o.labelPosition === 'above' ? up : { x: -up.x, y: -up.y };
    const hn = (Math.abs(n.x) * w + Math.abs(n.y) * h) / 2;
    const t = horizontal ? (hn + gap) / Math.max(Math.abs(dot(sideUp, n)), 0.2) : h / 2 + gap;
    lc = add(center, sideUp, t);
  }
  out.label = { x: lc.x, y: lc.y, angle, w, h };
  const from = Math.min(start, D - along);
  const to = Math.max(r, D + along);
  const pieces = o.labelPosition === 'center' ? cut([from, to], D - along - gap, D + along + gap) : [[from, to]];
  for (const [a, b] of pieces) out.segments.push([add(C, u, a), add(C, u, b)]);
  const outsideLabel = D - along > r;
  out.ends.push({ x: P.x, y: P.y, ux: outsideLabel ? -u.x : u.x, uy: outsideLabel ? -u.y : u.y });
  if (diameter) {
    const Q = add(C, u, -r);
    out.ends.push({ x: Q.x, y: Q.y, ux: -u.x, uy: -u.y });
  }
  if (o.centerMark) {
    const k = Math.max(2, o.endSize * 0.6);
    out.segments.push([add(C, u, -k), add(C, u, k)], [add(C, n, -k), add(C, n, k)]);
  }
  out.track = [add(C, u, from), add(C, u, to)];
  out.dir = u;
  return out;
}

/** Points along an arc (for hit testing and overlays). */
export function arcPoints(cx, cy, r, a0, sweep, step = Math.PI / 36) {
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / step) + 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = a0 + (sweep * i) / (n - 1);
    out.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r });
  }
  return out;
}

const pt = (p) => ({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y });

/** Cubic Bezier anchors for an arc (sweep in radians, either direction). */
export function arcAnchors(cx, cy, r, a0, sweep) {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4) * r;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + step * i;
    const x = cx + Math.cos(t) * r;
    const y = cy + Math.sin(t) * r;
    const tx = -Math.sin(t);
    const ty = Math.cos(t);
    out.push({ x, y, ix: i ? x - tx * k : x, iy: i ? y - ty * k : y, ox: i < n ? x + tx * k : x, oy: i < n ? y + ty * k : y });
  }
  return out;
}

function circleAnchors(cx, cy, r) {
  const a = arcAnchors(cx, cy, r, 0, 2 * Math.PI);
  return [{ ...a[0], ix: a[4].ix, iy: a[4].iy }, a[1], a[2], a[3]];
}

/** End mark shapes at a tip pointing along (ux, uy): [{ anchors, closed, filled }]. */
export function endMark(end, o) {
  const L = o.endSize;
  const u = { x: end.ux, y: end.uy };
  const n = { x: -u.y, y: u.x };
  const T = { x: end.x, y: end.y };
  const B = add(T, u, -L);
  const wdt = L * 0.3;
  switch (o.ends) {
    case 'arrow':
      return [{ anchors: [pt(T), pt(add(B, n, wdt)), pt(add(B, n, -wdt))], closed: true, filled: true }];
    case 'open':
      return [{ anchors: [pt(add(B, n, wdt * 1.2)), pt(T), pt(add(B, n, -wdt * 1.2))], closed: false, filled: false }];
    case 'tick': {
      const v = unit({ x: u.x + n.x, y: u.y + n.y });
      return [{ anchors: [pt(add(T, v, -L / 2)), pt(add(T, v, L / 2))], closed: false, filled: false, heavy: true }];
    }
    case 'dot':
      return [{ anchors: circleAnchors(T.x, T.y, Math.max(0.75, L / 5)), closed: true, filled: true }];
    default:
      return [];
  }
}

// ---- editing ----

/**
 * Patch moving one measured point (`key`) to `p` while keeping the
 * dimension line where it is (its offset, the arc radius, the label lead).
 */
export function movePointPatch(node, key, p) {
  const next = { ...node, [key]: { x: p.x, y: p.y } };
  const lay = dimensionLayout(node);
  let at = lay.effective.at;
  if (node.kind === 'linear') {
    const S = linearFrame(node, node.p1, node.p2);
    const midS = { x: (node.p1.x + node.p2.x) / 2, y: (node.p1.y + node.p2.y) / 2 };
    const off = dot(sub(node.at, midS), S.n);
    const N = linearFrame(next, next.p1, next.p2);
    const mid = { x: (next.p1.x + next.p2.x) / 2, y: (next.p1.y + next.p2.y) / 2 };
    at = add(mid, N.n, off);
  } else if (node.kind === 'angular') {
    // Same radius, and the same side of the arms (the angle between them or the reflex one).
    const r = dist(node.at, node.vertex);
    const m = midAngle(next.vertex, next.p1, next.p2) + (lay.value > 180 + 1e-9 ? Math.PI : 0);
    at = { x: next.vertex.x + Math.cos(m) * r, y: next.vertex.y + Math.sin(m) * r };
  } else if (node.kind === 'radial') {
    const uS = unit(sub(node.p2, node.p1));
    const lead = dot(sub(node.at, node.p2), uS);
    at = add(next.p2, unit(sub(next.p2, next.p1), uS), lead);
  }
  return { [key]: { x: p.x, y: p.y }, at };
}

/**
 * Patch keeping a dimension in step with a transform: the drawn points
 * (attachments applied, from `effective`) move with the matrix, which
 * detaches it from the objects it measured. Horizontal and vertical
 * dimensions keep measuring along the transformed direction.
 */
export function transformDimension(node, m, effective, opts = {}) {
  const P = (p) => p && { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
  const e = effective || { p1: node.p1, p2: node.p2, vertex: node.vertex, at: node.at };
  const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const patch = { p1: P(e.p1), p2: P(e.p2), at: P(e.at), labelShift: (node.labelShift || 0) * s, attach: null };
  if (node.kind === 'angular') patch.vertex = P(e.vertex);
  if (node.kind === 'linear' && node.orient !== 'aligned') {
    const { d } = linearFrame(node, node.p1, node.p2);
    const t = { x: m[0] * d.x + m[2] * d.y, y: m[1] * d.x + m[3] * d.y };
    const deg = ((Math.atan2(-t.y, t.x) * 180) / Math.PI + 360) % 180;
    if (Math.abs(deg) < 1e-6 || Math.abs(deg - 180) < 1e-6) patch.orient = 'horizontal';
    else if (Math.abs(deg - 90) < 1e-6) patch.orient = 'vertical';
    else Object.assign(patch, { orient: 'rotated', angle: deg });
  }
  if (opts.scaleStrokes && s !== 1) {
    const o = dimOptions(node.dim);
    patch.dim = { ...o, fontSize: o.fontSize * s, lineWidth: o.lineWidth * s, endSize: o.endSize * s, extGap: o.extGap * s, extOvershoot: o.extOvershoot * s };
  }
  return patch;
}
