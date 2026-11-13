// Small shared helpers with no DOM dependency (safe in workers and tests).

/** Short random id (base 36). Collisions are vanishingly unlikely at project scale. */
export function uid(len = 8) {
  let s = '';
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) s += (b % 36).toString(36);
  return s;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function round(v, step) {
  return Math.round(v / step) * step;
}

/** Linear gain to decibels; -Infinity for silence. */
export function gainToDb(g) {
  return g > 0 ? 20 * Math.log10(g) : -Infinity;
}

export function dbToGain(db) {
  return db === -Infinity ? 0 : 10 ** (db / 20);
}

export function formatDb(g, digits = 1) {
  const db = gainToDb(g);
  return db === -Infinity ? '-inf dB' : `${db > 0 ? '+' : ''}${db.toFixed(digits)} dB`;
}

/** Pan -1..1 as "Centered", "35% left", "100% right". */
export function formatPan(p) {
  const pct = Math.round(Math.abs(p) * 100);
  if (pct === 0) return 'Centered';
  return `${pct}% ${p < 0 ? 'left' : 'right'}`;
}

/** Parse displayed pan text, signed percentages, or a normalized -1..1 value. */
export function parsePan(text) {
  const s = String(text).trim().toLowerCase();
  if (s === 'centered' || s === 'center') return 0;
  const direction = s.match(/^(\d*\.?\d+)\s*%?\s*(left|right)$/);
  if (direction) return clamp(Number(direction[1]) / 100, 0, 1) * (direction[2] === 'left' ? -1 : 1);
  const numeric = s.match(/^([-+]?\d*\.?\d+)\s*(%)?$/);
  if (!numeric) return null;
  const value = Number(numeric[1]) / (numeric[2] ? 100 : 1);
  return Number.isFinite(value) ? clamp(value, -1, 1) : null;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI key number to a name such as "C5" (key 60 = C5, matching the app's octave numbering). */
export function keyName(key) {
  return `${NOTE_NAMES[((key % 12) + 12) % 12]}${Math.floor(key / 12)}`;
}

export function isBlackKey(key) {
  return [1, 3, 6, 8, 10].includes(((key % 12) + 12) % 12);
}

export function keyToHz(key) {
  return 440 * 2 ** ((key - 69) / 12);
}

/** Moves array item `from` to index `to` (immutable). */
export function moveItem(arr, from, to) {
  const out = arr.slice();
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

/** Shallow-equal check for plain objects. */
export function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** Platform-aware modifier label for menus and hints. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
