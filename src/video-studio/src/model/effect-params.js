/**
 * Adjustable parameters of every effect, keyed by effect id. Effect clips
 * (on an effect track) and per-clip effect stacks both store their values as
 * params: { [key]: number | '#rrggbb' }.
 *
 * A numeric param { key, label, min, max, step?, unit?, def, raw?, zeroOff? }
 * reaches its shader as the uniform u_<key>: value / 100, or the value itself
 * when raw is set (angles, hues). A color param { key, label, type: 'color',
 * def } reaches it as an RGB vec3 in 0..1. zeroOff marks the param that turns
 * the effect off at 0, so the compositor can skip that pass entirely.
 *
 * Older projects stored { speed, strength } for every effect; those keys keep
 * their meaning (speed and strength, 0..100) wherever an effect uses them.
 */

import { BODY_EFFECT_PARAMS } from './body-effects.js';

const pct = (key, label, def, extra = {}) => ({ key, label, min: 0, max: 100, step: 1, unit: '%', def, ...extra });
const strength = (def = 50, label = 'Strength', extra = {}) => pct('strength', label, def, { zeroOff: true, ...extra });
const speed = (def = 50, label = 'Speed') => pct('speed', label, def);
const degrees = (key, label, def, min = 0, max = 360) => ({ key, label, min, max, step: 1, unit: '°', def, raw: true });
const color = (key, label, def) => ({ key, label, type: 'color', def });

/** Shape used for ids this version does not know (keeps old values intact). */
const LEGACY = Object.freeze([speed(), pct('strength', 'Strength', 50)]);

export const EFFECT_PARAMS = {
  // Basic
  blur: [strength(50, 'Amount')],
  vignette: [strength(50, 'Amount')],
  'black-white': [pct('strength', 'Amount', 50)],
  invert: [pct('strength', 'Amount', 50)],
  sharpen: [pct('strength', 'Amount', 50)],
  'soft-focus': [strength(60, 'Diffusion'), pct('radius', 'Radius', 45)],
  'tilt-shift': [strength(70, 'Blur'), pct('focus', 'Focus height', 45), pct('size', 'Focus band', 30)],
  duotone: [strength(100, 'Amount'), color('dark', 'Shadows', '#1b1464'), color('light', 'Highlights', '#ff8a5c')],
  'color-pop': [strength(100, 'Amount'), degrees('hue', 'Keep hue', 0), pct('range', 'Range', 35)],
  // Motion
  'zoom-pulse': [speed(), pct('strength', 'Strength', 50)],
  shake: [speed(), pct('strength', 'Strength', 50)],
  'spin-blur': [speed(), strength()],
  'zoom-blur': [speed(), strength()],
  strobe: [speed(), strength()],
  'slow-push': [strength(45, 'Zoom'), degrees('angle', 'Drift direction', 30)],
  'beat-bounce': [pct('speed', 'Tempo', 40), strength(55)],
  handheld: [speed(35), strength(45)],
  'whip-blur': [speed(40), strength(60), degrees('angle', 'Direction', 0, 0, 180)],
  // Light and glow
  glow: [pct('strength', 'Strength', 50)],
  'light-leak': [speed(), strength()],
  flash: [speed(), strength()],
  sparkle: [speed(), strength()],
  bloom: [strength(60), pct('threshold', 'Threshold', 55)],
  'sun-rays': [strength(60), pct('pos', 'Sun position', 70), speed(30)],
  'lens-flare': [strength(65), speed(30)],
  bokeh: [strength(55, 'Amount'), pct('size', 'Size', 50), speed(30)],
  // Retro and film
  vhs: [speed(), pct('strength', 'Strength', 50)],
  'film-grain': [pct('strength', 'Amount', 50)],
  'old-film': [pct('strength', 'Strength', 50)],
  scanlines: [speed(), strength()],
  posterize: [pct('strength', 'Fewer colors', 50)],
  crt: [strength(70), pct('curve', 'Screen curve', 50)],
  'home-movie': [strength(75), pct('grain', 'Grain', 45)],
  dust: [strength(50, 'Amount'), speed(45, 'Flicker')],
  dither: [pct('size', 'Dot size', 30), color('ink', 'Ink', '#1d1b3a'), color('paper', 'Paper', '#f3ead6')],
  bit8: [pct('size', 'Pixel size', 45), pct('colors', 'Colors', 30)],
  // Glitch
  'rgb-split': [speed(), pct('strength', 'Strength', 50)],
  glitch: [speed(), strength()],
  'block-smear': [strength(60), speed(50), pct('size', 'Block size', 40)],
  'signal-tear': [strength(60), speed(50)],
  static: [strength(50, 'Amount'), speed(50)],
  'slice-shift': [strength(60), speed(45), pct('count', 'Slices', 30)],
  'pixel-melt': [strength(45, 'Length'), pct('threshold', 'Threshold', 70), speed(30)],
  // Distort
  wave: [speed(), strength()],
  bulge: [strength()],
  pixelate: [pct('strength', 'Size', 50)],
  twirl: [strength(50), pct('size', 'Radius', 60), speed(30)],
  'water-ripple': [strength(50), pct('size', 'Wave length', 50), speed(50)],
  'heat-haze': [strength(50), speed(45)],
  'glass-tiles': [strength(70), pct('size', 'Tile size', 40)],
  // Stylize
  mirror: [{ key: 'strength', label: 'Four-way', min: 0, max: 100, step: 100, unit: '', def: 0 }],
  kaleidoscope: [speed(), pct('strength', 'Segments', 50)],
  edge: [pct('strength', 'Strength', 50)],
  halftone: [pct('strength', 'Dot size', 50)],
  'split-screen': [{ key: 'strength', label: 'Panels', min: 0, max: 100, step: 50, unit: '', def: 50 }],
  letterbox: [pct('strength', 'Bar size', 50)],
  comic: [strength(80), pct('lines', 'Line weight', 40)],
  'oil-paint': [strength(100, 'Amount'), pct('size', 'Brush size', 45)],
  'type-mosaic': [pct('size', 'Character size', 40), pct('color', 'Original colors', 100)],
  'hex-tiles': [pct('size', 'Tile size', 40), pct('gap', 'Gap', 30)],
  crosshatch: [strength(100, 'Amount'), pct('density', 'Density', 50)],
  thermal: [strength(100, 'Amount'), { key: 'shift', label: 'Palette shift', min: -50, max: 50, step: 1, unit: '', def: 0 }],
  'night-scope': [strength(100, 'Amount'), pct('noise', 'Noise', 40)],
  'ink-sketch': [strength(100, 'Amount'), pct('lines', 'Line weight', 45)],
  watercolor: [strength(100, 'Amount'), pct('bleed', 'Bleed', 50)],
  'neon-edges': [strength(100, 'Glow'), degrees('hue', 'Hue', 290)],
  // Party
  disco: [strength(65), speed(50)],
  confetti: [strength(60, 'Amount'), speed(45)],
  hearts: [strength(55, 'Amount'), speed(40), color('color', 'Color', '#ff4f7b')],
  'hue-cycle': [strength(100, 'Amount'), speed(40)],
  'color-strobe': [strength(60), pct('speed', 'Tempo', 50)],
  // Frames and borders
  'film-strip': [pct('size', 'Border', 45), pct('speed', 'Scroll', 30)],
  'instant-photo': [pct('size', 'Border', 45), color('color', 'Paper', '#f6f3ec')],
  'rounded-frame': [pct('size', 'Inset', 30), pct('radius', 'Corner radius', 45), color('color', 'Background', '#14181f')],
  viewfinder: [strength(100, 'Opacity'), color('color', 'Color', '#ffffff')],
  'neon-border': [pct('size', 'Thickness', 35), pct('speed', 'Chase speed', 45), color('color', 'Color', '#3ee6ff')],
  'blur-fill': [pct('size', 'Inset', 25)],
  // Weather and particles
  snow: [strength(60, 'Amount'), speed(40), pct('size', 'Flake size', 50)],
  rain: [strength(60, 'Amount'), speed(60), degrees('angle', 'Wind', 12, -45, 45)],
  fog: [strength(55, 'Density'), speed(30), color('color', 'Color', '#dfe4ea')],
  fireflies: [strength(55, 'Amount'), speed(40), color('color', 'Color', '#ffd860')],
  embers: [strength(55, 'Amount'), speed(50)],
  // People (need the person matte, see model/body-effects.js)
  ...BODY_EFFECT_PARAMS,
};

/** Parameter definitions for an effect id (legacy speed and strength for unknown ids). */
export function effectParamDefs(id) {
  return Object.hasOwn(EFFECT_PARAMS, id) ? EFFECT_PARAMS[id] : LEGACY;
}

const HEX = /^#[0-9a-f]{6}$/i;

function clampParam(d, v) {
  if (d.type === 'color') return HEX.test(String(v)) ? String(v).toLowerCase() : d.def;
  const n = Number(v);
  if (!Number.isFinite(n)) return d.def;
  return Math.min(d.max, Math.max(d.min, n));
}

/** Default param values for an effect. */
export function effectDefaults(id) {
  const out = {};
  for (const d of effectParamDefs(id)) out[d.key] = d.def;
  return out;
}

/** Validate untrusted params against an effect's definitions (missing keys get defaults). */
export function normalizeEffectParams(id, raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const d of effectParamDefs(id)) out[d.key] = Object.hasOwn(src, d.key) ? clampParam(d, src[d.key]) : d.def;
  return out;
}

/** Clamp one param value for an effect; undefined if the effect has no such param. */
export function clampEffectParam(id, key, value) {
  const d = effectParamDefs(id).find((x) => x.key === key);
  return d ? clampParam(d, value) : undefined;
}

/**
 * Params for a new effect when switching from another one: keys both share
 * keep their values, the rest start at the new effect's defaults.
 */
export function carryEffectParams(id, previous) {
  const out = effectDefaults(id);
  for (const d of effectParamDefs(id)) if (previous && Object.hasOwn(previous, d.key)) out[d.key] = clampParam(d, previous[d.key]);
  return out;
}

/** True when the effect's on/off param is at 0 (the pass would change nothing). */
export function effectIsOff(id, params) {
  for (const d of effectParamDefs(id)) {
    if (d.zeroOff && Number(params?.[d.key] ?? d.def) <= 0) return true;
  }
  return false;
}

function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Uniform values for an effect's params: [[name, number | [r, g, b]]]. */
export function effectUniforms(id, params) {
  return effectParamDefs(id).map((d) => {
    const v = params?.[d.key] ?? d.def;
    if (d.type === 'color') return [`u_${d.key}`, hexToRgb(HEX.test(String(v)) ? v : d.def)];
    const n = Number.isFinite(Number(v)) ? Number(v) : d.def;
    return [`u_${d.key}`, d.raw ? n : n / 100];
  });
}
