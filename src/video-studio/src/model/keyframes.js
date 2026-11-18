/**
 * Keyframes are stored per clip as { [prop]: [{ t, v, ease }] } where t is
 * clip-local time in microseconds (0 = clip start on the timeline) and ease
 * names how the value travels from this key to the next. A trimmed segment
 * may retain its original easing interval in curve, without adding visible keys.
 */

export const KEYFRAME_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'];

/**
 * Color values animate too, as 'adjust.<key>' (adjust.exposure, ...).
 * baseValue / setBaseValue read and write the unkeyed value of any
 * animatable prop.
 */
export function baseValue(clip, prop) {
  if (prop.startsWith('adjust.')) return clip.adjust?.[prop.slice(7)] ?? 0;
  if (prop === 'opacity' || prop === 'volume') return clip[prop];
  const field = dottedField(clip, prop);
  if (field) return field.obj?.[field.key] ?? 0;
  if (prop === 'sx' || prop === 'sy') return clip.transform?.[prop] ?? 1;
  return clip.transform?.[prop];
}

/**
 * Object and key behind a dotted prop other than adjust.*: mask<i>.<key>
 * reads clip.masks[i], remove<i>.<key> the object removal region i,
 * <field>.<key> reads clip[field] (relight.angle, ...).
 */
function dottedField(clip, prop) {
  const dot = prop.indexOf('.');
  if (dot <= 0) return null;
  const head = prop.slice(0, dot);
  const key = prop.slice(dot + 1);
  const m = /^mask(\d+)$/.exec(head);
  if (m) return { obj: clip.masks?.[Number(m[1])], key };
  const r = /^remove(\d+)$/.exec(head);
  if (r) return { obj: clip.removal?.regions?.[Number(r[1])], key };
  const obj = clip[head];
  return { obj: obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null, key };
}

export function setBaseValue(clip, prop, value) {
  if (prop.startsWith('adjust.')) {
    if (clip.adjust) clip.adjust[prop.slice(7)] = value;
  } else if (prop === 'opacity' || prop === 'volume') clip[prop] = value;
  else if (dottedField(clip, prop)) {
    const f = dottedField(clip, prop);
    if (f.obj) f.obj[f.key] = value;
  } else if (clip.transform) clip.transform[prop] = value;
}

const BACK = 1.70158;

export const EASINGS = {
  linear: (p) => p,
  easeIn: (p) => p * p * p,
  easeOut: (p) => 1 - (1 - p) ** 3,
  easeInOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  smooth: (p) => -(Math.cos(Math.PI * p) - 1) / 2,
  overshoot: (p) => 1 + (BACK + 1) * (p - 1) ** 3 + BACK * (p - 1) ** 2,
  anticipate: (p) => (BACK + 1) * p ** 3 - BACK * p * p,
  elastic: (p) => (p <= 0 || p >= 1 ? p : 2 ** (-10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  bounce: (p) => {
    const n = 7.5625;
    const d = 2.75;
    if (p < 1 / d) return n * p * p;
    if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
    if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
    return n * (p -= 2.625 / d) * p + 0.984375;
  },
  hold: () => 0,
};

/** A custom curve: "cubic(x1,y1,x2,y2)", the two handles of a cubic from (0,0) to (1,1). */
const CUBIC = /^cubic\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)$/;
const cubicCache = new Map();

/** Handles of a custom curve name, or null. x stays in 0..1; y may overshoot (-1..2). */
export function parseCubic(name) {
  const m = CUBIC.exec(String(name || ''));
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const cx = (v) => Math.min(1, Math.max(0, v));
  const cy = (v) => Math.min(2, Math.max(-1, v));
  return [cx(x1), cy(y1), cx(x2), cy(y2)];
}

/** Name for a custom curve (rounded so names stay short and comparable). */
export function cubicName(x1, y1, x2, y2) {
  const r = (v) => Math.round(v * 1000) / 1000;
  return `cubic(${r(Math.min(1, Math.max(0, x1)))},${r(Math.min(2, Math.max(-1, y1)))},${r(Math.min(1, Math.max(0, x2)))},${r(Math.min(2, Math.max(-1, y2)))})`;
}

/** Progress along a cubic curve at time p: find the curve parameter whose x is p, return its y. */
export function cubicEase(x1, y1, x2, y2) {
  const bx = (u) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const by = (u) => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  const dx = (u) => 3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
  return (p) => {
    let u = p;
    for (let i = 0; i < 6; i++) {
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u = Math.min(1, Math.max(0, u - (bx(u) - p) / d));
    }
    // Newton can stall on flat stretches; finish with bisection.
    if (Math.abs(bx(u) - p) > 1e-5) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 40; i++) {
        u = (lo + hi) / 2;
        if (bx(u) < p) lo = u;
        else hi = u;
      }
    }
    return by(u);
  };
}

/** Whether a stored ease name is one this version understands. */
export const isEase = (name) => Object.hasOwn(EASINGS, name) || Boolean(parseCubic(name));

export function ease(name, p) {
  const q = Math.min(1, Math.max(0, p));
  const f = EASINGS[name];
  if (f) return f(q);
  if (typeof name === 'string' && name.startsWith('cubic(')) {
    let c = cubicCache.get(name);
    if (!c) {
      const h = parseCubic(name);
      c = h ? cubicEase(...h) : EASINGS.linear;
      if (cubicCache.size > 200) cubicCache.clear();
      cubicCache.set(name, c);
    }
    return c(q);
  }
  return q;
}

/** A retained interval of an easing curve after a trim or split. */
export function normalizeKeyCurve(raw) {
  if (!raw || !isEase(raw.ease)) return null;
  const { from, to, start, end } = raw;
  if (![from, to, start, end].every(Number.isFinite) || from < 0 || to > 1 || from >= to) return null;
  return { ease: raw.ease, from, to, start, end };
}

function curveValue(curve, p) {
  if (p <= 0) return curve.start;
  if (p >= 1) return curve.end;
  return curve.start + (curve.end - curve.start) * ease(curve.ease, p);
}

/** Edits to either endpoint or the easing replace the retained curve naturally. */
function retainedCurve(a, b) {
  const c = a.curve;
  return c && c.ease === a.ease && a.v === curveValue(c, c.from) && b.v === curveValue(c, c.to) ? c : null;
}

const copyKey = k => ({ ...k, ...(k.curve ? { curve: { ...k.curve } } : {}) });

/** Interpolated value of prop at local time t, or base when the prop has no keys. */
export function valueAt(keyframes, prop, t, base) {
  const keys = keyframes?.[prop];
  if (!keys || !keys.length) return base;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  // Binary search for the segment containing t.
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  if (t === a.t) return a.v;
  const p = (t - a.t) / (b.t - a.t);
  const curve = retainedCurve(a, b);
  if (curve) return curveValue(curve, curve.from + (curve.to - curve.from) * p);
  return a.v + (b.v - a.v) * ease(a.ease, p);
}

/** Index of a key within tolerance of t, or -1. */
export function keyIndexAt(keyframes, prop, t, tolerance = 0) {
  const keys = keyframes?.[prop];
  if (!keys) return -1;
  return keys.findIndex((k) => Math.abs(k.t - t) <= tolerance);
}

/** Insert or replace a key. Mutates and returns keyframes. */
export function setKey(keyframes, prop, t, v, easeName = 'linear', tolerance = 0) {
  const keys = (keyframes[prop] ||= []);
  const i = keys.findIndex((k) => Math.abs(k.t - t) <= tolerance);
  if (i >= 0) keys[i] = { ...keys[i], v };
  else {
    keys.push({ t: Math.round(t), v, ease: easeName });
    keys.sort((a, b) => a.t - b.t);
  }
  return keyframes;
}

/**
 * Before the only key of prop is removed: its value becomes the unkeyed
 * value, so the clip keeps looking the same instead of jumping back to a
 * value set before it was animated. Text color keys (style.colorR/G/B)
 * are left to the text inspector, which keeps the color as a whole.
 */
export function keepLastKeyValue(clip, prop) {
  const keys = clip.keyframes?.[prop];
  if (keys?.length === 1 && !prop.startsWith('style.')) setBaseValue(clip, prop, keys[0].v);
}

export function removeKey(keyframes, prop, t, tolerance = 0) {
  const keys = keyframes[prop];
  if (!keys) return keyframes;
  const i = keys.findIndex((k) => Math.abs(k.t - t) <= tolerance);
  if (i >= 0) keys.splice(i, 1);
  if (!keys.length) delete keyframes[prop];
  return keyframes;
}

/** All distinct key times across props, sorted. */
export function keyTimes(keyframes) {
  const set = new Set();
  for (const keys of Object.values(keyframes || {})) for (const k of keys) set.add(k.t);
  return [...set].sort((a, b) => a - b);
}

/**
 * Split keyframes at local time t. Each half keeps its own keys and gets an
 * interpolated key at the cut so the motion is continuous across the split.
 */
export function splitKeyframes(keyframes, t) {
  const left = {};
  const right = {};
  for (const [prop, keys] of Object.entries(keyframes || {})) {
    if (!keys.length) continue;
    left[prop] = windowKeys(keys, -Infinity, t, 0, false, true);
    right[prop] = windowKeys(keys, t, Infinity, -t, true, false);
  }
  return [left, right];
}

/** Copy a key window, retaining the original curve on any shortened segments. */
function windowKeys(keys, lo, hi, dt, startEdge, endEdge) {
  const out = keys.filter(k => k.t >= lo && k.t <= hi).map(copyKey);
  const value = t => valueAt({ v: keys }, 'v', t, keys[0].v);
  if (startEdge && out[0]?.t !== lo) out.unshift({ t: lo, v: value(lo), ease: 'linear' });
  if (endEdge && out.at(-1)?.t !== hi) out.push({ t: hi, v: value(hi), ease: 'linear' });
  let index = 0;
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i];
    const b = out[i + 1];
    while (index + 1 < keys.length && keys[index + 1].t <= a.t) index++;
    const from = keys[index];
    const to = keys[index + 1];
    if (!to || a.t < from.t) continue;
    if (a.t === from.t && b.t === to.t) continue;
    a.ease = from.ease;
    delete a.curve;
    if (a.ease === 'linear' || a.ease === 'hold' || !isEase(a.ease)) continue;
    const source = retainedCurve(from, to) || { ease: from.ease, from: 0, to: 1, start: from.v, end: to.v };
    const span = source.to - source.from;
    a.curve = {
      ...source,
      from: source.from + span * ((a.t - from.t) / (to.t - from.t)),
      to: source.from + span * ((b.t - from.t) / (to.t - from.t)),
    };
    // Calculate edges from the retained interval too, avoiding accumulated rounding
    // differences after repeated cuts. Equal values can still enclose a bounce.
    a.v = curveValue(a.curve, a.curve.from);
    b.v = curveValue(a.curve, a.curve.to);
  }
  for (const k of out) k.t += dt;
  return out;
}

/** Shift and trim keys without restarting their easing at either new edge. */
export function shiftKeyframes(keyframes, dt, duration) {
  const out = {};
  for (const [prop, keys] of Object.entries(keyframes || {})) {
    if (!keys.length) continue;
    const lo = -dt;
    const hi = duration - dt;
    out[prop] = windowKeys(keys, lo, hi, dt, keys[0].t < lo, keys.at(-1).t > hi);
  }
  return out;
}

/** Scale key times by factor (used when speed changes). */
export function scaleKeyframes(keyframes, factor) {
  const out = {};
  for (const [prop, keys] of Object.entries(keyframes || {})) out[prop] = keys.map((k) => {
    const copy = copyKey(k);
    copy.t = Math.round(k.t * factor);
    return copy;
  });
  return out;
}
