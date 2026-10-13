/**
 * Object removal on video and image clips: areas painted or boxed over an
 * unwanted object, logo or watermark are filled from the pixels around them
 * on every frame (engine/source-fx.js), in the clip's own draw, so exports
 * match the preview.
 *
 *   clip.removal = { on, feather 0..100, grain 0..100, regions: [...] }
 *
 * Regions live on the picture itself (they follow crop, flip and transform)
 * and use the mask geometry (model/masks.js): x, y center offset from the
 * middle of the source as a fraction of its size, w, h size as a fraction,
 * rotation in degrees. A region is a rectangle, or a brush painting whose
 * strokes (box units, erase strokes cut holes) cover the whole picture
 * (w = h = 1) so x, y move the painting as one piece.
 *
 * Region position is keyframable (remove<index>.x, remove<index>.y), which
 * is how a region follows a moving object, by hand or by the motion tracker.
 */
import { uid } from '../lib/ids.js';
import { normalizeMask } from './masks.js';
import { valueAt, setKey } from './keyframes.js';

export const MAX_REGIONS = 8;
export const REMOVAL_DEFAULT = Object.freeze({ on: true, feather: 30, grain: 70 });
export const REGION_TYPES = [
  { id: 'brush', label: 'Painted', icon: 'brush' },
  { id: 'rectangle', label: 'Box', icon: 'square' },
];
/** Keyframable region values. */
export const REGION_KEYED = ['x', 'y'];

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const clampN = (v, lo, hi, d) => Math.min(hi, Math.max(lo, num(v, d)));

export const regionProp = (index, key) => `remove${index}.${key}`;

/** { index, key } of a region keyframe prop, or null. */
export function parseRegionProp(prop) {
  const m = /^remove(\d+)\.(\w+)$/.exec(prop);
  return m ? { index: Number(m[1]), key: m[2] } : null;
}

/** A new region: a painting over the whole picture, or a box (fractions of the source). */
export function defaultRegion(type, box = null) {
  if (type === 'brush') return { id: uid('rg'), type: 'brush', x: 0, y: 0, w: 1, h: 1, rotation: 0, strokes: [] };
  const b = box || { x: 0, y: 0, w: 0.2, h: 0.2 };
  return { id: uid('rg'), type: 'rectangle', x: b.x, y: b.y, w: Math.max(0.002, b.w), h: Math.max(0.002, b.h), rotation: 0 };
}

/** Clean one region from a saved project, or null. */
export function normalizeRegion(raw) {
  if (!raw || typeof raw !== 'object' || !REGION_TYPES.some((t) => t.id === raw.type)) return null;
  const m = normalizeMask({ ...raw, mode: 'add', feather: 0, opacity: 1, invert: false });
  if (!m) return null;
  const id = typeof raw.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : uid('rg');
  const out = { id, type: m.type, x: m.x, y: m.y, w: m.w, h: m.h, rotation: m.rotation };
  if (m.type === 'brush') out.strokes = m.strokes;
  if (raw.hidden) out.hidden = true;
  return out;
}

/** clip.removal from a saved clip, or null when it was never used. */
export function normalizeRemoval(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const regions = Array.isArray(raw.regions) ? raw.regions.map(normalizeRegion).filter(Boolean).slice(0, MAX_REGIONS) : [];
  return {
    on: raw.on !== false,
    feather: clampN(raw.feather, 0, 100, REMOVAL_DEFAULT.feather),
    grain: clampN(raw.grain, 0, 100, REMOVAL_DEFAULT.grain),
    regions,
  };
}

/** Whether a region covers anything (an empty painting does not). */
export function regionHasShape(r) {
  if (!r || r.hidden) return false;
  return r.type === 'brush' ? (r.strokes?.length || 0) > 0 : r.w > 0 && r.h > 0;
}

/** Regions with their keyframes applied at clip-local time. */
export function evaluateRegions(clip, local) {
  const list = clip?.removal?.regions;
  if (!list?.length) return [];
  const k = clip.keyframes;
  return list.map((r, i) => {
    const out = { ...r };
    if (k) for (const key of REGION_KEYED) {
      const keys = k[regionProp(i, key)];
      if (keys?.length) out[key] = valueAt(k, regionProp(i, key), local, r[key]);
    }
    return out;
  });
}

/** Mask feather (model/masks.js units) used to rasterize regions at a removal feather. */
export const regionFeather = (feather) => (feather || 0) * 0.15;

/**
 * Render-time removal of a clip at clip-local time, or null when it is off
 * or nothing is covered: { masks (regions as add masks, feathered), grain 0..1 }.
 */
export function removalAt(clip, local) {
  const rm = clip?.removal;
  if (!rm?.on) return null;
  const masks = evaluateRegions(clip, local).filter(regionHasShape).map((r) => ({
    ...r, mode: 'add', feather: regionFeather(rm.feather), opacity: 1, invert: false,
  }));
  if (!masks.length) return null;
  return { masks, grain: (rm.grain ?? REMOVAL_DEFAULT.grain) / 100 };
}

/** Add a region (returns its index, or -1 when the clip is full). Mutates clip. */
export function addRegion(clip, region) {
  clip.removal ||= { ...REMOVAL_DEFAULT, regions: [] };
  clip.removal.regions ||= [];
  if (clip.removal.regions.length >= MAX_REGIONS) return -1;
  clip.removal.regions.push(region);
  return clip.removal.regions.length - 1;
}

/** Remove a region and its keyframes; later regions keep theirs. Mutates clip. */
export function removeRegion(clip, index) {
  const list = clip.removal?.regions;
  if (!list?.[index]) return false;
  list.splice(index, 1);
  const k = clip.keyframes;
  if (k) {
    const old = {};
    for (const prop of Object.keys(k)) {
      if (parseRegionProp(prop)) {
        old[prop] = k[prop];
        delete k[prop];
      }
    }
    for (const [prop, keys] of Object.entries(old)) {
      const { index: i, key } = parseRegionProp(prop);
      if (i < index) k[prop] = keys;
      else if (i > index) k[regionProp(i - 1, key)] = keys;
    }
  }
  return true;
}

/** Remove every region keyframe of a clip. Mutates clip. */
export function clearRegionKeys(clip, index = null) {
  const k = clip.keyframes;
  if (!k) return;
  for (const prop of Object.keys(k)) {
    const p = parseRegionProp(prop);
    if (p && (index === null || p.index === index)) delete k[prop];
  }
}

/**
 * Set region values at clip-local time: keyed values get a key at local
 * (when the playhead is on the clip), others change the region. Mutates clip.
 */
export function setRegionValues(clip, index, patch, local, tol = 0) {
  const r = clip.removal?.regions?.[index];
  if (!r) return false;
  for (const [key, value] of Object.entries(patch)) {
    const prop = regionProp(index, key);
    if (REGION_KEYED.includes(key) && clip.keyframes?.[prop]?.length && local >= 0 && local <= clip.duration) {
      setKey(clip.keyframes, prop, local, value, 'linear', tol);
    } else {
      r[key] = value;
    }
  }
  return true;
}

/**
 * Bounds of a region in fractions of the source (left, top, width, height),
 * clamped to the picture, or null when it covers nothing. Brush strokes
 * count with their width.
 */
export function regionBounds(r, aspect = 16 / 9) {
  if (!regionHasShape(r)) return null;
  let x0;
  let y0;
  let x1;
  let y1;
  if (r.type === 'brush') {
    x0 = y0 = Infinity;
    x1 = y1 = -Infinity;
    // Stroke sizes are fractions of the short side; in fractions of each side:
    const unitX = aspect >= 1 ? 1 / aspect : 1;
    const unitY = aspect >= 1 ? 1 : aspect;
    for (const s of r.strokes) {
      if (s.erase) continue;
      const rx = (s.size * unitX) / 2;
      const ry = (s.size * unitY) / 2;
      for (let i = 0; i < s.pts.length; i += 2) {
        const px = 0.5 + r.x + s.pts[i] * r.w;
        const py = 0.5 + r.y + s.pts[i + 1] * r.h;
        x0 = Math.min(x0, px - rx);
        x1 = Math.max(x1, px + rx);
        y0 = Math.min(y0, py - ry);
        y1 = Math.max(y1, py + ry);
      }
    }
    if (!Number.isFinite(x0)) return null;
  } else {
    const a = (r.rotation * Math.PI) / 180;
    const c = Math.abs(Math.cos(a));
    const s = Math.abs(Math.sin(a));
    // Rotated box extents, in fractions (the picture's aspect matters for the turn).
    const hw = (r.w * c + (r.h / aspect) * s) / 2;
    const hh = (r.w * aspect * s + r.h * c) / 2;
    x0 = 0.5 + r.x - hw;
    x1 = 0.5 + r.x + hw;
    y0 = 0.5 + r.y - hh;
    y1 = 0.5 + r.y + hh;
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(1, x1);
  y1 = Math.min(1, y1);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Position keys that make a region follow tracked points. points:
 * [{ t (clip-local µs), x, y (center, fractions of the source) }]; the
 * region keeps its offset from the object at clip-local time t0.
 */
export function followKeys(region, points, t0, thin = null) {
  if (!points.length) return null;
  const ref = points.reduce((best, p) => (Math.abs(p.t - t0) < Math.abs(best.t - t0) ? p : best), points[0]);
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const q = (v) => Math.round(v * 1e5) / 1e5;
  let x = sorted.map((p) => ({ t: Math.round(p.t), v: q(region.x + p.x - ref.x), ease: 'linear' }));
  let y = sorted.map((p) => ({ t: Math.round(p.t), v: q(region.y + p.y - ref.y), ease: 'linear' }));
  if (thin) {
    x = thin(x);
    y = thin(y);
  }
  return { x, y };
}

/** Whether a removal does anything at all (some visible region with a shape). */
export function removalActive(rm) {
  return Boolean(rm?.on && rm.regions?.some(regionHasShape));
}
