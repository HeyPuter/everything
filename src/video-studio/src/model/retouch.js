/**
 * People retouch on video and image clips, in five parts:
 *
 * clip.retouch (Skin), each 0..100. Applied in the layer shader to skin
 * tones on people (the person matte from engine/cutout.js keeps it off
 * skin-colored backgrounds such as sand or wood):
 *  - smooth:   edge-preserving smoothing of skin texture
 *  - even:     evens out blotchy color across the skin
 *  - brighten: lifts the light on skin
 *  - sharpen:  crisper detail everywhere except skin (eyes, hair, brows)
 * and fixes placed by the face landmarks (engine/face-render.js), stored only
 * when set:
 *  - blemishes:   fills small dark or red spots on the face
 *  - darkCircles: lifts the shadow under the eyes
 *  - teeth:       whitens teeth (less yellow, a little brighter)
 *  - lips:        tints the lips toward lipColor
 *
 * clip.faceShape (Face): slim, eyes, nose, smile, chin, each -100..100, a
 * gentle warp around the face landmarks; faces: 'all' or 'largest'.
 *
 * clip.bodyShape (Body): slim, waist, head, shoulders, arms (-100..100) and
 * legs (0..100), smooth local warps placed by pose landmarks
 * (engine/body-geometry.js); people: 'all' or 'largest'.
 *
 * clip.makeup (Makeup): blush, eyeshadow, eyeliner, brows, contour and
 * highlight, each 0..100 with its color (<key>Color), stored only when set,
 * placed by the face landmarks (engine/makeup-geometry.js). Lip color stays
 * with the skin fixes in clip.retouch (lips, lipColor), where projects have
 * always kept it; the panel shows it with the makeup.
 *
 * clip.hairColor (Hair): { color, strength 0..100 }, recolors hair found by
 * the hair matte around each face while keeping its light and dark strands.
 *
 * Looks (model/retouch-looks.js) set several of these at once.
 */
export const RETOUCH_KEYS = ['smooth', 'even', 'brighten', 'sharpen'];
export const SKIN_FIX_KEYS = ['blemishes', 'darkCircles', 'teeth', 'lips'];
export const RETOUCH_DEFAULT = Object.freeze({ smooth: 40, even: 20, brighten: 10, sharpen: 0 });
export const LIP_COLOR_DEFAULT = '#b8434e';

export const FACE_SHAPE_KEYS = ['slim', 'eyes', 'nose', 'smile', 'chin'];
export const FACE_SHAPE_DEFAULT = Object.freeze({ slim: 0, eyes: 0, nose: 0, smile: 0, chin: 0, faces: 'all' });

/** Lip shades offered next to the lip color picker. */
export const LIP_SWATCHES = Object.freeze([
  { label: 'Nude', color: '#b27b6c' },
  { label: 'Soft rose', color: '#c45f72' },
  { label: 'Classic red', color: '#b4232f' },
  { label: 'Coral', color: '#df6150' },
  { label: 'Berry', color: '#8c2c4c' },
  { label: 'Plum', color: '#6b2a44' },
  { label: 'Mauve', color: '#a3616f' },
]);

export const BODY_SHAPE_KEYS = ['slim', 'waist', 'legs', 'head', 'shoulders', 'arms'];
export const BODY_SHAPE_DEFAULT = Object.freeze({ slim: 0, waist: 0, legs: 0, head: 0, shoulders: 0, arms: 0, people: 'all' });
/** Legs only lengthen (shortening would pull the bottom of the frame up from nowhere). */
const BODY_MIN = { legs: 0 };

/**
 * Makeup parts: amount key, color key, default color and original shades.
 * Blends are in LAYER_FS (makeup there).
 */
export const MAKEUP_PARTS = Object.freeze([
  { key: 'eyeshadow', label: 'Eyeshadow', colorKey: 'eyeshadowColor', color: '#8c7066', swatches: [
    { label: 'Taupe', color: '#8c7066' }, { label: 'Warm bronze', color: '#9b6a3e' }, { label: 'Plum', color: '#6f4064' },
    { label: 'Smoke', color: '#4b4952' }, { label: 'Rose gold', color: '#c28272' }, { label: 'Moss', color: '#6e6b3c' }, { label: 'Midnight', color: '#30406a' },
  ] },
  { key: 'eyeliner', label: 'Eyeliner', colorKey: 'eyelinerColor', color: '#18151a', swatches: [
    { label: 'Ink', color: '#18151a' }, { label: 'Espresso', color: '#3f2b23' }, { label: 'Navy', color: '#1f2b4c' },
    { label: 'Aubergine', color: '#40203c' }, { label: 'Pine', color: '#1f3b2d' },
  ] },
  { key: 'brows', label: 'Brow tint', colorKey: 'browColor', color: '#3c2b23', swatches: [
    { label: 'Soft black', color: '#262120' }, { label: 'Dark brown', color: '#3c2b23' }, { label: 'Ash brown', color: '#5b4b43' },
    { label: 'Warm brown', color: '#6c4b33' }, { label: 'Blonde', color: '#9b7d5b' }, { label: 'Auburn', color: '#6f3b27' },
  ] },
  { key: 'blush', label: 'Blush', colorKey: 'blushColor', color: '#da6b78', swatches: [
    { label: 'Peach', color: '#e9886b' }, { label: 'Rose', color: '#da6b78' }, { label: 'Coral', color: '#ef705d' },
    { label: 'Berry', color: '#b1486b' }, { label: 'Mauve', color: '#b07183' }, { label: 'Terracotta', color: '#b9694b' },
  ] },
  { key: 'contour', label: 'Contour', colorKey: 'contourColor', color: '#8b5f49', swatches: [
    { label: 'Fair', color: '#a97f6b' }, { label: 'Medium', color: '#8b5f49' }, { label: 'Tan', color: '#704937' },
    { label: 'Deep', color: '#4b2f25' }, { label: 'Cool', color: '#7b6967' },
  ] },
  { key: 'highlight', label: 'Highlight', colorKey: 'highlightColor', color: '#fff2e4', swatches: [
    { label: 'Pearl', color: '#fff2e4' }, { label: 'Champagne', color: '#f6dcb1' }, { label: 'Rose glow', color: '#f3c1a9' },
    { label: 'Gold', color: '#e9c172' }, { label: 'Bronze glow', color: '#d9a172' },
  ] },
]);
export const MAKEUP_KEYS = MAKEUP_PARTS.map((p) => p.key);
/** Order of the makeup amounts and colors in the shader. */
const MAKEUP_ORDER = ['blush', 'eyeshadow', 'eyeliner', 'brows', 'contour', 'highlight'];

export const HAIR_COLOR_DEFAULT = Object.freeze({ color: '#8a3b1f', strength: 0 });
/** Starting points for hair color. */
export const HAIR_SWATCHES = Object.freeze([
  { label: 'Copper', color: '#a4471f' },
  { label: 'Honey blonde', color: '#c8a064' },
  { label: 'Chestnut', color: '#5e3424' },
  { label: 'Jet black', color: '#1b1a1f' },
  { label: 'Silver', color: '#b8bcc4' },
  { label: 'Rose', color: '#c45a7c' },
  { label: 'Violet', color: '#6a4aa8' },
  { label: 'Teal', color: '#2f8a8c' },
]);

const num = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : null);

export function normalizeRetouch(r) {
  const out = {};
  for (const k of RETOUCH_KEYS) out[k] = clamp(num(r?.[k], 0), 0, 100);
  for (const k of SKIN_FIX_KEYS) {
    const v = clamp(num(r?.[k], 0), 0, 100);
    if (v > 0) out[k] = v;
  }
  const lip = hex(r?.lipColor);
  if (lip || out.lips) out.lipColor = lip || LIP_COLOR_DEFAULT;
  return out;
}

/** Shader amounts (0..1) of the skin retouch, or null when it does nothing. */
export function retouchAmounts(r) {
  if (!r) return null;
  const v = RETOUCH_KEYS.map((k) => (r[k] || 0) / 100);
  return v.some((x) => x > 0) ? v : null;
}

/** Shader amounts (0..1) of the face-placed skin fixes, or null when none is on. */
export function skinFixAmounts(r) {
  if (!r) return null;
  const v = SKIN_FIX_KEYS.map((k) => clamp((r[k] || 0) / 100, 0, 1));
  return v.some((x) => x > 0) ? v : null;
}

export function normalizeFaceShape(f) {
  const out = {};
  for (const k of FACE_SHAPE_KEYS) out[k] = clamp(num(f?.[k], 0), -100, 100);
  out.faces = f?.faces === 'largest' ? 'largest' : 'all';
  return out;
}

/** Warp amounts (-1..1) by key, or null when the face is left as it is. */
export function faceShapeAmounts(f) {
  if (!f) return null;
  const out = {};
  let any = false;
  for (const k of FACE_SHAPE_KEYS) {
    out[k] = clamp((f[k] || 0) / 100, -1, 1);
    any ||= out[k] !== 0;
  }
  return any ? out : null;
}

export function normalizeBodyShape(b) {
  const out = {};
  for (const k of BODY_SHAPE_KEYS) out[k] = clamp(num(b?.[k], 0), BODY_MIN[k] ?? -100, 100);
  out.people = b?.people === 'largest' ? 'largest' : 'all';
  return out;
}

/** Warp amounts (-1..1, legs 0..1) by key, or null when the body is left as it is. */
export function bodyShapeAmounts(b) {
  if (!b) return null;
  const out = {};
  let any = false;
  for (const k of BODY_SHAPE_KEYS) {
    out[k] = clamp((b[k] || 0) / 100, BODY_MIN[k] ?? -1, 1);
    any ||= out[k] !== 0;
  }
  return any ? out : null;
}

/** Makeup amounts kept only when set, each with its color once set or picked. */
export function normalizeMakeup(m) {
  const out = {};
  for (const p of MAKEUP_PARTS) {
    const v = clamp(num(m?.[p.key], 0), 0, 100);
    if (v > 0) out[p.key] = v;
    const c = hex(m?.[p.colorKey]);
    if (c || v > 0) out[p.colorKey] = c || p.color;
  }
  return out;
}

/**
 * Shader inputs of the makeup: amounts (0..1) and colors in MAKEUP_ORDER
 * (blush, eyeshadow, eyeliner, brows, contour, highlight), or null when
 * none is on.
 */
export function makeupAmounts(m) {
  if (!m) return null;
  const parts = MAKEUP_ORDER.map((k) => MAKEUP_PARTS.find((p) => p.key === k));
  const amounts = parts.map((p) => clamp((m[p.key] || 0) / 100, 0, 1));
  if (!amounts.some((x) => x > 0)) return null;
  return { amounts, colors: parts.map((p) => hex(m[p.colorKey]) || p.color) };
}

export function normalizeHairColor(hc) {
  return { color: hex(hc?.color) || HAIR_COLOR_DEFAULT.color, strength: clamp(num(hc?.strength, 0), 0, 100) };
}

export const hairColorOn = (hc) => Boolean(hc && hc.strength > 0 && hex(hc.color));

/** Which landmark and hair models a clip needs (besides the person matte). Hair is looked for around faces. */
export function faceModelsFor(clip) {
  if (!clip || clip.disabled) return { face: false, hair: false, pose: false };
  const hair = hairColorOn(clip.hairColor);
  return {
    face: Boolean(hair || skinFixAmounts(clip.retouch) || faceShapeAmounts(clip.faceShape) || makeupAmounts(clip.makeup)),
    hair,
    pose: Boolean(bodyShapeAmounts(clip.bodyShape)),
  };
}
