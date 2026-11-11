/**
 * Text style fields added on top of the original text style (case, box,
 * fill, second outline, glow, depth, color split, curve, bubble, effect),
 * their normalization, and small helpers the renderer and the details
 * panel share. project.js folds these into DEFAULT_TEXT_STYLE and
 * normStyle so old projects load with neutral values.
 */
import { valueAt } from './keyframes.js';

export const TEXT_CASES = ['none', 'upper', 'lower', 'title'];
export const V_ALIGNS = ['top', 'middle', 'bottom'];
export const FILL_TYPES = ['solid', 'linear', 'split'];

/** Defaults for the added fields. Every value is neutral: an old clip looks the same. */
export const TEXT_STYLE_EXTRAS = Object.freeze({
  case: 'none',
  vAlign: 'middle',
  boxWidth: 0, // project px; 0 = the box hugs the text (no wrapping)
  boxHeight: 0, // project px; 0 = as tall as the text
  fillType: 'solid',
  fillOpacity: 1,
  grad1: '#ffffff',
  grad2: '#ffd23f',
  grad3: '',
  gradAngle: 90, // degrees, 90 = top to bottom
  stroke2Color: '#ffffff',
  stroke2Width: 0,
  glowColor: '#4fd8ff',
  glowStrength: 0, // 0..100
  glowRadius: 20,
  extrudeDepth: 0, // project px of solid repeated offset ("3D")
  extrudeColor: '#000000',
  extrudeAngle: 45,
  glitch: 0, // project px offset of the two color fringes
  glitchColorA: '#00e5ff',
  glitchColorB: '#ff2d78',
  arc: 0, // -100..100, bends the baseline around a circle
  highlightColor: '#ffd23f', // word highlight (karaoke animation)
  bubble: '', // id in engine/bubbles.js, '' = none
  bubbleFill: '#ffffff',
  bubbleStroke: '#111111',
  bubbleStrokeWidth: 3,
  effect: '', // id of the word-art look last applied (for the picker)
});

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clampN = (v, lo, hi, d) => Math.min(hi, Math.max(lo, num(v, d)));
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const id = (v) => (typeof v === 'string' ? v.replace(/[^a-z0-9-]/gi, '').slice(0, 40) : '');

/** Normalize the added fields of a raw style (untrusted JSON). */
export function normTextExtras(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const d = TEXT_STYLE_EXTRAS;
  return {
    // Older projects stored an uppercase switch.
    case: oneOf(s.case, TEXT_CASES, s.uppercase ? 'upper' : d.case),
    vAlign: oneOf(s.vAlign, V_ALIGNS, d.vAlign),
    boxWidth: Math.round(clampN(s.boxWidth, 0, 8000, 0)),
    boxHeight: Math.round(clampN(s.boxHeight, 0, 8000, 0)),
    fillType: oneOf(s.fillType, FILL_TYPES, d.fillType),
    fillOpacity: clampN(s.fillOpacity, 0, 1, 1),
    grad1: hex(s.grad1, d.grad1),
    grad2: hex(s.grad2, d.grad2),
    grad3: s.grad3 === '' ? '' : hex(s.grad3, ''),
    gradAngle: clampN(s.gradAngle, -360, 360, d.gradAngle),
    stroke2Color: hex(s.stroke2Color, d.stroke2Color),
    stroke2Width: clampN(s.stroke2Width, 0, 40, 0),
    glowColor: hex(s.glowColor, d.glowColor),
    glowStrength: clampN(s.glowStrength, 0, 100, 0),
    glowRadius: clampN(s.glowRadius, 0, 100, d.glowRadius),
    extrudeDepth: clampN(s.extrudeDepth, 0, 60, 0),
    extrudeColor: hex(s.extrudeColor, d.extrudeColor),
    extrudeAngle: clampN(s.extrudeAngle, -360, 360, d.extrudeAngle),
    glitch: clampN(s.glitch, 0, 40, 0),
    glitchColorA: hex(s.glitchColorA, d.glitchColorA),
    glitchColorB: hex(s.glitchColorB, d.glitchColorB),
    arc: clampN(s.arc, -100, 100, 0),
    highlightColor: hex(s.highlightColor, d.highlightColor),
    bubble: id(s.bubble),
    bubbleFill: hex(s.bubbleFill, d.bubbleFill),
    bubbleStroke: hex(s.bubbleStroke, d.bubbleStroke),
    bubbleStrokeWidth: clampN(s.bubbleStrokeWidth, 0, 20, d.bubbleStrokeWidth),
    effect: id(s.effect),
  };
}

/** The case a style asks for (also honours the old uppercase switch). */
export function caseOf(style) {
  if (style.case && style.case !== 'none') return style.case;
  return style.uppercase ? 'upper' : 'none';
}

/** Apply a case to text. Title case capitalizes the first letter of each word. */
export function applyCase(text, mode) {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  if (mode === 'title') return text.toLowerCase().replace(/(^|[\s\-/("'“])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
  return text;
}

/* Text color keyframes ------------------------------------------------------
 * The color is keyed as three channel props so the generic keyframe code
 * (interpolation, split, trim, speed) handles it without knowing colors.
 */
export const COLOR_KEYS = ['style.colorR', 'style.colorG', 'style.colorB'];

export function hexToRgb(h) {
  const n = parseInt(String(h).slice(1), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function hasColorKeys(clip) {
  return Boolean(clip?.keyframes?.[COLOR_KEYS[0]]?.length);
}

/**
 * Remove the text color keyframes (a style preset or word-art look sets its
 * own fill, which keys would hide). Returns true when there were any.
 */
export function dropColorKeys(clip) {
  if (!hasColorKeys(clip)) return false;
  for (const k of COLOR_KEYS) delete clip.keyframes[k];
  return true;
}

/** Keyed text color at clip-local time, or null when the color is not keyed. */
export function textColorAt(clip, local) {
  if (!hasColorKeys(clip)) return null;
  const base = hexToRgb(clip.style.color);
  return rgbToHex(...COLOR_KEYS.map((k, i) => valueAt(clip.keyframes, k, local, base[i])));
}

/**
 * Style fields a word-art look or a reset puts back to neutral before its
 * own values apply (fill, outlines, shadow, glow, depth, color split,
 * background). Font, size, case, spacing, box and alignment stay.
 */
export const DECOR_KEYS = [
  'color', 'fillType', 'fillOpacity', 'grad1', 'grad2', 'grad3', 'gradAngle',
  'strokeColor', 'strokeWidth', 'stroke2Color', 'stroke2Width',
  'shadowColor', 'shadowOpacity', 'shadowBlur', 'shadowDistance', 'shadowAngle',
  'glowColor', 'glowStrength', 'glowRadius',
  'extrudeDepth', 'extrudeColor', 'extrudeAngle',
  'glitch', 'glitchColorA', 'glitchColorB',
  'bgColor', 'bgOpacity', 'bgRadius',
];
