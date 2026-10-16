// Line style application: geometry modifiers on the 2D strokes, then colour, alpha and thickness
// (base values and modifiers blended in list order), dashes and caps.
import { readRamp, evalRamp, readCurve, evalCurve } from '../../nodes/curves';
import type { LineStyleData, LineStyleModifier } from '../types';
import { arcLengths, dashes, lerpSV, slice, strokeLength, type Stroke2D, type SV } from './chain';
import { fbm1, fbm2, hash, noise1, rng } from './noise';

export interface StyledStroke {
  x: Float32Array;
  y: Float32Array;
  /** linear RGB + alpha per vertex */
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
  /** thickness on the (-dy, dx) side and on the other side (pixels) */
  tl: Float32Array;
  tr: Float32Array;
  caps: 'BUTT' | 'ROUND' | 'SQUARE';
}

export interface StyleContext {
  /** pixels per thickness unit (line thickness mode) */
  thicknessScale: number;
  /** world location of an object (Distance from Object) */
  objectLocation?: (id: string) => [number, number, number] | null;
  /** material attribute values by material key: rgba line colour, diffuse rgba, specular rgb + hardness, alpha */
  material?: (key: number) => MaterialAttrs | null;
  /** extra seed (e.g. the frame) for random effects */
  seed?: number;
}

export interface MaterialAttrs {
  line: [number, number, number, number];
  diffuse: [number, number, number, number];
  specular: [number, number, number];
  hardness: number;
  alpha: number;
}

type M = LineStyleModifier & Record<string, unknown>;
const n = (m: M, k: string, d = 0) => (typeof m[k] === 'number' ? (m[k] as number) : d);

// ---------------------------------------------------------------------------
// geometry modifiers (pixels)

function normalAt(pts: SV[], i: number): [number, number] {
  const a = pts[Math.max(0, i - 1)],
    b = pts[Math.min(pts.length - 1, i + 1)];
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  return [-dy / l, dx / l];
}

export function resample(pts: SV[], spacing: number): SV[] {
  if (pts.length < 2 || spacing <= 0) return pts;
  const arc = arcLengths(pts);
  const total = arc[arc.length - 1];
  if (total <= 0) return pts;
  const k = Math.max(1, Math.min(10000, Math.ceil(total / spacing)));
  const out: SV[] = [];
  let j = 1;
  for (let i = 0; i <= k; i++) {
    const s = (total * i) / k;
    while (j < arc.length - 1 && arc[j] < s) j++;
    const seg = arc[j] - arc[j - 1];
    out.push(lerpSV(pts[j - 1], pts[j], seg > 0 ? Math.max(0, Math.min(1, (s - arc[j - 1]) / seg)) : 0));
  }
  return out;
}

/** Douglas–Peucker simplification (pixel tolerance). */
export function simplify(pts: SV[], tol: number): SV[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a],
      B = pts[b];
    const dx = B.x - A.x,
      dy = B.y - A.y;
    const l = Math.hypot(dx, dy);
    let best = -1,
      bd = tol;
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      const d = l > 1e-9 ? Math.abs((P.x - A.x) * dy - (P.y - A.y) * dx) / l : Math.hypot(P.x - A.x, P.y - A.y);
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Smooth curve through points (Catmull–Rom), `per` samples per span. */
function catmull(pts: SV[], per: number): SV[] {
  if (pts.length < 3) return pts;
  const out: SV[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)],
      p1 = pts[i],
      p2 = pts[i + 1],
      p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per,
        t2 = t * t,
        t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      const v = lerpSV(p1, p2, t);
      v.x = f(p0.x, p1.x, p2.x, p3.x);
      v.y = f(p0.y, p1.y, p2.y, p3.y);
      out.push(v);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function geometryModifier(pts: SV[], m: M, seed: number, round: number): SV[] {
  if (pts.length < 2) return pts;
  switch (m.type) {
    case 'SAMPLING':
      return resample(pts, Math.max(0.1, n(m, 'sampling', 10)));
    case 'SIMPLIFICATION':
      return simplify(pts, Math.max(0, n(m, 'tolerance', 0.1)));
    case 'POLYGONIZATION':
      return simplify(pts, Math.max(0, n(m, 'error', 10)));
    case 'BEZIER_CURVE':
      return resample(catmull(simplify(pts, Math.max(0.5, n(m, 'error', 10))), 8), 2);
    case 'SINUS_DISPLACEMENT': {
      const arc = arcLengths(pts);
      const wl = Math.max(1e-3, n(m, 'wavelength', 20)),
        amp = n(m, 'amplitude', 5),
        ph = n(m, 'phase', 0);
      return pts.map((p, i) => {
        const [nx, ny] = normalAt(pts, i);
        const d = amp * Math.sin((2 * Math.PI * arc[i]) / wl + ph);
        return { ...p, x: p.x + nx * d, y: p.y + ny * d };
      });
    }
    case 'SPATIAL_NOISE': {
      const amp = n(m, 'amplitude', 5),
        sc = Math.max(1e-3, n(m, 'scale', 20)),
        oct = Math.round(n(m, 'octaves', 4));
      const s = m.use_pure_random !== false ? seed * 7919 + round * 104729 + Math.floor(hash(seed, pts.length, Math.round(pts[0].x)) * 1e6) : 12345;
      let out = pts.map((p, i) => {
        const [nx, ny] = normalAt(pts, i);
        const d = 2 * amp * fbm2(s, p.x / sc, p.y / sc, oct);
        return { ...p, x: p.x + nx * d, y: p.y + ny * d };
      });
      if (m.smooth !== false) out = out.map((p, i) => (i === 0 || i === out.length - 1 ? p : { ...p, x: (out[i - 1].x + p.x * 2 + out[i + 1].x) / 4, y: (out[i - 1].y + p.y * 2 + out[i + 1].y) / 4 }));
      return out;
    }
    case 'PERLIN_NOISE_1D':
    case 'PERLIN_NOISE_2D': {
      const freq = Math.max(1e-3, n(m, 'frequency', 10)),
        amp = n(m, 'amplitude', 10),
        oct = Math.round(n(m, 'octaves', 4)),
        ang = n(m, 'angle', Math.PI / 4),
        sd = Math.round(n(m, 'seed', 0)) + round * 977;
      const dx = Math.cos(ang),
        dy = -Math.sin(ang);
      const arc = arcLengths(pts);
      return pts.map((p, i) => {
        // fractal sums rarely reach ±1: scale so the amplitude is about the largest offset
        const v = 2 * (m.type === 'PERLIN_NOISE_1D' ? fbm1(sd, arc[i] / freq, oct) : fbm2(sd, p.x / freq, p.y / freq, oct));
        return { ...p, x: p.x + dx * amp * v, y: p.y + dy * amp * v };
      });
    }
    case 'BACKBONE_STRETCHER': {
      const L = n(m, 'backbone_length', 10);
      const ext = (a: SV, b: SV): SV => {
        const dx = a.x - b.x,
          dy = a.y - b.y;
        const l = Math.hypot(dx, dy) || 1;
        return { ...a, x: a.x + (dx / l) * L, y: a.y + (dy / l) * L };
      };
      return [ext(pts[0], pts[1]), ...pts, ext(pts[pts.length - 1], pts[pts.length - 2])];
    }
    case 'TIP_REMOVER': {
      const L = n(m, 'tip_length', 10);
      const arc = arcLengths(pts);
      const total = arc[arc.length - 1];
      if (total <= 2 * L) return [];
      return slice(pts, L, total - L, arc);
    }
    case 'GUIDING_LINES': {
      const a = pts[0],
        b = pts[pts.length - 1];
      const off = n(m, 'offset', 0);
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l,
        ny = dx / l;
      const arc = arcLengths(pts);
      const total = arc[arc.length - 1] || 1;
      return pts.map((p, i) => {
        const t = arc[i] / total;
        return { ...p, x: a.x + dx * t + nx * off, y: a.y + dy * t + ny * off };
      });
    }
    case '2D_OFFSET': {
      const arc = arcLengths(pts);
      const total = arc[arc.length - 1] || 1;
      const s0 = n(m, 'start'),
        s1 = n(m, 'end'),
        ox = n(m, 'x'),
        oy = n(m, 'y');
      return pts.map((p, i) => {
        const [nx, ny] = normalAt(pts, i);
        const d = s0 + (s1 - s0) * (arc[i] / total);
        // y up in the style's 2D space
        return { ...p, x: p.x + nx * d + ox, y: p.y + ny * d - oy };
      });
    }
    case '2D_TRANSFORM': {
      let px = 0,
        py = 0;
      const pivot = String(m.pivot ?? 'CENTER');
      if (pivot === 'START') [px, py] = [pts[0].x, pts[0].y];
      else if (pivot === 'END') [px, py] = [pts[pts.length - 1].x, pts[pts.length - 1].y];
      else if (pivot === 'PARAM') {
        const arc = arcLengths(pts);
        const s = slice(pts, 0, arc[arc.length - 1] * Math.max(0, Math.min(1, n(m, 'pivot_u', 0.5))), arc);
        [px, py] = [s[s.length - 1].x, s[s.length - 1].y];
      } else if (pivot === 'ABSOLUTE') [px, py] = [n(m, 'pivot_x'), n(m, 'pivot_y')];
      else {
        for (const p of pts) {
          px += p.x;
          py += p.y;
        }
        px /= pts.length;
        py /= pts.length;
      }
      const sx = n(m, 'scale_x', 1),
        sy = n(m, 'scale_y', 1),
        a = n(m, 'angle', 0);
      const c = Math.cos(a),
        s = Math.sin(a);
      return pts.map((p) => {
        const x = (p.x - px) * sx,
          y = -(p.y - py) * sy;
        return { ...p, x: px + x * c - y * s, y: py - (x * s + y * c) };
      });
    }
    case 'BLUEPRINT':
      return blueprint(pts, m, seed, round);
  }
  return pts;
}

/** Circles, ellipses or squares around the stroke, drawn `rounds` times with random jitter. */
function blueprint(pts: SV[], m: M, seed: number, round: number): SV[] {
  const R = rng(seed * 31 + round * 17 + pts.length);
  let minx = Infinity,
    miny = Infinity,
    maxx = -Infinity,
    maxy = -Infinity;
  for (const p of pts) {
    minx = Math.min(minx, p.x);
    miny = Math.min(miny, p.y);
    maxx = Math.max(maxx, p.x);
    maxy = Math.max(maxy, p.y);
  }
  const cx = (minx + maxx) / 2,
    cy = (miny + maxy) / 2;
  const shape = String(m.shape ?? 'CIRCLES');
  const rounds = Math.max(1, Math.round(n(m, 'rounds', 1)));
  const rr = n(m, 'random_radius', 3),
    rc = n(m, 'random_center', 5),
    rb = n(m, 'random_backbone', 5),
    bl = n(m, 'backbone_length', 10);
  const base = pts[0];
  const out: SV[] = [];
  const jitter = (r: number) => (R() * 2 - 1) * r;
  for (let k = 0; k < rounds; k++) {
    const ox = cx + jitter(rc),
      oy = cy + jitter(rc);
    if (shape === 'SQUARES') {
      const hx = (maxx - minx) / 2 + jitter(rr),
        hy = (maxy - miny) / 2 + jitter(rr);
      const ext = bl + jitter(rb);
      const corners = [
        [ox - hx - ext, oy - hy],
        [ox + hx, oy - hy],
        [ox + hx, oy - hy - ext],
        [ox + hx, oy + hy],
        [ox + hx + ext, oy + hy],
        [ox - hx, oy + hy],
        [ox - hx, oy + hy + ext],
        [ox - hx, oy - hy],
      ];
      for (const [x, y] of corners) out.push({ ...base, x, y });
    } else {
      const ry = shape === 'ELLIPSES' ? (maxy - miny) / 2 : Math.hypot(maxx - minx, maxy - miny) / 2;
      const rx = shape === 'ELLIPSES' ? (maxx - minx) / 2 : ry;
      const rad = Math.max(rx, ry, 1);
      const steps = Math.max(12, Math.min(256, Math.ceil((2 * Math.PI * rad) / 4)));
      const extra = (bl + jitter(rb)) / Math.max(1, rad);
      const a0 = R() * Math.PI * 2;
      for (let i = 0; i <= steps; i++) {
        const a = a0 + ((2 * Math.PI + extra) * i) / steps;
        out.push({ ...base, x: ox + Math.cos(a) * (rx + jitter(rr) * 0.1), y: oy + Math.sin(a) * (ry + jitter(rr) * 0.1) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// colour / alpha / thickness

function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function rgbToHsv(c: number[]): number[] {
  const mx = Math.max(c[0], c[1], c[2]),
    mn = Math.min(c[0], c[1], c[2]),
    d = mx - mn;
  let h = 0;
  if (d > 1e-9) h = mx === c[0] ? ((c[1] - c[2]) / d) % 6 : mx === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
  return [((h / 6) % 1 + 1) % 1, mx > 0 ? d / mx : 0, mx];
}
function hsvToRgb(h: number, s: number, v: number): number[] {
  const k = (q: number) => (q + h * 6) % 6;
  const f = (q: number) => v - v * s * Math.max(0, Math.min(k(q), 4 - k(q), 1));
  return [f(5), f(3), f(1)];
}

/** Blend colour `b` over `a` with a mode and factor (per channel, like the mix node). */
export function blendColor(mode: string, a: number[], b: number[], t: number): number[] {
  const mix = (x: number[]) => [0, 1, 2].map((i) => a[i] + (x[i] - a[i]) * t);
  switch (mode) {
    case 'ADD':
      return [0, 1, 2].map((i) => a[i] + b[i] * t);
    case 'SUBTRACT':
      return [0, 1, 2].map((i) => a[i] - b[i] * t);
    case 'MULTIPLY':
      return mix([0, 1, 2].map((i) => a[i] * b[i]));
    case 'DIVIDE':
      return mix([0, 1, 2].map((i) => (b[i] !== 0 ? a[i] / b[i] : a[i])));
    case 'DIFFERENCE':
      return mix([0, 1, 2].map((i) => Math.abs(a[i] - b[i])));
    case 'EXCLUSION':
      return mix([0, 1, 2].map((i) => a[i] + b[i] - 2 * a[i] * b[i]));
    case 'DARKEN':
      return mix([0, 1, 2].map((i) => Math.min(a[i], b[i])));
    case 'LIGHTEN':
      return mix([0, 1, 2].map((i) => Math.max(a[i], b[i])));
    case 'SCREEN':
      return mix([0, 1, 2].map((i) => 1 - (1 - a[i]) * (1 - b[i])));
    case 'OVERLAY':
      return mix([0, 1, 2].map((i) => (a[i] < 0.5 ? 2 * a[i] * b[i] : 1 - 2 * (1 - a[i]) * (1 - b[i]))));
    case 'SOFT_LIGHT':
      return mix([0, 1, 2].map((i) => (1 - 2 * b[i]) * a[i] * a[i] + 2 * b[i] * a[i]));
    case 'LINEAR_LIGHT':
      return mix([0, 1, 2].map((i) => a[i] + 2 * b[i] - 1));
    case 'BURN':
      return mix([0, 1, 2].map((i) => (b[i] > 0 ? Math.max(0, 1 - (1 - a[i]) / b[i]) : 0)));
    case 'DODGE':
      return mix([0, 1, 2].map((i) => (b[i] < 1 ? Math.min(1, a[i] / (1 - b[i])) : 1)));
    case 'HUE':
    case 'SATURATION':
    case 'COLOR':
    case 'VALUE': {
      const ha = rgbToHsv(a),
        hb = rgbToHsv(b);
      const r = mode === 'HUE' ? [hb[0], ha[1], ha[2]] : mode === 'SATURATION' ? [ha[0], hb[1], ha[2]] : mode === 'COLOR' ? [hb[0], hb[1], ha[2]] : [ha[0], ha[1], hb[2]];
      return mix(hsvToRgb(r[0], r[1], r[2]));
    }
    default:
      return mix(b);
  }
}

/** Blend a value with a mode and factor. */
export function blendValue(mode: string, a: number, b: number, t: number): number {
  switch (mode) {
    case 'ADD':
      return a + b * t;
    case 'SUBTRACT':
      return a - b * t;
    case 'MULTIPLY':
      return a * (1 - t) + a * b * t;
    case 'DIVIDE':
      return b !== 0 ? a * (1 - t) + (a / b) * t : a;
    case 'DIFFERENCE':
      return a * (1 - t) + Math.abs(a - b) * t;
    case 'MINIMUM':
      return a * (1 - t) + Math.min(a, b) * t;
    case 'MAXIMUM':
      return a * (1 - t) + Math.max(a, b) * t;
    default:
      return a * (1 - t) + b * t;
  }
}

interface Frame {
  pts: SV[];
  u: number[];
  arc: number[];
  total: number;
}

function luminance(c: number[]) {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Scalar read from a material for the Material modifiers. */
export function materialScalar(attr: string, ma: MaterialAttrs | null): number {
  if (!ma) return 0;
  switch (attr) {
    case 'LINE':
      return luminance(ma.line);
    case 'LINE_R':
      return ma.line[0];
    case 'LINE_G':
      return ma.line[1];
    case 'LINE_B':
      return ma.line[2];
    case 'LINE_A':
      return ma.line[3];
    case 'DIFF':
      return luminance(ma.diffuse);
    case 'DIFF_R':
      return ma.diffuse[0];
    case 'DIFF_G':
      return ma.diffuse[1];
    case 'DIFF_B':
      return ma.diffuse[2];
    case 'SPEC':
      return luminance(ma.specular);
    case 'SPEC_R':
      return ma.specular[0];
    case 'SPEC_G':
      return ma.specular[1];
    case 'SPEC_B':
      return ma.specular[2];
    case 'SPEC_HARD':
      return ma.hardness;
    case 'ALPHA':
      return ma.alpha;
  }
  return 0;
}

function materialColor(attr: string, ma: MaterialAttrs | null): number[] | null {
  if (!ma) return null;
  if (attr === 'LINE') return ma.line.slice(0, 3);
  if (attr === 'DIFF') return ma.diffuse.slice(0, 3);
  if (attr === 'SPEC') return [...ma.specular];
  return null;
}

/** The modifier's parameter (0..1, before mapping) at a vertex. */
function parameter(m: M, f: Frame, i: number, ctx: StyleContext): number {
  const p = f.pts[i];
  switch (m.type) {
    case 'ALONG_STROKE':
      return f.u[i];
    case 'DISTANCE_FROM_CAMERA': {
      const lo = n(m, 'range_min'),
        hi = n(m, 'range_max', 10000);
      return hi > lo ? clamp01((p.dist - lo) / (hi - lo)) : 0;
    }
    case 'DISTANCE_FROM_OBJECT': {
      const tgt = typeof m.target === 'string' ? ctx.objectLocation?.(m.target) : null;
      if (!tgt) return 0;
      const d = Math.hypot(p.p[0] - tgt[0], p.p[1] - tgt[1], p.p[2] - tgt[2]);
      const lo = n(m, 'range_min'),
        hi = n(m, 'range_max', 10000);
      return hi > lo ? clamp01((d - lo) / (hi - lo)) : 0;
    }
    case 'CREASE_ANGLE': {
      const lo = n(m, 'angle_min'),
        hi = n(m, 'angle_max', Math.PI);
      return hi > lo ? clamp01((p.angle - lo) / (hi - lo)) : 0;
    }
    case 'CURVATURE_3D': {
      const lo = n(m, 'curvature_min'),
        hi = n(m, 'curvature_max', 0.5);
      return hi > lo ? clamp01((p.curv - lo) / (hi - lo)) : 0;
    }
    case 'TANGENT': {
      const a = f.pts[Math.max(0, i - 1)],
        b = f.pts[Math.min(f.pts.length - 1, i + 1)];
      // direction angle folded to [0, π) and normalised
      let ang = Math.atan2(-(b.y - a.y), b.x - a.x);
      if (ang < 0) ang += Math.PI;
      return clamp01(ang / Math.PI);
    }
    case 'MATERIAL':
      return clamp01(materialScalar(String(m.material_attribute ?? 'LINE'), ctx.material?.(p.mat) ?? null));
    case 'NOISE': {
      const per = Math.max(1e-3, n(m, 'period', 10));
      return clamp01(0.5 + 0.5 * noise1(Math.round(n(m, 'seed', 512)), f.arc[i] / per));
    }
  }
  return 0;
}

function mapped(m: M, v: number): number {
  let x = v;
  if (m.mapping === 'CURVE') x = evalCurve(readCurve(m as never, 0), x);
  if (m.invert) x = 1 - x;
  return x;
}

/** Apply a line style to chained strokes. */
export function styleStrokes(strokes: Stroke2D[], ls: LineStyleData, ctx: StyleContext): StyledStroke[] {
  const seed = ctx.seed ?? 0;
  let list = strokes.map((s) => s.pts);
  // geometry
  list = list.map((pts, si) => {
    let out = pts;
    for (const m of ls.geometry_modifiers) if (m.use) out = geometryModifier(out, m as M, seed + si * 7, si);
    return out;
  });
  list = list.filter((p) => p.length >= 2 && strokeLength(p) > 0.01);
  if (ls.use_dashed_line) {
    const pat = [ls.dash1, ls.gap1, ls.dash2, ls.gap2, ls.dash3, ls.gap3];
    if (pat.some((x) => x > 0)) list = dashes(list.map((pts) => ({ pts, qi: 0, flags: 0 })), pat).map((s) => s.pts);
  }
  const out: StyledStroke[] = [];
  const scale = ctx.thicknessScale;
  for (const pts of list) {
    if (pts.length < 2) continue;
    const arc = arcLengths(pts);
    const total = arc[arc.length - 1] || 1;
    const f: Frame = { pts, arc, total, u: arc.map((s) => s / total) };
    const N = pts.length;
    const st: StyledStroke = { x: new Float32Array(N), y: new Float32Array(N), r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N), a: new Float32Array(N), tl: new Float32Array(N), tr: new Float32Array(N), caps: ls.caps };
    for (let i = 0; i < N; i++) {
      let col: number[] = [...ls.color];
      for (const m0 of ls.color_modifiers) {
        const m = m0 as M;
        if (!m.use) continue;
        let c: number[];
        if (m.type === 'MATERIAL' && !m.use_ramp) c = materialColor(String(m.material_attribute ?? 'LINE'), ctx.material?.(pts[i].mat) ?? null) ?? evalRamp(readRamp(m as never), parameter(m, f, i, ctx));
        else c = evalRamp(readRamp(m as never), parameter(m, f, i, ctx));
        col = blendColor(String(m.blend ?? 'MIX'), col, c, n(m, 'influence', 1));
      }
      let alpha = ls.alpha;
      for (const m0 of ls.alpha_modifiers) {
        const m = m0 as M;
        if (!m.use) continue;
        alpha = blendValue(String(m.blend ?? 'MIX'), alpha, mapped(m, parameter(m, f, i, ctx)), n(m, 'influence', 1));
      }
      let thick = ls.thickness;
      let extraL = 0,
        extraR = 0;
      for (const m0 of ls.thickness_modifiers) {
        const m = m0 as M;
        if (!m.use) continue;
        const inf = n(m, 'influence', 1);
        const mode = String(m.blend ?? 'MIX');
        if (m.type === 'NOISE') {
          const amp = n(m, 'amplitude', 10),
            per = Math.max(1e-3, n(m, 'period', 10)),
            sd = Math.round(n(m, 'seed', 512));
          if (m.use_asymmetric) {
            extraL += amp * 0.5 * (0.5 + 0.5 * noise1(sd, arc[i] / per)) * inf;
            extraR += amp * 0.5 * (0.5 + 0.5 * noise1(sd + 101, arc[i] / per)) * inf;
          } else thick = blendValue(mode, thick, amp * (0.5 + 0.5 * noise1(sd, arc[i] / per)), inf);
          continue;
        }
        if (m.type === 'CALLIGRAPHY') {
          const a = pts[Math.max(0, i - 1)],
            b = pts[Math.min(N - 1, i + 1)];
          const dir = Math.atan2(-(b.y - a.y), b.x - a.x);
          const k = Math.abs(Math.sin(dir - n(m, 'orientation', Math.PI / 3)));
          thick = blendValue(mode, thick, n(m, 'thickness_min', 1) + (n(m, 'thickness_max', 10) - n(m, 'thickness_min', 1)) * k, inf);
          continue;
        }
        const v = mapped(m, parameter(m, f, i, ctx));
        const lo = 'value_min' in m ? n(m, 'value_min') : n(m, 'thickness_min', 1),
          hi = 'value_max' in m ? n(m, 'value_max', 1) : n(m, 'thickness_max', 10);
        thick = blendValue(mode, thick, lo + (hi - lo) * v, inf);
      }
      thick = Math.max(0, thick) * scale;
      let tl: number, tr: number;
      const side = pts[i].side;
      switch (ls.thickness_position) {
        case 'INSIDE':
          [tl, tr] = side > 0 ? [thick, 0] : side < 0 ? [0, thick] : [thick / 2, thick / 2];
          break;
        case 'OUTSIDE':
          [tl, tr] = side > 0 ? [0, thick] : side < 0 ? [thick, 0] : [thick / 2, thick / 2];
          break;
        case 'RELATIVE': {
          const r = clamp01(ls.thickness_ratio);
          tl = thick * r;
          tr = thick * (1 - r);
          break;
        }
        default:
          tl = tr = thick / 2;
      }
      st.x[i] = pts[i].x;
      st.y[i] = pts[i].y;
      st.r[i] = col[0];
      st.g[i] = col[1];
      st.b[i] = col[2];
      st.a[i] = clamp01(alpha);
      st.tl[i] = Math.max(0, tl + extraL * scale);
      st.tr[i] = Math.max(0, tr + extraR * scale);
    }
    out.push(st);
  }
  return out;
}
