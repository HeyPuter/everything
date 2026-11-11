// Helpers for effect definitions: parameter builders with consistent units,
// steps and scales, so every dialog formats values the same way.

/** Step that gives about 1000 positions across a range, rounded to 1, 2 or 5. */
function autoStep(min, max) {
  const raw = (max - min) / 1000;
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/** A numeric parameter. */
export function num(id, label, min, max, def, unit = '', o = {}) {
  return { id, label, type: 'number', min, max, step: o.step ?? autoStep(min, max), default: def, unit, scale: 'linear', ...o };
}

/** Decibels. */
export const db = (id, label, min, max, def, o = {}) => num(id, label, min, max, def, 'dB', { step: 0.1, ...o });

/** Frequency in Hz on a log scale. */
export const hz = (id, label, min, max, def, o = {}) => num(id, label, min, max, def, 'Hz', { step: 1, scale: 'log', ...o });

/**
 * Milliseconds; log scale when the range spans decades. The step is 1 ms on
 * wide ranges, and 0.1 ms on narrow ones and on any range that starts below
 * 1 ms (an attack from 0.1 ms), so its low end can be reached and shown.
 */
export const ms = (id, label, min, max, def, o = {}) => {
  const step = max - min > 100 && !(min > 0 && min < 1) ? 1 : 0.1;
  return num(id, label, min, max, def, 'ms', { step, scale: min > 0 && max / min >= 100 ? 'log' : 'linear', ...o });
};

/** Percentage (0..100 unless given). */
export const pct = (id, label, def, o = {}) => num(id, label, o.min ?? 0, o.max ?? 100, def, '%', { step: 1, ...o });

/** On/off. */
export const bool = (id, label, def = false, o = {}) => ({ id, label, type: 'bool', default: def, ...o });

/**
 * A choice: `options` are labels (values 0, 1, 2...) or { value, label }.
 * Choice values are numbers so they map straight to WASM parameters.
 */
export function choice(id, label, options, def = 0, o = {}) {
  return { id, label, type: 'choice', options: options.map((x, i) => (typeof x === 'string' ? { value: i, label: x } : x)), default: def, ...o };
}

/** Prefixes ids and sets a dialog section for repeated parameter groups (EQ bands, notches). */
export function section(name, prefix, params) {
  return params.map((p) => ({ ...p, id: `${prefix}${p.id[0].toUpperCase()}${p.id.slice(1)}`, section: name }));
}

export const preset = (name, values) => ({ name, values });

/** Linear interpolation of breakpoint points [{ t, v }] at t (0..1). */
export function envelopeValue(points, t) {
  if (!points?.length) return 1;
  if (t <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (t <= b.t) {
      const a = points[i - 1];
      return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t || 1);
    }
  }
  return points[points.length - 1].v;
}

/** Packs [{ f, g }] curve points to a flat Float32Array [f0, g0, f1, g1, ...] sorted by f. */
export function packCurve(points) {
  const sorted = [...(points || [])].sort((a, b) => a.f - b.f);
  const out = new Float32Array(sorted.length * 2);
  sorted.forEach((p, i) => {
    out[2 * i] = p.f;
    out[2 * i + 1] = p.g;
  });
  return out;
}

/** A short stable id for data so FxHost only re-uploads changed blocks. */
export function dataId(value) {
  const s = JSON.stringify(value);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

/** Yields to the event loop (long offline processes stay cancellable). */
export const pause = () => new Promise((r) => setTimeout(r, 0));

/** Throws if the signal was aborted. */
export function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
}

/** RBJ biquad magnitude in dB at frequency f. */
export function biquadDb(type, f0, gainDb, q, f, rate) {
  const w0 = (2 * Math.PI * Math.min(f0, rate * 0.4999)) / rate;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const A = 10 ** (gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peak') {
    [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cw, 1 - alpha * A, 1 + alpha / A, -2 * cw, 1 - alpha / A];
  } else {
    const sa = 2 * Math.sqrt(A) * alpha;
    const s = type === 'low' ? 1 : -1;
    b0 = A * (A + 1 - s * (A - 1) * cw + sa);
    b1 = s * 2 * A * (A - 1 - s * (A + 1) * cw);
    b2 = A * (A + 1 - s * (A - 1) * cw - sa);
    a0 = A + 1 + s * (A - 1) * cw + sa;
    a1 = -s * 2 * (A - 1 + s * (A + 1) * cw);
    a2 = A + 1 + s * (A - 1) * cw - sa;
  }
  const w = (2 * Math.PI * f) / rate;
  const re = (c0, c1, c2) => c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w);
  const im = (c1, c2) => -c1 * Math.sin(w) - c2 * Math.sin(2 * w);
  const num2 = re(b0, b1, b2) ** 2 + im(b1, b2) ** 2;
  const den2 = re(a0, a1, a2) ** 2 + im(a1, a2) ** 2;
  return 10 * Math.log10(num2 / den2);
}
