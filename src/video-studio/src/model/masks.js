/**
 * Clip masks. A video or image clip carries up to MAX_MASKS masks in
 * clip.masks, combined in order: each mask adds to, subtracts from or
 * intersects with what the masks before it let through.
 *
 * Masks live on the picture itself (they follow crop, flip and transform):
 *   x, y      center offset from the middle of the full source frame, as a
 *             fraction of its width and height (y grows downward)
 *   w, h      size as a fraction of the source width and height
 *   rotation  degrees, clockwise
 *   feather   0..100 (soft edge), opacity 0..1, invert
 * Shape extras: roundness (rectangle, 0..100), count (star points, polygon
 * sides), inner (star inner radius 0..1), text/font/bold (text), path (pen:
 * closed bezier path in box units -0.5..0.5 with in/out handle offsets) and
 * strokes (brush: painted strokes in box units).
 *
 * Position, size, rotation, feather and opacity are keyframable with prop
 * names mask<index>.<key> (mask0.x, mask1.feather, ...).
 */
import { uid } from '../lib/ids.js';
import { valueAt, setKey } from './keyframes.js';

export const MAX_MASKS = 4;

export const MASK_SHAPES = [
  { id: 'split', label: 'Split', icon: 'maskSplit' },
  { id: 'band', label: 'Band', icon: 'maskBand' },
  { id: 'ellipse', label: 'Ellipse', icon: 'circle' },
  { id: 'rectangle', label: 'Rectangle', icon: 'square' },
  { id: 'star', label: 'Star', icon: 'star' },
  { id: 'heart', label: 'Heart', icon: 'heart' },
  { id: 'polygon', label: 'Polygon', icon: 'hexagon' },
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'pen', label: 'Pen', icon: 'penTool' },
  { id: 'brush', label: 'Brush', icon: 'brush' },
];

export const MASK_MODES = [
  { id: 'add', label: 'Add', hint: 'Show this area too' },
  { id: 'subtract', label: 'Subtract', hint: 'Hide this area' },
  { id: 'intersect', label: 'Intersect', hint: 'Keep only where this overlaps' },
];

/** Keyframable mask values. */
export const MASK_KEYED = ['x', 'y', 'w', 'h', 'rotation', 'feather', 'opacity'];

const TYPES = new Set(MASK_SHAPES.map((s) => s.id));
const MODES = new Set(MASK_MODES.map((m) => m.id));
/** Older single-mask ids and names. */
const LEGACY_TYPES = { linear: 'split', edge: 'split', mirror: 'band', circle: 'ellipse', ellipse: 'ellipse', rectangle: 'rectangle', band: 'band', split: 'split' };

const MAX_PATH_POINTS = 256;
const MAX_STROKES = 400;
const MAX_STROKE_COORDS = 4000;

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const clampN = (v, lo, hi, d) => Math.min(hi, Math.max(lo, num(v, d)));
const q = (v) => Math.round(v * 10000) / 10000;

export const maskProp = (index, key) => `mask${index}.${key}`;

/** { index, key } of a mask keyframe prop, or null. */
export function parseMaskProp(prop) {
  const m = /^mask(\d+)\.(\w+)$/.exec(prop);
  return m ? { index: Number(m[1]), key: m[2] } : null;
}

/**
 * A new mask of a shape. aspect is the source width / height so round
 * shapes start round.
 */
export function defaultMask(type, aspect = 16 / 9) {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  // A square of half the short side, in fractions of each side.
  const sq = (k) => (a >= 1 ? { w: k / a, h: k } : { w: k, h: k * a });
  const base = { id: uid('m'), type, mode: 'add', x: 0, y: 0, w: 0.5, h: 0.5, rotation: 0, feather: 0, opacity: 1, invert: false };
  switch (type) {
    case 'split': return { ...base, w: 1, h: 1 };
    case 'band': return { ...base, w: 1, h: 0.3 };
    case 'ellipse': return { ...base, ...sq(0.6) };
    case 'rectangle': return { ...base, w: 0.6, h: 0.6, roundness: 0 };
    case 'star': return { ...base, ...sq(0.6), count: 5, inner: 0.45 };
    case 'heart': return { ...base, ...sq(0.6) };
    case 'polygon': return { ...base, ...sq(0.6), count: 6 };
    case 'text': return { ...base, w: 0.8, h: 0.4, text: 'TEXT', font: 'Anton', bold: false };
    case 'pen': return { ...base, w: 1, h: 1, path: [] };
    case 'brush': return { ...base, w: 1, h: 1, strokes: [] };
    default: return null;
  }
}

function normPath(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_PATH_POINTS).filter((p) => p && typeof p === 'object').map((p) => ({
    x: q(clampN(p.x, -50, 50, 0)),
    y: q(clampN(p.y, -50, 50, 0)),
    ix: q(clampN(p.ix, -50, 50, 0)),
    iy: q(clampN(p.iy, -50, 50, 0)),
    ox: q(clampN(p.ox, -50, 50, 0)),
    oy: q(clampN(p.oy, -50, 50, 0)),
  }));
}

function normStrokes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, MAX_STROKES)) {
    if (!s || !Array.isArray(s.pts)) continue;
    const pts = s.pts.slice(0, MAX_STROKE_COORDS - (MAX_STROKE_COORDS % 2)).map((v) => q(clampN(v, -50, 50, 0)));
    if (pts.length % 2) pts.pop();
    if (pts.length < 2) continue;
    out.push({ size: clampN(s.size, 0.001, 1, 0.05), erase: Boolean(s.erase), pts });
  }
  return out;
}

/** Clean one mask from a saved project, or null when it is not a mask. */
export function normalizeMask(raw) {
  if (!raw || typeof raw !== 'object' || !TYPES.has(raw.type)) return null;
  const d = defaultMask(raw.type);
  const out = {
    id: typeof raw.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : d.id,
    type: raw.type,
    mode: MODES.has(raw.mode) ? raw.mode : 'add',
    x: clampN(raw.x, -10, 10, 0),
    y: clampN(raw.y, -10, 10, 0),
    w: clampN(raw.w, 0.001, 20, d.w),
    h: clampN(raw.h, 0.001, 20, d.h),
    rotation: clampN(raw.rotation, -36000, 36000, 0),
    feather: clampN(raw.feather, 0, 100, 0),
    opacity: clampN(raw.opacity, 0, 1, 1),
    invert: Boolean(raw.invert),
  };
  if (raw.hidden) out.hidden = true;
  if (raw.type === 'rectangle') out.roundness = clampN(raw.roundness, 0, 100, 0);
  if (raw.type === 'star') {
    out.count = Math.round(clampN(raw.count, 3, 24, 5));
    out.inner = clampN(raw.inner, 0.05, 0.95, 0.45);
  }
  if (raw.type === 'polygon') out.count = Math.round(clampN(raw.count, 3, 24, 6));
  if (raw.type === 'text') {
    out.text = typeof raw.text === 'string' ? raw.text.slice(0, 200) : d.text;
    out.font = typeof raw.font === 'string' && raw.font ? raw.font.slice(0, 80) : d.font;
    out.bold = Boolean(raw.bold);
  }
  if (raw.type === 'pen') out.path = normPath(raw.path);
  if (raw.type === 'brush') out.strokes = normStrokes(raw.strokes);
  return out;
}

/**
 * Convert the old single clip.mask (positions in the cropped box as shown on
 * screen) to the picture-relative model.
 */
export function migrateLegacyMask(old, crop, transform) {
  const type = LEGACY_TYPES[old?.type];
  if (!type) return null;
  const c = { l: num(crop?.l), t: num(crop?.t), r: num(crop?.r), b: num(crop?.b) };
  const cw = Math.max(0.05, 1 - c.l - c.r);
  const ch = Math.max(0.05, 1 - c.t - c.b);
  let bx = 0.5 + num(old.x);
  let by = 0.5 + num(old.y);
  // The old mask stayed on screen while the picture flipped under it.
  if (transform?.flipH) bx = 1 - bx;
  if (transform?.flipV) by = 1 - by;
  // The old shader turned masks counterclockwise for positive angles.
  let rotation = -num(old.rotation);
  if (Boolean(transform?.flipH) !== Boolean(transform?.flipV)) rotation = -rotation;
  const legacyW = old.w ?? (type === 'band' ? 1 : 0.5);
  const legacyH = old.h ?? (type === 'band' ? 0.3 : 0.5);
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  return normalizeMask({
    ...defaultMask(type),
    x: r6(c.l + bx * cw - 0.5),
    y: r6(c.t + by * ch - 0.5),
    w: r6(type === 'split' ? 1 : legacyW * cw),
    h: r6(type === 'split' ? 1 : legacyH * ch),
    rotation,
    feather: num(old.feather),
    invert: Boolean(old.invert),
  });
}

/** clip.masks from a saved clip: the list, or the old single mask migrated. */
export function normalizeMasks(raw) {
  if (Array.isArray(raw?.masks)) return raw.masks.map(normalizeMask).filter(Boolean).slice(0, MAX_MASKS);
  if (raw?.mask && typeof raw.mask === 'object') {
    const m = migrateLegacyMask(raw.mask, raw.crop, raw.transform);
    return m ? [m] : [];
  }
  return [];
}

/** Masks with their keyframes applied at clip-local time (hidden ones kept, flagged). */
export function evaluateMasks(clip, local) {
  const list = clip?.masks;
  if (!list?.length) return [];
  const k = clip.keyframes;
  return list.map((m, i) => {
    const out = { ...m };
    if (k) for (const key of MASK_KEYED) {
      const keys = k[maskProp(i, key)];
      if (keys?.length) out[key] = valueAt(k, maskProp(i, key), local, m[key]);
    }
    return out;
  });
}

/** Whether a mask has any shape to draw (an empty pen path or brush does nothing). */
export function maskHasShape(m) {
  if (!m || m.hidden) return false;
  if (m.type === 'pen') return (m.path?.length || 0) >= 3;
  if (m.type === 'brush') return (m.strokes?.length || 0) > 0;
  if (m.type === 'text') return Boolean(m.text?.trim());
  return true;
}

/**
 * Combined coverage of a point: entries are [{ value (shape coverage 0..1),
 * mode, invert, opacity }] in mask order. The first mask starts from nothing
 * (or from everything when it subtracts). Mirrors the rasterizer's
 * compositing: add = union, subtract = cut out, intersect = keep overlap.
 */
export function combineCoverage(entries) {
  if (!entries.length) return 1;
  let acc = entries[0].mode === 'subtract' ? 1 : 0;
  entries.forEach((e, i) => {
    const m = (e.invert ? 1 - e.value : e.value) * (e.opacity ?? 1);
    const mode = i === 0 && e.mode === 'intersect' ? 'add' : e.mode;
    if (mode === 'subtract') acc *= 1 - m;
    else if (mode === 'intersect') acc *= m;
    else acc = acc + m - acc * m;
  });
  return acc;
}

/**
 * Set mask values at clip-local time: keyed values get a key at local (when
 * the playhead is on the clip), others change the mask itself. Mutates clip.
 */
export function setMaskValues(clip, index, patch, local, tol = 0) {
  const m = clip.masks?.[index];
  if (!m) return false;
  for (const [key, value] of Object.entries(patch)) {
    const prop = maskProp(index, key);
    if (MASK_KEYED.includes(key) && clip.keyframes?.[prop]?.length && local >= 0 && local <= clip.duration) {
      setKey(clip.keyframes, prop, local, value, 'linear', tol);
    } else {
      m[key] = value;
    }
  }
  return true;
}

/** Rename mask keyframe props after the list changed. order[newIndex] = oldIndex. Mutates clip. */
function remapMaskKeys(clip, order) {
  const k = clip.keyframes;
  if (!k) return;
  const old = {};
  for (const prop of Object.keys(k)) {
    if (parseMaskProp(prop)) {
      old[prop] = k[prop];
      delete k[prop];
    }
  }
  order.forEach((from, to) => {
    for (const key of MASK_KEYED) {
      const keys = old[maskProp(from, key)];
      if (keys) k[maskProp(to, key)] = keys;
    }
  });
}

/** Add a mask (returns its index, or -1 when the clip is full). Mutates clip. */
export function addMask(clip, mask) {
  if (!clip.masks?.length) delete clip.maskSpace;
  clip.masks ||= [];
  if (clip.masks.length >= MAX_MASKS) return -1;
  clip.masks.push(mask);
  return clip.masks.length - 1;
}

/** Remove a mask and its keyframes; later masks keep theirs. Mutates clip. */
export function removeMask(clip, index) {
  if (!clip.masks?.[index]) return false;
  const order = clip.masks.map((_, i) => i).filter((i) => i !== index);
  clip.masks.splice(index, 1);
  remapMaskKeys(clip, order);
  if (!clip.masks.length) { delete clip.masks; delete clip.maskSpace; }
  return true;
}

/** Move a mask to another position in the stack. Mutates clip. */
export function moveMask(clip, from, to) {
  const list = clip.masks;
  if (!list?.[from] || to < 0 || to >= list.length || from === to) return false;
  const order = list.map((_, i) => i);
  order.splice(to, 0, order.splice(from, 1)[0]);
  const [m] = list.splice(from, 1);
  list.splice(to, 0, m);
  remapMaskKeys(clip, order);
  return true;
}

/** Copy of a mask with a fresh id (duplicate). */
export function cloneMask(m) {
  return { ...structuredClone(m), id: uid('m') };
}

/** Change a mask's shape, keeping where it is and how it combines. */
export function changeMaskType(m, type, aspect) {
  const next = defaultMask(type, aspect);
  if (!next) return m;
  const keep = { id: m.id, mode: m.mode, x: m.x, y: m.y, rotation: m.rotation, feather: m.feather, opacity: m.opacity, invert: m.invert };
  // Box shapes keep their size; lines, paths and paintings start fresh.
  const boxy = (t) => !['split', 'band', 'pen', 'brush'].includes(t);
  if (boxy(m.type) && boxy(type)) Object.assign(keep, { w: m.w, h: m.h });
  if (m.hidden) keep.hidden = true;
  return { ...next, ...keep };
}

/**
 * Pen mask whose box is fitted to its path (same shape on screen), so the
 * box handles hug the drawing. SW, SH: source size in pixels.
 */
export function fitPathBox(m, SW, SH) {
  const path = m.path || [];
  if (path.length < 2) return m;
  const xs = path.flatMap((p) => [p.x, p.x + (p.ix || 0), p.x + (p.ox || 0)]);
  const ys = path.flatMap((p) => [p.y, p.y + (p.iy || 0), p.y + (p.oy || 0)]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const wu = Math.max(1e-4, x1 - x0);
  const hu = Math.max(1e-4, y1 - y0);
  const cu = [(x0 + x1) / 2, (y0 + y1) / 2];
  // Center shift in mask-local pixels, turned into the source frame.
  const lx = cu[0] * m.w * SW;
  const ly = cu[1] * m.h * SH;
  const r = ((m.rotation || 0) * Math.PI) / 180;
  const dx = lx * Math.cos(r) - ly * Math.sin(r);
  const dy = lx * Math.sin(r) + ly * Math.cos(r);
  return {
    ...m,
    x: m.x + dx / SW,
    y: m.y + dy / SH,
    w: m.w * wu,
    h: m.h * hu,
    path: path.map((p) => ({
      x: (p.x - cu[0]) / wu, y: (p.y - cu[1]) / hu, ix: (p.ix || 0) / wu, iy: (p.iy || 0) / hu, ox: (p.ox || 0) / wu, oy: (p.oy || 0) / hu,
    })),
  };
}
