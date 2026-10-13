/**
 * Style looks for video and image clips: an art style over the whole clip
 * in one choice and one Amount, running live on the device as one of the
 * effect shaders (several are effects that already exist in the Effects
 * panel; the look picks their settings from the amount).
 *
 * clip.stylize = { id, amount (0..100) }. The look runs before the clip's
 * own effect stack, so effects added on top see the styled picture. The
 * field is optional; clips without a look have no stylize key.
 */
import { normalizeEffectParams } from './effect-params.js';

const lerp = (a, b, k) => a + (b - a) * k;

export const STYLE_LOOKS = [
  { id: 'ink-sketch', label: 'Ink sketch', effect: 'ink-sketch', params: (k) => ({ strength: lerp(35, 100, k), lines: lerp(30, 60, k) }) },
  { id: 'watercolor', label: 'Watercolor wash', effect: 'watercolor', params: (k) => ({ strength: lerp(40, 100, k), bleed: lerp(20, 80, k) }) },
  { id: 'comic', label: 'Posterized comic', effect: 'comic', params: (k) => ({ strength: lerp(40, 100, k), lines: lerp(25, 60, k) }) },
  { id: 'oil', label: 'Oil daub', effect: 'oil-paint', params: (k) => ({ strength: 100, size: lerp(10, 90, k) }) },
  { id: 'halftone', label: 'Halftone print', effect: 'halftone', params: (k) => ({ strength: lerp(10, 90, k) }) },
  { id: 'mosaic', label: 'Pixel mosaic', effect: 'pixelate', params: (k) => ({ strength: lerp(15, 95, k) }) },
  { id: 'neon', label: 'Neon edges', effect: 'neon-edges', params: (k) => ({ strength: lerp(35, 100, k), hue: 290 }) },
  { id: 'hatch', label: 'Pencil hatch', effect: 'crosshatch', params: (k) => ({ strength: lerp(40, 100, k), density: lerp(35, 70, k) }) },
  { id: 'riso', label: 'Two-ink riso', effect: 'dither', params: (k) => ({ size: lerp(10, 70, k), ink: '#1f3a8a', paper: '#f6e7d2' }) },
];

export const STYLE_AMOUNT_DEFAULT = 70;

const BY_ID = new Map(STYLE_LOOKS.map((s) => [s.id, s]));

export function styleLook(id) {
  return BY_ID.get(id) || null;
}

/** Validate untrusted JSON into { id, amount }, or null when there is no known look. */
export function normalizeStylize(raw) {
  if (!raw || typeof raw !== 'object' || !BY_ID.has(raw.id)) return null;
  const n = Number(raw.amount);
  return { id: raw.id, amount: Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : STYLE_AMOUNT_DEFAULT };
}

const cache = new Map(); // `${id}:${amount}` -> effect entry

/** The effect a look runs for a stylize value: { id, params } or null. */
export function styleEffect(stylize) {
  const look = stylize && BY_ID.get(stylize.id);
  if (!look) return null;
  const amount = Math.min(100, Math.max(0, Number(stylize.amount) || 0));
  const key = `${look.id}:${amount}`;
  let e = cache.get(key);
  if (!e) {
    e = Object.freeze({ id: look.effect, params: Object.freeze(normalizeEffectParams(look.effect, look.params(amount / 100))) });
    cache.set(key, e);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return e;
}
