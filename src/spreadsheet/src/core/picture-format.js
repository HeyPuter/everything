/**
 * The Picture Format tab's model for a floating picture: its crop, its corrections (brightness and
 * contrast), grayscale, transparency, its style (outline, shape and shadow), its size with or
 * without its proportions locked, and resetting all of that. Pure functions over the picture
 * object, so the ribbon, the crop dialog, the grid, print and the file all read the same values.
 *
 * Fields on an image object (all optional):
 *   srcRect     { l, t, r, b }  the crop, as fractions of the source cut from each side (DrawingML a:srcRect)
 *   adjust      { brightness, contrast }  each -1..1 (DrawingML a:lum bright/contrast)
 *   recolor     'grayscale'
 *   transparency 0..1  (DrawingML a:alphaModFix)
 *   outline     { width, color }  a frame drawn around the picture, width in pixels
 *   shape       'roundRect' | 'ellipse'  the outline of the picture (rectangle when absent)
 *   shadow      true  a soft drop shadow
 *   lockAspect  false  when resizing may change the picture's proportions
 */
import { pictureRect } from './picture-geometry.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n, places = 4) => Math.round(n * 10 ** places) / 10 ** places;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
export const CROP_MIN = 0.02;

/* ---------- Normalization ---------- */

const HEX = /^#[0-9a-f]{6}$/i;
/** The Picture Format fields of a raw object, cleaned; spread into a normalized image. */
export function normalizePictureFormat(raw) {
  const out = {};
  const b = finite(raw?.adjust?.brightness) ? round(clamp(raw.adjust.brightness, -1, 1)) : 0;
  const c = finite(raw?.adjust?.contrast) ? round(clamp(raw.adjust.contrast, -1, 1)) : 0;
  if (b || c) out.adjust = { brightness: b, contrast: c };
  if (raw?.recolor === 'grayscale') out.recolor = 'grayscale';
  if (finite(raw?.transparency) && raw.transparency > 0) out.transparency = round(clamp(raw.transparency, 0, 1), 3);
  if (raw?.outline && finite(raw.outline.width) && raw.outline.width > 0 && HEX.test(raw.outline.color || '')) {
    out.outline = { width: round(clamp(raw.outline.width, 0.25, 64), 2), color: raw.outline.color.toLowerCase() };
  }
  if (['roundRect', 'ellipse'].includes(raw?.shape)) out.shape = raw.shape;
  if (raw?.shadow === true) out.shadow = true;
  if (raw?.lockAspect === false) out.lockAspect = false;
  return out;
}

/** Is the picture drawn exactly as its source (nothing a raster copy has to apply)? */
export function pictureIsPlain(obj) {
  return !obj?.srcRect && !obj?.fillRect && !obj?.rotation && !obj?.flipH && !obj?.flipV
    && !obj?.adjust && !obj?.recolor && !obj?.transparency;
}

/* ---------- Crop ---------- */

/** The crop as a rectangle of the source picture, in fractions: { x, y, w, h }. */
export function cropOf(obj) {
  const s = obj?.srcRect || {};
  const x = s.l || 0, y = s.t || 0;
  return { x, y, w: 1 - x - (s.r || 0), h: 1 - y - (s.b || 0) };
}

/** The size the whole (uncropped) picture is shown at, in sheet pixels. */
export function uncroppedSize(obj) {
  const crop = cropOf(obj);
  return { w: obj.w / (crop.w > 0 ? crop.w : 1), h: obj.h / (crop.h > 0 ? crop.h : 1) };
}

/** A crop rectangle kept within the picture and at least CROP_MIN of it across and down. */
export function clampCrop(crop) {
  // Six places is far finer than a pixel of any picture, and keeps 0.2 from reading 0.19999999999999996.
  const w = round(clamp(finite(crop.w) ? crop.w : 1, CROP_MIN, 1), 6), h = round(clamp(finite(crop.h) ? crop.h : 1, CROP_MIN, 1), 6);
  return { x: round(clamp(finite(crop.x) ? crop.x : 0, 0, 1 - w), 6), y: round(clamp(finite(crop.y) ? crop.y : 0, 0, 1 - h), 6), w, h };
}

/**
 * The patch that crops a picture to `crop` (fractions of its source): the visible part keeps the
 * scale it is shown at and stays where it lies on the sheet, so cropping cuts the sides away
 * rather than stretching what is left. A crop of the whole picture removes the crop.
 */
export function cropPatch(obj, next) {
  const crop = clampCrop(next), was = cropOf(obj), full = uncroppedSize(obj);
  const l = round(crop.x), t = round(crop.y), r = round(1 - crop.x - crop.w), b = round(1 - crop.y - crop.h);
  const srcRect = pictureRect({ l, t, r, b });
  return {
    srcRect, fillRect: null,
    w: Math.max(1, Math.round(full.w * crop.w)), h: Math.max(1, Math.round(full.h * crop.h)),
    dx: Math.round(((obj.dx || 0) + (crop.x - was.x) * full.w) * 100) / 100,
    dy: Math.round(((obj.dy || 0) + (crop.y - was.y) * full.h) * 100) / 100,
  };
}

/** The aspect ratios Crop offers, width over height. */
export const CROP_ASPECTS = [
  ['Square', '1:1', 1], ['Landscape', '4:3', 4 / 3], ['Landscape', '3:2', 3 / 2], ['Landscape', '16:9', 16 / 9], ['Landscape', '16:10', 16 / 10],
  ['Portrait', '3:4', 3 / 4], ['Portrait', '2:3', 2 / 3], ['Portrait', '9:16', 9 / 16],
];

/**
 * The largest crop of the picture with `ratio` (shown width over height) about the centre of the
 * current crop: what choosing an aspect ratio under Crop does.
 */
export function aspectCrop(obj, ratio) {
  const full = uncroppedSize(obj), was = cropOf(obj);
  if (!(ratio > 0) || !(full.w > 0) || !(full.h > 0)) return was;
  let w = full.w, h = full.w / ratio;
  if (h > full.h) { h = full.h; w = full.h * ratio; }
  const cw = w / full.w, ch = h / full.h;
  const cx = was.x + was.w / 2, cy = was.y + was.h / 2;
  return clampCrop({ x: cx - cw / 2, y: cy - ch / 2, w: cw, h: ch });
}

/**
 * Drag one of the crop's handles ('n', 's', 'e', 'w', the corners such as 'ne', or 'move' for the
 * whole rectangle) by `dx`, `dy` fractions of the picture. With `ratio` (the shown width over height,
 * and `full` the picture's shown size) a corner keeps the crop's proportions.
 */
export function dragCrop(crop, handle, dx, dy, { ratio = null, full = null } = {}) {
  let { x, y, w, h } = crop;
  if (handle === 'move') return clampCrop({ x: x + dx, y: y + dy, w, h });
  let x2 = x + w, y2 = y + h;
  if (handle.includes('w')) x = clamp(x + dx, 0, x2 - CROP_MIN);
  if (handle.includes('e')) x2 = clamp(x2 + dx, x + CROP_MIN, 1);
  if (handle.includes('n')) y = clamp(y + dy, 0, y2 - CROP_MIN);
  if (handle.includes('s')) y2 = clamp(y2 + dy, y + CROP_MIN, 1);
  w = x2 - x; h = y2 - y;
  if (ratio > 0 && full?.w > 0 && full?.h > 0 && handle.length === 2) {
    // Keep the proportion by the side that moved most; the opposite corner stays put.
    const k = full.h / full.w * ratio; // fractions: w = h * k
    if (Math.abs(dx) >= Math.abs(dy)) h = w / k; else w = h * k;
    if (handle.includes('n')) y = y2 - h;
    if (handle.includes('w')) x = x2 - w;
    if (x < 0 || y < 0 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9 || w < CROP_MIN || h < CROP_MIN) return crop;
  }
  return clampCrop({ x, y, w, h });
}

/* ---------- Corrections, color and transparency ---------- */

/** The tone curve a correction applies to each colour channel (0..1): out = in * slope + intercept. */
export function toneCurve(adjust) {
  const b = adjust?.brightness || 0, c = adjust?.contrast || 0;
  const slope = c >= 0 ? 1 / Math.max(0.01, 1 - c) : 1 + c;
  return { slope, intercept: 0.5 - 0.5 * slope + b };
}

/** Brightness and contrast choices the Corrections gallery offers, in steps of 20%. */
export const CORRECTION_STEPS = [-0.4, -0.2, 0, 0.2, 0.4];

/** Transparency choices, as fractions. */
export const TRANSPARENCY_STEPS = [0, 0.15, 0.3, 0.5, 0.65, 0.8, 0.95];

/** A short label for a percentage: +20%, -40%, 0% (Normal). */
export const percent = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.round(Math.abs(n) * 100)}%`;

/**
 * Apply corrections, grayscale and transparency to RGBA pixel data in place (a canvas's ImageData),
 * as the sheet draws them: used when a picture is copied or placed in a cell as a bitmap.
 */
export function applyPictureFilter(data, obj) {
  const curve = obj?.adjust ? toneCurve(obj.adjust) : null;
  const gray = obj?.recolor === 'grayscale';
  const alpha = obj?.transparency ? 1 - obj.transparency : 1;
  if (!curve && !gray && alpha === 1) return data;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    if (gray) r = g = b = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (curve) {
      const f = (v) => clamp((v / 255 * curve.slope + curve.intercept) * 255, 0, 255);
      r = f(r); g = f(g); b = f(b);
    }
    data[i] = Math.round(r); data[i + 1] = Math.round(g); data[i + 2] = Math.round(b);
    if (alpha !== 1) data[i + 3] = Math.round(data[i + 3] * alpha);
  }
  return data;
}

/* ---------- Picture styles ---------- */

/** The Picture Styles gallery: each a patch of outline, shape and shadow. */
export const PICTURE_STYLES = [
  { id: 'none', label: 'No Style', patch: { outline: null, shape: null, shadow: false } },
  { id: 'whiteFrame', label: 'White Frame', patch: { outline: { width: 6, color: '#ffffff' }, shape: null, shadow: true } },
  { id: 'blackFrame', label: 'Black Frame', patch: { outline: { width: 6, color: '#1f1f1f' }, shape: null, shadow: false } },
  { id: 'thinBorder', label: 'Thin Border', patch: { outline: { width: 1.5, color: '#7f7f7f' }, shape: null, shadow: false } },
  { id: 'dropShadow', label: 'Drop Shadow', patch: { outline: null, shape: null, shadow: true } },
  { id: 'rounded', label: 'Rounded Corners', patch: { outline: null, shape: 'roundRect', shadow: false } },
  { id: 'roundedFrame', label: 'Rounded Frame', patch: { outline: { width: 4, color: '#ffffff' }, shape: 'roundRect', shadow: true } },
  { id: 'oval', label: 'Oval', patch: { outline: null, shape: 'ellipse', shadow: false } },
];

const sameOutline = (a, b) => (!a && !b) || (!!a && !!b && a.width === b.width && a.color === b.color);
/** Which gallery style the picture wears now, if any. */
export function pictureStyleOf(obj) {
  return PICTURE_STYLES.find(({ patch }) => sameOutline(obj?.outline || null, patch.outline) && (obj?.shape || null) === patch.shape
    && !!obj?.shadow === patch.shadow)?.id || null;
}

/** The corner radius a rounded picture takes, in pixels of its shown size. */
export const roundedRadius = (w, h) => Math.round(Math.min(w, h) * 0.12 * 100) / 100;

/** CSS for the frame of a styled picture on the sheet or in print, at `scale` (the zoom). */
export function pictureFrameCss(obj, scale = 1) {
  const css = {};
  if (obj?.outline) css.border = `${Math.max(0.5, obj.outline.width * scale)}px solid ${obj.outline.color}`;
  if (obj?.shape === 'ellipse') css.borderRadius = '50%';
  else if (obj?.shape === 'roundRect') css.borderRadius = `${roundedRadius(obj.w, obj.h) * scale}px`;
  if (obj?.shadow) css.boxShadow = `${3 * scale}px ${4 * scale}px ${10 * scale}px rgba(0, 0, 0, .38)`;
  return css;
}

/** Does the picture wear a style of its own (and so no plain frame from the sheet)? */
export const pictureStyled = (obj) => !!(obj?.outline || obj?.shape || obj?.shadow);

/* ---------- Size and reset ---------- */

/**
 * New width and height for a picture, from a width or a height typed in pixels: with its
 * proportions locked (the default) the other side follows.
 */
export function sizePatch(obj, { w, h }) {
  const locked = obj.lockAspect !== false, ratio = obj.w / obj.h;
  let nw = finite(w) && w > 0 ? w : obj.w, nh = finite(h) && h > 0 ? h : obj.h;
  if (locked && ratio > 0) {
    if (finite(w) && w > 0 && !(finite(h) && h > 0)) nh = nw / ratio;
    else if (finite(h) && h > 0 && !(finite(w) && w > 0)) nw = nh * ratio;
  }
  return { w: Math.max(1, Math.round(nw)), h: Math.max(1, Math.round(nh)) };
}

/** Reset Picture: the corrections, colour, transparency and style undone; the crop and size kept. */
export const RESET_PICTURE = { adjust: null, recolor: null, transparency: null, outline: null, shape: null, shadow: false };

/** Reset Picture & Size: as Reset Picture, and the crop, turn and flips gone, at `size` (as inserted). */
export function resetPictureAndSize(size) {
  return { ...RESET_PICTURE, srcRect: null, fillRect: null, rotation: 0, flipH: false, flipV: false, w: size.w, h: size.h };
}
