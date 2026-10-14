// Parameter value mapping shared by knobs, automation and the engine host.
// A parameter definition (see instruments/catalog.js) has min, max, def and
// an optional curve: 'lin' (default), 'log' (frequencies, rates) or 'pow2'
// (times: fine control near zero).

import { clamp } from './util.js';
import { keyName } from './util.js';

/** Value to a normalized 0..1 position. */
export function toNorm(p, v) {
  const x = clamp(Number(v), p.min, p.max);
  if (p.max === p.min) return 0;
  if (p.curve === 'log' && p.min > 0) return Math.log(x / p.min) / Math.log(p.max / p.min);
  const n = (x - p.min) / (p.max - p.min);
  return p.curve === 'pow2' ? Math.sqrt(n) : n;
}

/** Normalized 0..1 position to a value (stepped when the param has a step). */
export function fromNorm(p, n) {
  const t = clamp(n, 0, 1);
  let v;
  if (p.curve === 'log' && p.min > 0) v = p.min * (p.max / p.min) ** t;
  else if (p.curve === 'pow2') v = p.min + (p.max - p.min) * t * t;
  else v = p.min + (p.max - p.min) * t;
  if (p.step) v = Math.round(v / p.step) * p.step;
  return clamp(v, p.min, p.max);
}

/** Human-readable value with unit, e.g. "1.2 kHz", "350 ms", "45%", "On". */
export function formatParam(p, v) {
  if (p.options) return p.options[Math.round(v)] ?? String(v);
  switch (p.unit) {
    case 'Hz':
      return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${v < 10 ? v.toFixed(2) : Math.round(v)} Hz`;
    case 'ms':
      return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;
    case 's':
      return `${v.toFixed(2)} s`;
    case 'dB':
      return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
    case '%':
      return p.min < 0 ? `${v > 0 ? '+' : ''}${Math.round(v * 100)}%` : `${Math.round(v * 100)}%`;
    case 'st':
      return `${v > 0 ? '+' : ''}${p.step ? v : v.toFixed(1)} st`;
    case 'ct':
      return `${v > 0 ? '+' : ''}${Math.round(v)} ct`;
    case 'key':
      return keyName(Math.round(v));
    case 'bpm':
      return `${Number(v.toFixed(2))} BPM`;
    default:
      return p.step ? String(Math.round(v)) : v.toFixed(2);
  }
}

/** Parses typed text for a parameter ("2k", "-6", "350ms", "40%"). Returns null if invalid. */
export function parseParam(p, text) {
  const s = String(text).trim().toLowerCase();
  if (p.options) {
    const i = p.options.findIndex((o) => o.toLowerCase() === s);
    if (i >= 0) return i;
  }
  const m = s.match(/^([-+]?\d*\.?\d+)\s*(k)?/);
  if (!m) return null;
  let v = Number(m[1]) * (m[2] ? 1000 : 1);
  if (p.unit === '%' && !s.includes('.') && Math.abs(v) > 1) v /= 100;
  else if (p.unit === '%' && s.includes('%')) v /= 100;
  if (p.unit === 'ms' && /\ds$/.test(s) && !s.endsWith('ms')) v *= 1000;
  if (!Number.isFinite(v)) return null;
  if (p.step) v = Math.round(v / p.step) * p.step;
  return clamp(v, p.min, p.max);
}
