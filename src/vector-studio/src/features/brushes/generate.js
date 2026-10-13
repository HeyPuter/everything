/**
 * Brush and variable-width stroke artwork.
 *
 * Every generator takes the path's outline (subpaths after geometry
 * effects), its style and the effective brush, and returns shapes in
 * document space, in paint order:
 *   { subpaths: [{ anchors, closed }], fill, stroke, strokeWidth,
 *     strokeCap, strokeJoin, miterLimit, fillRule, opacity }
 * live.js turns them into virtual paths, Expand Appearance into real ones.
 *
 * Scale: the stroke weight scales every brush (1 pt draws the brush at
 * its own size), so Scale Strokes & Effects scales brushes too. Width
 * profiles shape calligraphic, art, pattern and bristle brushes as well as
 * plain strokes.
 */
import { buildSpine, spineSampler } from './spine.js';
import { sweepOutline, fitRing } from './outline.js';
import { warpAnchors } from './warp.js';
import { profileFunction, profileMax } from './width-profile.js';
import { colorizePaint, strokeColorOf } from './colorize.js';
import { transformAnchors, signedArea, fitCurve } from '../../model/bezier.js';
import { artBounds } from './brush-model.js';

// ---- shared helpers ----

/** Deterministic random numbers (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pressure along the path (0..1) from node.brushPressure [[t, p]]; 0.5 without data. */
export function pressureFunction(samples) {
  if (!Array.isArray(samples) || !samples.length) return () => 0.5;
  return (t) => {
    if (t <= samples[0][0]) return samples[0][1];
    for (let i = 1; i < samples.length; i++) {
      const [t1, p1] = samples[i];
      if (t <= t1) {
        const [t0, p0] = samples[i - 1];
        return p0 + ((p1 - p0) * (t - t0)) / Math.max(1e-9, t1 - t0);
      }
    }
    return samples[samples.length - 1][1];
  };
}

/**
 * A Variable { mode, value, variation } at a stroke's random draw `u`
 * (0..1), pressure p and drawing speed v (0..1, slow to fast; 0.5 without
 * data). Pressure and velocity modes go from value - variation (light,
 * slow) to value + variation (hard, fast).
 */
export function variableValue(param, u, p, v = 0.5) {
  if (param == null) return 0;
  if (typeof param === 'number') return param;
  const { mode = 'fixed', value = 0, variation = 0 } = param;
  if (mode === 'random') return value + variation * (2 * u - 1);
  if (mode === 'pressure') return value + variation * (2 * p - 1);
  if (mode === 'velocity') return value + variation * (2 * v - 1);
  return value;
}

/** A Range { mode, min, max } for a draw u, pressure p and speed v. */
export function rangeValue(param, u, p, v = 0.5) {
  if (param == null) return 0;
  if (typeof param === 'number') return param;
  const { mode = 'fixed', min = 0, max = min } = param;
  if (mode === 'random') return min + (max - min) * u;
  if (mode === 'pressure') return min + (max - min) * p;
  if (mode === 'velocity') return min + (max - min) * v;
  return min;
}

const STYLE_KEYS = ['strokeWidth', 'strokeCap', 'strokeJoin', 'miterLimit', 'fillRule', 'opacity'];

/** Art items as shapes, with their anchors mapped by `map(anchors, closed)` and paints colorized. */
function mapArt(art, map, { colorize, strokeColor, widthScale = 1, opacity = 1 }) {
  const out = [];
  const method = colorize?.method || 'none';
  for (const it of art.items) {
    const subpaths = it.subpaths.map((s) => ({ anchors: map(s.anchors, s.closed), closed: s.closed })).filter((s) => s.anchors.length);
    if (!subpaths.length) continue;
    const shape = { subpaths, fill: colorizePaint(it.fill || null, method, strokeColor, colorize?.key), stroke: colorizePaint(it.stroke || null, method, strokeColor, colorize?.key) };
    for (const k of STYLE_KEYS) if (it[k] !== undefined) shape[k] = it[k];
    if (shape.strokeWidth) shape.strokeWidth *= widthScale;
    if (opacity !== 1) shape.opacity = (shape.opacity ?? 1) * opacity;
    out.push(shape);
  }
  return out;
}

/** Art turned so it runs along +x (the brush's direction), with its bounds. */
const orientedCache = new WeakMap();
export function orientedArt(art, direction = 'right') {
  if (!art) return null;
  let byDir = orientedCache.get(art);
  if (!byDir) orientedCache.set(art, (byDir = {}));
  if (byDir[direction]) return byDir[direction];
  const m = { right: [1, 0, 0, 1, 0, 0], left: [-1, 0, 0, -1, 0, 0], down: [0, -1, 1, 0, 0, 0], up: [0, 1, -1, 0, 0, 0] }[direction] || [1, 0, 0, 1, 0, 0];
  const items = art.items.map((it) => ({ ...it, subpaths: it.subpaths.map((s) => ({ anchors: transformAnchors(s.anchors, m), closed: s.closed })) }));
  const res = { items, bounds: artBounds(items) };
  byDir[direction] = res;
  return res;
}

/** The subpaths a stroke follows: the path's outline (open paths trimmed for arrowheads by the caller). */
function spinesOf(subpaths) {
  return subpaths.filter((s) => s.anchors.length > 1).map((s) => ({ ...s, spine: buildSpine(s.anchors, s.closed) })).filter((s) => s.spine.length > 1e-6);
}

function ringsToShape(rings, paint, extra = {}) {
  const subpaths = rings.map((r) => ({ anchors: fitRing(r.pts, 0.04), closed: true })).filter((s) => s.anchors.length > 2);
  if (!subpaths.length) return null;
  return { subpaths, fill: paint, stroke: null, fillRule: 'nonzero', ...extra };
}

/**
 * Dash ranges [a, b] along a spine of length L for a dash array (in the
 * same units), starting `offset` into the pattern.
 */
export function dashRanges(L, dash, offset = 0) {
  const pat = dash.length % 2 ? [...dash, ...dash] : dash;
  const total = pat.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return [[0, L]];
  const out = [];
  let s = -(((offset % total) + total) % total);
  let i = 0;
  while (s < L && out.length < 10000) {
    const len = pat[i % pat.length];
    if (i % 2 === 0) {
      const a = Math.max(0, s);
      const b = Math.min(L, s + len);
      if (b > a + 1e-9) out.push([a, b]);
    }
    s += len;
    i++;
  }
  return out;
}

// ---- variable width ----

/**
 * The outline of a variable-width stroke. `subpaths` is the path's
 * outline; opts carries the stroke settings and the width profile.
 */
export function variableWidthShapes(subpaths, style, { arrows = [], dash = null } = {}) {
  const half = (style.strokeWidth || 0) / 2;
  if (!(half > 0) || !style.stroke) return [];
  const fn = profileFunction(style.widthProfile);
  const maxW = half * profileMax(style.widthProfile);
  const rings = [];
  for (const sp of spinesOf(subpaths)) {
    const L = sp.spine.length;
    let inner = 'none';
    if (sp.closed && style.strokeAlign && style.strokeAlign !== 'center') {
      // Which side faces the inside of a closed shape (positive area: clockwise, the right side).
      const cw = signedArea(sp.anchors, true) > 0;
      inner = style.strokeAlign === 'inside' ? (cw ? 'r' : 'l') : cw ? 'l' : 'r';
    }
    const offset = (side, s, nx, ny) => {
      const w = fn(s / L);
      let d = side === 'l' ? w.l : w.r;
      if (inner !== 'none') d = side === inner ? 0 : w.l + w.r;
      return { x: nx * d * half, y: ny * d * half };
    };
    const opts = { offset, cap: style.strokeCap || 'butt', join: style.strokeJoin || 'miter', miterLimit: style.miterLimit || 10, maxWidth: maxW * 2 };
    const ranges = dash && dash.length ? dashRanges(L, dash, style.dashOffset || 0) : [null];
    for (const range of ranges) rings.push(...sweepOutline(sp.spine, { ...opts, range }));
  }
  const out = [];
  const shape = ringsToShape(rings, style.stroke);
  if (shape) out.push(shape);
  if (arrows.length) out.push({ subpaths: arrows.map((a) => ({ anchors: a.anchors, closed: a.closed })), fill: style.stroke, stroke: null, fillRule: 'nonzero' });
  return out;
}

// ---- calligraphic ----

export function calligraphicShapes(subpaths, style, brush, { seed = 1, pressure = null } = {}) {
  const sw = style.strokeWidth || 1;
  const paint = style.stroke;
  if (!paint) return [];
  const rand = rng(seed);
  const ua = rand();
  const ur = rand();
  const us = rand();
  const pf = pressureFunction(pressure);
  const vf = pressureFunction(brush.velocity);
  const prof = profileFunction(style.widthProfile);
  const rings = [];
  for (const sp of spinesOf(subpaths)) {
    const L = sp.spine.length;
    const nib = (s) => {
      const p = pf(s / L);
      const v = vf(s / L);
      const size = Math.max(0, variableValue(brush.size, us, p, v)) * sw;
      const round = Math.min(100, Math.max(0, variableValue(brush.roundness, ur, p, v))) / 100;
      const angle = (variableValue(brush.angle, ua, p, v) * Math.PI) / 180;
      return { a: size / 2, b: Math.max(1e-4, (size / 2) * round), ux: Math.cos(angle), uy: -Math.sin(angle) };
    };
    const offset = (side, s, nx, ny) => {
      const { a, b, ux, uy } = nib(s);
      const w = prof(s / L);
      const k = side === 'l' ? w.l : w.r;
      // Support point of the rotated ellipse in direction n.
      const nu = nx * ux + ny * uy;
      const nv = -nx * uy + ny * ux;
      const den = Math.sqrt(a * a * nu * nu + b * b * nv * nv) || 1;
      const X = (a * a * nu) / den;
      const Y = (b * b * nv) / den;
      return { x: (X * ux - Y * uy) * k, y: (X * uy + Y * ux) * k };
    };
    const maxSize = Math.max(variableValue(brush.size, us, 1, 1), variableValue(brush.size, us, 0, 0), 0.1) * sw * profileMax(style.widthProfile);
    rings.push(...sweepOutline(sp.spine, { offset, cap: 'round', join: 'round', maxWidth: maxSize }));
  }
  const shape = ringsToShape(rings, paint);
  return shape ? [shape] : [];
}

// ---- art ----

export function artBrushShapes(subpaths, style, brush, { seed = 1, pressure = null } = {}) {
  const art = orientedArt(brush.art, brush.direction);
  if (!art) return [];
  const B = art.bounds;
  const W = Math.max(B.w, 1e-6);
  const cy = B.y + B.h / 2;
  const sw = style.strokeWidth || 1;
  const rand = rng(seed);
  const uw = rand();
  const pf = pressureFunction(pressure);
  const vf = pressureFunction(brush.velocity);
  const prof = profileFunction(style.widthProfile);
  const strokeColor = strokeColorOf(style.stroke);
  const out = [];
  for (const sp of spinesOf(subpaths)) {
    const L = sp.spine.length;
    const at = spineSampler(sp.spine).at;
    const widthAt = (s) => (Math.max(0, variableValue(brush.width, uw, pf(s / L), vf(s / L))) / 100) * sw;
    const prop = brush.scaling === 'proportional' ? L / W : 1;
    // Arc length for an art position u (0..W): stretched, or with fixed ends between guides.
    let sOf = (u) => ((u - B.x) / W) * L;
    if (brush.scaling === 'guides') {
      const g0 = Math.min(brush.guides?.start ?? 0.25, brush.guides?.end ?? 0.75) * W;
      const g1 = Math.max(brush.guides?.start ?? 0.25, brush.guides?.end ?? 0.75) * W;
      const k = widthAt(0);
      const fixed = (g0 + (W - g1)) * k;
      if (fixed >= L || g1 - g0 < 1e-6) sOf = (u) => ((u - B.x) / W) * L;
      else {
        const mid = L - fixed;
        sOf = (u) => {
          const x = u - B.x;
          if (x <= g0) return x * k;
          if (x >= g1) return L - (W - x) * k;
          return g0 * k + ((x - g0) / (g1 - g0)) * mid;
        };
      }
    }
    const flipU = brush.flipAlong;
    const flipV = brush.flipAcross;
    const adjust = brush.overlap === 'adjust';
    const f = (x, y) => {
      let u = flipU ? B.x + B.w - (x - B.x) : x;
      let v = cy - y;
      if (flipV) v = -v;
      const s = sOf(u);
      const p = at(s);
      const w = prof(Math.min(1, Math.max(0, s / L)));
      let d = v * widthAt(Math.min(L, Math.max(0, s))) * prop * (v >= 0 ? w.l : w.r);
      if (adjust) d = limitByCurvature(at, s, d);
      return { x: p.x + p.ty * d, y: p.y - p.tx * d };
    };
    const step = Math.max(W / 160, (W / Math.max(L, 1e-6)) * 3);
    out.push(...mapArt(art, (anchors, closed) => warpAnchors(anchors, closed, f, step), { colorize: brush.colorize, strokeColor, widthScale: widthAt(L / 2) * prop }));
  }
  return out;
}

/** Keep an offset inside the radius of curvature on the inner side of bends (no folds). */
function limitByCurvature(at, s, d) {
  const h = 0.5;
  const a = at(s - h);
  const b = at(s + h);
  const turn = (a.tx * b.ty - a.ty * b.tx) / (2 * h); // signed curvature
  if (Math.abs(turn) < 1e-6) return d;
  const radius = 1 / Math.abs(turn);
  // Turning right (turn > 0) puts the right side (d < 0) inside.
  const inner = turn > 0 ? d < 0 : d > 0;
  if (!inner) return d;
  return Math.sign(d) * Math.min(Math.abs(d), radius * 0.95);
}

// ---- scatter ----

export function scatterShapes(subpaths, style, brush, { seed = 1, pressure = null } = {}) {
  const art = brush.art;
  if (!art) return [];
  const B = art.bounds;
  const cx = B.x + B.w / 2;
  const cy = B.y + B.h / 2;
  const D = Math.max(B.w, B.h, 1e-3);
  const sw = style.strokeWidth || 1;
  const rand = rng(seed);
  const pf = pressureFunction(pressure);
  const vf = pressureFunction(brush.velocity);
  const strokeColor = strokeColorOf(style.stroke);
  const out = [];
  for (const sp of spinesOf(subpaths)) {
    const L = sp.spine.length;
    const at = spineSampler(sp.spine).at;
    let s = 0;
    let guard = 0;
    const placements = [];
    while (s <= L + 1e-6 && guard++ < 4000) {
      const p = pf(s / L);
      const v = vf(s / L);
      const size = Math.max(0.01, rangeValue(brush.size, rand(), p, v) / 100) * sw;
      const spacing = Math.max(0.02, rangeValue(brush.spacing, rand(), p, v) / 100) * D * size;
      const scatter = (rangeValue(brush.scatter, rand(), p, v) / 100) * D * size;
      const rot = rangeValue(brush.rotation, rand(), p, v);
      placements.push({ s, size, scatter, rot });
      s += spacing;
      if (sp.closed && s > L - spacing * 0.5) break;
    }
    for (const pl of placements) {
      const q = at(pl.s);
      const x = q.x + q.ty * pl.scatter;
      const y = q.y - q.tx * pl.scatter;
      // Rotation is counterclockwise on screen; relative to the path it adds the path's direction.
      let ang = (-pl.rot * Math.PI) / 180;
      if (brush.rotateRelative === 'path') ang += Math.atan2(q.ty, q.tx);
      const c = Math.cos(ang) * pl.size;
      const sn = Math.sin(ang) * pl.size;
      const m = [c, sn, -sn, c, x - c * cx + sn * cy, y - sn * cx - c * cy];
      out.push(...mapArt(art, (anchors) => transformAnchors(anchors, m), { colorize: brush.colorize, strokeColor, widthScale: pl.size }));
    }
  }
  return out;
}

// ---- pattern ----

function tileArt(tile) {
  return tile && typeof tile === 'object' && tile.items?.length ? tile : null;
}

/**
 * Pattern brush: side tiles repeat along the path, fitted between corners
 * and the start and end tiles; corner tiles sit on corners (outer where
 * the path turns right, inner where it turns left). 'auto' corners let
 * the side tiles run on around the corner.
 */
export function patternShapes(subpaths, style, brush, { seed = 1, pressure = null } = {}) {
  const tiles = brush.tiles || {};
  const side = tileArt(tiles.side);
  if (!side) return [];
  const sw = style.strokeWidth || 1;
  const rand = rng(seed);
  const us = rand();
  const pf = pressureFunction(pressure);
  const prof = profileFunction(style.widthProfile);
  const strokeColor = strokeColorOf(style.stroke);
  const colorOpts = { colorize: brush.colorize, strokeColor };
  const out = [];
  const flipU = Boolean(brush.flipAlong);
  const flipV = Boolean(brush.flipAcross);
  const spacing = Math.max(0, brush.spacing || 0) / 100;

  for (const sp of spinesOf(subpaths)) {
    const L = sp.spine.length;
    const at = spineSampler(sp.spine).at;
    const k = (Math.max(1, variableValue(brush.scale, us, pf(0.5), pressureFunction(brush.velocity)(0.5))) / 100) * sw;
    const H = side.bounds.h * k;
    // Corners that get their own tile (or none): they split the sides.
    const corners = [];
    for (const c of sp.spine.corners) {
      const outer = c.turn > 0 !== flipV;
      const t = outer ? tiles.outer : tiles.inner;
      if (t === 'auto') continue;
      corners.push({ ...c, tile: tileArt(t), reach: tileArt(t) ? H / 2 : 0 });
    }
    const startT = !sp.closed && tileArt(flipU ? tiles.end : tiles.start);
    const endT = !sp.closed && tileArt(flipU ? tiles.start : tiles.end);
    const startLen = startT ? startT.bounds.w * k : 0;
    const endLen = endT ? endT.bounds.w * k : 0;

    // Bend a tile over [s0, s1] of the path.
    const bend = (art, s0, s1) => {
      const B = art.bounds;
      const W = Math.max(B.w, 1e-6);
      const cy = B.y + B.h / 2;
      const f = (x, y) => {
        let u = (x - B.x) / W;
        if (flipU) u = 1 - u;
        let v = cy - y;
        if (flipV) v = -v;
        const s = s0 + u * (s1 - s0);
        const p = at(s);
        const w = prof(Math.min(1, Math.max(0, (((s % L) + L) % L) / L)));
        const d = v * k * (v >= 0 ? w.l : w.r);
        return { x: p.x + p.ty * d, y: p.y - p.tx * d };
      };
      const step = Math.max(W / 64, (W / Math.max(1e-6, s1 - s0)) * 3);
      out.push(...mapArt(art, (anchors, closed) => warpAnchors(anchors, closed, f, step), { ...colorOpts, widthScale: k }));
    };

    // Sections between corners / ends.
    const sections = [];
    if (sp.closed) {
      if (!corners.length) sections.push([0, L]);
      else {
        for (let i = 0; i < corners.length; i++) {
          const a = corners[i];
          const b = corners[(i + 1) % corners.length];
          const s0 = a.s + a.reach;
          let s1 = b.s - b.reach;
          if (s1 <= a.s) s1 += L;
          sections.push([s0, s1]);
        }
      }
    } else {
      const cuts = [{ s: 0, reach: startLen }, ...corners, { s: L, reach: endLen }];
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i];
        const b = cuts[i + 1];
        sections.push([a.s + a.reach, b.s - b.reach]);
      }
    }
    const T = side.bounds.w * k;
    const gap = T * spacing;
    for (const [a, b] of sections) {
      const len = b - a;
      if (len <= 1e-6) continue;
      if (brush.fit === 'space') {
        const n = Math.max(1, Math.floor((len + gap) / (T + gap)));
        const step = len / n;
        for (let i = 0; i < n; i++) {
          const s0 = a + i * step + (step - T) / 2;
          bend(side, s0, s0 + Math.min(T, step));
        }
      } else if (brush.fit === 'approximate') {
        const n = Math.max(1, Math.round((len + gap) / (T + gap)));
        const step = len / n;
        for (let i = 0; i < n; i++) {
          const s0 = a + i * step + (step - T) / 2;
          bend(side, s0, s0 + T);
        }
      } else {
        const n = Math.max(1, Math.round((len + gap) / (T + gap)));
        const step = len / n;
        const tileLen = (step * T) / (T + gap);
        for (let i = 0; i < n; i++) {
          const s0 = a + i * step + (step - tileLen) / 2;
          bend(side, s0, s0 + tileLen);
        }
      }
    }
    if (startT) bend(startT, 0, startLen);
    if (endT) bend(endT, L - endLen, L);
    // Corner tiles: square tiles centered on the corner, turned to the corner's bisector.
    for (const c of corners) {
      if (!c.tile) continue;
      const B = c.tile.bounds;
      const aIn = Math.atan2(c.tin.y, c.tin.x);
      let aOut = Math.atan2(c.tout.y, c.tout.x);
      while (aOut - aIn > Math.PI) aOut -= 2 * Math.PI;
      while (aOut - aIn < -Math.PI) aOut += 2 * Math.PI;
      const ang = (aIn + aOut) / 2 - (c.turn > 0 ? Math.PI / 4 : -Math.PI / 4);
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      const sx = (flipU ? -1 : 1) * k;
      const sy = (flipV ? -1 : 1) * k;
      const bx = B.x + B.w / 2;
      const by = B.y + B.h / 2;
      // translate(corner) * rotate(ang) * scale(sx, sy) * translate(-center)
      const m = [cs * sx, sn * sx, -sn * sy, cs * sy, c.x - cs * sx * bx + sn * sy * by, c.y - sn * sx * bx - cs * sy * by];
      out.push(...mapArt(c.tile, (anchors) => transformAnchors(anchors, m), { ...colorOpts, widthScale: k }));
    }
  }
  return out;
}

// ---- bristle ----

const BRISTLE_TIPS = {
  roundPoint: { flat: false, taper: (y) => y * y, fan: 1 },
  roundBlunt: { flat: false, taper: (y) => 0.15 * y, fan: 1 },
  roundCurve: { flat: false, taper: (y) => Math.abs(y), fan: 1 },
  roundAngle: { flat: false, taper: (y, signed) => (signed + 1) / 2, fan: 1 },
  flatPoint: { flat: true, taper: (y) => y * y, fan: 1 },
  flatBlunt: { flat: true, taper: (y) => 0.1 * y, fan: 1 },
  flatCurve: { flat: true, taper: (y) => Math.abs(y), fan: 1 },
  flatAngle: { flat: true, taper: (y, signed) => (signed + 1) / 2, fan: 1 },
  fan: { flat: true, taper: (y) => 0.4 * (1 - y), fan: 1.7 },
};

/** Low-frequency wobble along the path for a bristle (smooth noise from a few sines). */
function wobble(rand) {
  const parts = [0, 1, 2].map((i) => ({ f: (0.02 + rand() * 0.05) * (i + 1), ph: rand() * Math.PI * 2, a: 1 / (i + 1) }));
  return (s) => parts.reduce((acc, p) => acc + p.a * Math.sin(s * p.f + p.ph), 0) / 1.83;
}

/**
 * Whether a stroke paints over itself: two points of the spine more than
 * `gap` apart along it come within `reach` of each other.
 */
export function spineOverlaps(at, L, reach, gap) {
  const step = Math.max(reach / 2, L / 600);
  const cell = Math.max(reach, 1e-3);
  const grid = new Map();
  for (let s = 0; s <= L; s += step) {
    const p = at(s);
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of grid.get(`${cx + dx},${cy + dy}`) || []) {
          if (s - q.s > gap && Math.hypot(p.x - q.x, p.y - q.y) < reach) return true;
        }
      }
    }
    const k = `${cx},${cy}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ x: p.x, y: p.y, s });
  }
  return false;
}

/**
 * Bristle brush: many thin, semi-transparent strokes following the path,
 * spread across the brush width (wider or narrower with the stroke's
 * direction for flat brushes), each with its own taper at the ends and a
 * gentle wobble that grows as the bristles get softer. Paint builds up
 * like real paint: where a stroke crosses itself its bristles are laid
 * down in pieces, so the second pass darkens the first, and with pen
 * pressure harder parts of the stroke carry more paint.
 */
export function bristleShapes(subpaths, style, brush, { seed = 1, pressure = null } = {}) {
  const paint = style.stroke;
  if (!paint) return [];
  const sw = style.strokeWidth || 1;
  const tip = BRISTLE_TIPS[brush.shape] || BRISTLE_TIPS.roundPoint;
  const rand = rng(seed);
  const pf = pressureFunction(pressure);
  const hasPressure = Array.isArray(pressure) && pressure.length > 0;
  const prof = profileFunction(style.widthProfile);
  const count = Math.round(6 + (Math.min(100, Math.max(1, brush.density ?? 40)) / 100) * 54);
  const size = Math.max(0.1, brush.size ?? 3) * sw;
  const halfBase = (size / 2) * tip.fan;
  const thickness = Math.max(0.12, ((brush.thickness ?? 50) / 100) * (size / Math.sqrt(count)) * 1.4);
  const soft = 1 - Math.min(100, Math.max(1, brush.stiffness ?? 50)) / 100;
  const opacity = Math.min(1, Math.max(0.01, (brush.opacity ?? 75) / 100));
  const taperLen = size * ((brush.length ?? 100) / 100) * 1.6;
  const out = [];
  for (const sp of spinesOf(subpaths)) {
    const L = sp.spine.length;
    const at = spineSampler(sp.spine).at;
    const halfAt = (s, nx, ny) => {
      let h = halfBase;
      if (tip.flat) {
        // A flat brush held at 45 degrees is wide across some directions and thin across others.
        const a = halfBase;
        const b = halfBase * 0.3;
        const ux = Math.SQRT1_2;
        const uy = -Math.SQRT1_2;
        const nu = nx * ux + ny * uy;
        const nv = -nx * uy + ny * ux;
        h = Math.sqrt(a * a * nu * nu + b * b * nv * nv);
      }
      if (hasPressure) h *= 0.4 + 1.2 * pf(s / L);
      const w = prof(s / L);
      return h * (w.l + w.r) * 0.5;
    };
    const step = Math.max(1, Math.min(4, L / 120));
    const reach = Math.min(L / 2, taperLen);
    // A stroke over itself is laid down in pieces (at most 40 per bristle) so its passes build up.
    const pieceLen = !sp.closed && spineOverlaps(at, L, halfBase * 2, halfBase * 4) ? Math.max(halfBase * 4, L / 40) : Infinity;
    for (let i = 0; i < count; i++) {
      const signed = count === 1 ? 0 : -1 + (2 * (i + 0.5)) / count + (rand() - 0.5) * (1.6 / count);
      const y = Math.min(1, Math.abs(signed));
      const lat = tip.flat ? signed : Math.sin((signed * Math.PI) / 2);
      const t0 = sp.closed ? 0 : Math.min(L * 0.45, reach * tip.taper(y, signed) + rand() * reach * 0.15);
      const t1 = sp.closed ? L : Math.max(L * 0.55, L - reach * tip.taper(y, -signed) - rand() * reach * 0.15);
      if (t1 - t0 < 0.5) continue;
      const wob = wobble(rand);
      const amp = soft * halfBase * 0.35;
      const pts = [];
      const n = Math.max(2, Math.ceil((t1 - t0) / step));
      for (let k = 0; k <= n; k++) {
        const s = t0 + ((t1 - t0) * k) / n;
        const p = at(s);
        const nx = p.ty;
        const ny = -p.tx;
        const d = lat * halfAt(s, nx, ny) + amp * wob(s);
        pts.push({ x: p.x + nx * d, y: p.y + ny * d });
      }
      const alpha = opacity * (0.45 + rand() * 0.45);
      const width = thickness * (0.7 + rand() * 0.6);
      // Pieces of the bristle (one unless the stroke crosses itself), each with the paint pressure gives it.
      const pieces = [];
      if (pieceLen === Infinity) pieces.push({ pts, mid: 0.5 * (t0 + t1) });
      else {
        const per = Math.max(2, Math.round((pieceLen / (t1 - t0)) * n));
        for (let a = 0; a < pts.length - 1; a += per) {
          const b = Math.min(pts.length - 1, a + per);
          pieces.push({ pts: pts.slice(a, b + 1), mid: t0 + ((t1 - t0) * (a + b)) / (2 * n) });
        }
      }
      for (const pc of pieces) {
        const a = Math.min(1, alpha * (hasPressure ? 0.55 + 0.9 * pf(pc.mid / L) : 1));
        const stroke = paint.type === 'solid' ? { ...paint, opacity: (paint.opacity ?? 1) * a } : paint;
        out.push({
          subpaths: [{ anchors: fitCurve(pc.pts, 0.05), closed: false }],
          fill: null,
          stroke,
          strokeWidth: width,
          // Pieces meet end to end: butt ends keep the joins from doubling up.
          strokeCap: pieces.length > 1 ? 'butt' : 'round',
          strokeJoin: 'round',
          ...(paint.type === 'solid' ? {} : { opacity: a }),
        });
      }
    }
  }
  return out;
}

/** Brush artwork for a path: shapes in paint order. */
export function brushShapes(subpaths, style, brush, opts = {}) {
  switch (brush?.type) {
    case 'calligraphic':
      return calligraphicShapes(subpaths, style, brush, opts);
    case 'art':
      return artBrushShapes(subpaths, style, brush, opts);
    case 'scatter':
      return scatterShapes(subpaths, style, brush, opts);
    case 'pattern':
      return patternShapes(subpaths, style, brush, opts);
    case 'bristle':
      return bristleShapes(subpaths, style, brush, opts);
    default:
      return [];
  }
}

