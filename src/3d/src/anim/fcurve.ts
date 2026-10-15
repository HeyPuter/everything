// F-Curve evaluation: Bézier segments solved in time, easing equations
// (Penner-style, independently implemented), handle recalculation and modifiers.
import type { FCurve, Keyframe, Vec2, FModifier } from '../data/types';

/** Defaults for new keyframes and curves (Preferences ▸ Animation sets these). */
export const keyframeDefaults = {
  interpolation: 'BEZIER' as Keyframe['interpolation'],
  handle: 'AUTO_CLAMPED' as Keyframe['handle_left_type'],
  /** skip keys that would not change the curve */
  insertNeeded: false,
  /** location / rotation / scale curves are coloured X red, Y green, Z blue */
  xyzToRgb: true,
};

export function newKeyframe(frame: number, value: number, interpolation: Keyframe['interpolation'] = keyframeDefaults.interpolation): Keyframe {
  return {
    co: [frame, value],
    handle_left: [frame - 1, value],
    handle_right: [frame + 1, value],
    handle_left_type: keyframeDefaults.handle,
    handle_right_type: keyframeDefaults.handle,
    interpolation,
    easing: 'AUTO',
    type: 'KEYFRAME',
  };
}

/** Recalculate automatic/vector handles. Keyframes must be sorted. */
export function calcHandles(fc: FCurve) {
  const k = fc.keyframe_points;
  const n = k.length;
  for (let i = 0; i < n; i++) {
    const cur = k[i],
      prev = k[i - 1],
      next = k[i + 1];
    const autoL = cur.handle_left_type === 'AUTO' || cur.handle_left_type === 'AUTO_CLAMPED',
      autoR = cur.handle_right_type === 'AUTO' || cur.handle_right_type === 'AUTO_CLAMPED';
    const [x, y] = cur.co;
    const dxPrev = prev ? x - prev.co[0] : next ? next.co[0] - x : 1,
      dxNext = next ? next.co[0] - x : prev ? x - prev.co[0] : 1;
    if (autoL || autoR) {
      let slope = 0;
      if (prev && next) {
        slope = (next.co[1] - prev.co[1]) / (next.co[0] - prev.co[0] || 1);
        const clamped = cur.handle_left_type === 'AUTO_CLAMPED' || cur.handle_right_type === 'AUTO_CLAMPED';
        if (clamped) {
          // extremes get flat handles
          if ((y >= prev.co[1] && y >= next.co[1]) || (y <= prev.co[1] && y <= next.co[1])) slope = 0;
        }
      } else slope = 0;
      if (autoL) cur.handle_left = [x - dxPrev / 3, y - (slope * dxPrev) / 3];
      if (autoR) cur.handle_right = [x + dxNext / 3, y + (slope * dxNext) / 3];
      // clamp handles so they do not overshoot neighbours in clamped mode
      if (cur.handle_left_type === 'AUTO_CLAMPED' && prev) cur.handle_left[1] = clampBetween(cur.handle_left[1], y, prev.co[1], y);
      if (cur.handle_right_type === 'AUTO_CLAMPED' && next) cur.handle_right[1] = clampBetween(cur.handle_right[1], y, next.co[1], y);
    }
    if (cur.handle_left_type === 'VECTOR') {
      const t = prev ? prev.co : [x - 1, y];
      cur.handle_left = [x + (t[0] - x) / 3, y + (t[1] - y) / 3];
    }
    if (cur.handle_right_type === 'VECTOR') {
      const t = next ? next.co : [x + 1, y];
      cur.handle_right = [x + (t[0] - x) / 3, y + (t[1] - y) / 3];
    }
    if (cur.handle_left_type === 'ALIGNED' && cur.handle_right_type !== 'ALIGNED') alignHandle(cur, 'left');
    if (cur.handle_right_type === 'ALIGNED' && cur.handle_left_type !== 'ALIGNED') alignHandle(cur, 'right');
  }
}

function clampBetween(v: number, base: number, other: number, ref: number) {
  const lo = Math.min(base, other, ref),
    hi = Math.max(base, other, ref);
  return Math.max(lo, Math.min(hi, v));
}

/** Keep the given handle collinear with the opposite one (preserving its length). */
export function alignHandle(k: Keyframe, which: 'left' | 'right') {
  const [x, y] = k.co;
  const src = which === 'left' ? k.handle_right : k.handle_left,
    dst = which === 'left' ? k.handle_left : k.handle_right;
  const dx = src[0] - x,
    dy = src[1] - y,
    l = Math.hypot(dx, dy) || 1,
    ld = Math.hypot(dst[0] - x, dst[1] - y);
  dst[0] = x - (dx / l) * ld;
  dst[1] = y - (dy / l) * ld;
}

export function sortKeyframes(fc: FCurve) {
  fc.keyframe_points.sort((a, b) => a.co[0] - b.co[0]);
}

// Solve cubic bezier x(t) = frame for t in [0,1]
function bezierT(x0: number, x1: number, x2: number, x3: number, x: number) {
  // Correct handles so the curve is monotonic in x
  const len = x3 - x0;
  if (len <= 0) return 0;
  let h1 = x1 - x0,
    h2 = x3 - x2;
  const sum = h1 + h2;
  if (sum > len) {
    const f = len / sum;
    h1 *= f;
    h2 *= f;
  }
  x1 = x0 + h1;
  x2 = x3 - h2;
  // Newton + bisection
  let lo = 0,
    hi = 1,
    t = (x - x0) / len;
  for (let i = 0; i < 24; i++) {
    const mt = 1 - t;
    const xt = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
    const err = xt - x;
    if (Math.abs(err) < 1e-7) break;
    if (err > 0) hi = t;
    else lo = t;
    const d = 3 * mt * mt * (x1 - x0) + 6 * mt * t * (x2 - x1) + 3 * t * t * (x3 - x2);
    let nt = d !== 0 ? t - err / d : (lo + hi) / 2;
    if (nt <= lo || nt >= hi) nt = (lo + hi) / 2;
    t = nt;
  }
  return { t, x1, x2 };
}

function bezierValue(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, frame: number) {
  const r = bezierT(p0[0], p1[0], p2[0], p3[0], frame);
  if (typeof r === 'number') return p0[1];
  // when x-handles were scaled down, scale y-handles proportionally
  const s1 = p1[0] - p0[0] !== 0 ? (r.x1 - p0[0]) / (p1[0] - p0[0]) : 1,
    s2 = p3[0] - p2[0] !== 0 ? (p3[0] - r.x2) / (p3[0] - p2[0]) : 1;
  const y1 = p0[1] + (p1[1] - p0[1]) * s1,
    y2 = p3[1] + (p2[1] - p3[1]) * s2;
  const t = r.t,
    mt = 1 - t;
  return mt * mt * mt * p0[1] + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * p3[1];
}

// Easing functions: t in [0,1] → [0,1]
const easeIn: Record<string, (t: number, k: Keyframe) => number> = {
  SINE: (t) => 1 - Math.cos((t * Math.PI) / 2),
  QUAD: (t) => t * t,
  CUBIC: (t) => t * t * t,
  QUART: (t) => t ** 4,
  QUINT: (t) => t ** 5,
  EXPO: (t) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1))),
  CIRC: (t) => 1 - Math.sqrt(1 - t * t),
  BACK: (t, k) => {
    const s = k.back ?? 1.70158;
    return t * t * ((s + 1) * t - s);
  },
  BOUNCE: (t) => 1 - bounceOut(1 - t),
  ELASTIC: (t, k) => {
    if (t === 0 || t === 1) return t;
    const p = k.period || 0.3,
      a = Math.max(1, k.amplitude ?? 1),
      s = (p / (2 * Math.PI)) * Math.asin(1 / a);
    return -(a * Math.pow(2, 10 * (t - 1)) * Math.sin(((t - 1 - s) * 2 * Math.PI) / p));
  },
};

function bounceOut(t: number) {
  if (t < 1 / 2.75) return 7.5625 * t * t;
  if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
  if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
  return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
}

function ease(k: Keyframe, t: number) {
  const fn = easeIn[k.interpolation];
  if (!fn) return t;
  // default easing per type: BOUNCE/ELASTIC/BACK default to ease-out, others ease-in-out... (AUTO)
  let mode = k.easing;
  if (mode === 'AUTO') mode = ['BOUNCE', 'ELASTIC', 'BACK'].includes(k.interpolation) ? 'EASE_OUT' : 'EASE_IN';
  if (mode === 'EASE_IN') return fn(t, k);
  if (mode === 'EASE_OUT') return 1 - fn(1 - t, k);
  return t < 0.5 ? fn(t * 2, k) / 2 : 1 - fn((1 - t) * 2, k) / 2;
}

/** Linear lookup in baked samples (held at the ends). */
function evaluateSamples(sp: [number, number][], frame: number): number {
  if (frame <= sp[0][0]) return sp[0][1];
  const last = sp[sp.length - 1];
  if (frame >= last[0]) return last[1];
  let lo = 0,
    hi = sp.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sp[mid][0] <= frame) lo = mid;
    else hi = mid;
  }
  const [x0, y0] = sp[lo],
    [x1, y1] = sp[hi];
  return x1 > x0 ? y0 + ((y1 - y0) * (frame - x0)) / (x1 - x0) : y1;
}

/** Whether a curve has anything to evaluate (keys or baked samples). */
export const hasCurveData = (fc: FCurve) => fc.keyframe_points.length > 0 || !!fc.sampled_points?.length;

/** Eased factor for `t` in [0, 1]: an easing type (SINE … ELASTIC, LINEAR passes through) and mode. */
export function easeFactor(type: string, easing: string, t: number, o: { back?: number; amplitude?: number; period?: number } = {}): number {
  return ease({ interpolation: type, easing, ...o } as unknown as Keyframe, t);
}

function evaluateRaw(fc: FCurve, frame: number): number {
  const k = fc.keyframe_points;
  const n = k.length;
  if (!n) return fc.sampled_points?.length ? evaluateSamples(fc.sampled_points, frame) : 0;
  const first = k[0],
    last = k[n - 1];
  if (frame <= first.co[0]) {
    if (fc.extrapolation === 'LINEAR' && n > 1) {
      const slope =
        first.interpolation === 'BEZIER'
          ? (first.co[1] - first.handle_left[1]) / (first.co[0] - first.handle_left[0] || 1)
          : (k[1].co[1] - first.co[1]) / (k[1].co[0] - first.co[0] || 1);
      return first.co[1] + slope * (frame - first.co[0]);
    }
    return first.co[1];
  }
  if (frame >= last.co[0]) {
    if (fc.extrapolation === 'LINEAR' && n > 1) {
      const prev = k[n - 2];
      const slope =
        prev.interpolation === 'BEZIER'
          ? (last.handle_right[1] - last.co[1]) / (last.handle_right[0] - last.co[0] || 1)
          : (last.co[1] - prev.co[1]) / (last.co[0] - prev.co[0] || 1);
      return last.co[1] + slope * (frame - last.co[0]);
    }
    return last.co[1];
  }
  // binary search segment
  let lo = 0,
    hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (k[mid].co[0] <= frame) lo = mid;
    else hi = mid;
  }
  const a = k[lo],
    b = k[hi];
  const span = b.co[0] - a.co[0];
  if (span <= 0) return b.co[1];
  const t = (frame - a.co[0]) / span;
  switch (a.interpolation) {
    case 'CONSTANT':
      return a.co[1];
    case 'LINEAR':
      return a.co[1] + (b.co[1] - a.co[1]) * t;
    case 'BEZIER':
      return bezierValue(a.co, a.handle_right, b.handle_left, b.co, frame);
    default:
      return a.co[1] + (b.co[1] - a.co[1]) * ease(a, t);
  }
}

/** How strongly a modifier applies at a frame (influence and restricted frame range with blending). */
export function modifierWeight(m: FModifier, frame: number): number {
  let w = m.use_influence ? Math.max(0, Math.min(1, m.influence ?? 1)) : 1;
  if (m.use_restricted_range) {
    const a = m.frame_start ?? 0,
      b = m.frame_end ?? 0;
    if (frame < a || frame > b) return 0;
    const bi = m.blend_in ?? 0,
      bo = m.blend_out ?? 0;
    if (bi > 0 && frame < a + bi) w *= (frame - a) / bi;
    if (bo > 0 && frame > b - bo) w *= (b - frame) / bo;
  }
  return w;
}

export function evaluateFCurve(fc: FCurve, frame: number): number {
  let f = frame;
  // time-domain modifiers
  for (const m of fc.modifiers) {
    if (m.mute) continue;
    let g = f;
    if (m.type === 'CYCLES') g = cycleFrame(fc, m, f);
    else if (m.type === 'STEPPED') {
      const step = m.frame_step || 2,
        off = m.frame_offset || 0;
      g = Math.floor((f - off) / step) * step + off;
    } else continue;
    const w = modifierWeight(m, frame);
    f = w >= 1 ? g : f + (g - f) * w;
  }
  let v = evaluateRaw(fc, f);
  if (fc.modifiers.length) {
    for (const m of fc.modifiers) {
      if (m.mute) continue;
      let nv = v;
      if (m.type === 'CYCLES' && (m.mode_before === 'REPEAT_OFFSET' || m.mode_after === 'REPEAT_OFFSET')) nv = v + cycleOffset(fc, m, frame);
      else if (m.type === 'NOISE') nv = v + noise1((frame - (m.offset ?? 0)) / (m.scale || 1) + (m.phase ?? 1) * 7.31, m.depth ?? 0) * (m.strength ?? 1);
      else if (m.type === 'GENERATOR' && m.coefficients) {
        let p = 0;
        m.coefficients.forEach((c, i) => (p += c * Math.pow(frame, i)));
        nv = m.use_additive ? v + p : p;
      } else if (m.type === 'FNGENERATOR') {
        const g = (m.amplitude ?? 1) * builtinFunction(m.function_type ?? 'SIN', (m.phase_multiplier ?? 1) * frame + (m.phase_offset ?? 0)) + (m.value_offset ?? 0);
        nv = m.use_additive ? v + g : g;
      } else if (m.type === 'ENVELOPE') nv = envelopeValue(m, frame, v);
      else if (m.type === 'LIMITS') {
        if (m.use_min_y) nv = Math.max(m.min_y ?? 0, nv);
        if (m.use_max_y) nv = Math.min(m.max_y ?? 0, nv);
      } else continue;
      const w = modifierWeight(m, frame);
      v = w >= 1 ? nv : v + (nv - v) * w;
    }
  }
  return v;
}

function builtinFunction(type: string, x: number) {
  switch (type) {
    case 'COS':
      return Math.cos(x);
    case 'TAN':
      return Math.tan(x);
    case 'SQRT':
      return x >= 0 ? Math.sqrt(x) : 0;
    case 'LN':
      return x > 0 ? Math.log(x) : 0;
    case 'SINC':
      return Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    default:
      return Math.sin(x);
  }
}

/** Envelope: rescale the value from the default range into the range of the control points at this frame. */
function envelopeValue(m: FModifier, frame: number, v: number) {
  const pts = [...(m.control_points ?? [])].sort((a, b) => a.frame - b.frame);
  if (!pts.length) return v;
  let lo: number, hi: number;
  if (frame <= pts[0].frame) [lo, hi] = [pts[0].min, pts[0].max];
  else if (frame >= pts[pts.length - 1].frame) [lo, hi] = [pts[pts.length - 1].min, pts[pts.length - 1].max];
  else {
    const i = pts.findIndex((p) => p.frame > frame);
    const a = pts[i - 1],
      b = pts[i];
    const t = (frame - a.frame) / (b.frame - a.frame || 1);
    lo = a.min + (b.min - a.min) * t;
    hi = a.max + (b.max - a.max) * t;
  }
  const dmin = m.default_min ?? -1,
    dmax = m.default_max ?? 1;
  const fac = dmax - dmin !== 0 ? (v - ((m.reference_value ?? 0) + dmin)) / (dmax - dmin) : 0;
  return lo + fac * (hi - lo);
}

function cycleFrame(fc: FCurve, m: FModifier, f: number) {
  const k = fc.keyframe_points;
  if (k.length < 2) return f;
  const a = k[0].co[0],
    b = k[k.length - 1].co[0],
    len = b - a;
  if (len <= 0) return f;
  if (f < a && m.mode_before !== 'NONE') {
    const c = Math.floor((f - a) / len);
    let local = f - c * len;
    if (m.mode_before === 'MIRROR' && Math.abs(c) % 2 === 1) local = b - (local - a);
    return local;
  }
  if (f > b && m.mode_after !== 'NONE') {
    const c = Math.floor((f - a) / len);
    let local = f - c * len;
    if (m.mode_after === 'MIRROR' && c % 2 === 1) local = b - (local - a);
    return local;
  }
  return f;
}

function cycleOffset(fc: FCurve, m: FModifier, f: number) {
  const k = fc.keyframe_points;
  if (k.length < 2) return 0;
  const a = k[0].co[0],
    b = k[k.length - 1].co[0],
    len = b - a;
  const dv = k[k.length - 1].co[1] - k[0].co[1];
  const c = Math.floor((f - a) / len);
  if ((c < 0 && m.mode_before === 'REPEAT_OFFSET') || (c > 0 && f > b && m.mode_after === 'REPEAT_OFFSET')) return c * dv;
  return 0;
}

// Simple deterministic gradient noise for the NOISE modifier
function hash(i: number) {
  let x = Math.imul(i ^ 0x27d4eb2d, 0x165667b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}
function noise1(x: number, depth: number) {
  let sum = 0,
    amp = 1,
    norm = 0;
  for (let o = 0; o <= depth; o++) {
    const i = Math.floor(x),
      f = x - i,
      u = f * f * (3 - 2 * f);
    sum += (hash(i) * (1 - u) + hash(i + 1) * u) * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2;
  }
  return sum / norm;
}

/** Insert or replace a keyframe; returns the keyframe. */
export function insertKeyframe(fc: FCurve, frame: number, value: number, opts: Partial<Keyframe> = {}): Keyframe {
  const existing = fc.keyframe_points.find((k) => Math.abs(k.co[0] - frame) < 1e-4);
  if (existing) {
    const dy = value - existing.co[1];
    existing.co[1] = value;
    existing.handle_left[1] += dy;
    existing.handle_right[1] += dy;
    Object.assign(existing, opts);
    calcHandles(fc);
    return existing;
  }
  const prev = [...fc.keyframe_points].reverse().find((k) => k.co[0] < frame);
  // newly inserted keys are selected
  const k = { ...newKeyframe(frame, value, prev?.interpolation ?? keyframeDefaults.interpolation), select_control_point: true, select_left_handle: true, select_right_handle: true, ...opts };
  fc.keyframe_points.push(k);
  sortKeyframes(fc);
  calcHandles(fc);
  return k;
}

export function fcurveRange(fc: FCurve): [number, number] {
  const k = fc.keyframe_points;
  if (!k.length) return [0, 0];
  return [k[0].co[0], k[k.length - 1].co[0]];
}

export function fcurveValueRange(fc: FCurve, includeHandles = true): [number, number] {
  let lo = Infinity,
    hi = -Infinity;
  for (const k of fc.keyframe_points) {
    lo = Math.min(lo, k.co[1]);
    hi = Math.max(hi, k.co[1]);
    if (includeHandles && k.interpolation === 'BEZIER') {
      lo = Math.min(lo, k.handle_left[1], k.handle_right[1]);
      hi = Math.max(hi, k.handle_left[1], k.handle_right[1]);
    }
  }
  return lo === Infinity ? [0, 1] : [lo, hi];
}
