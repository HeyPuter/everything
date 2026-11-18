/** A retained source frame keeps masks editable when a picture's crop is baked. */
const ZERO = { l: 0, t: 0, r: 0, b: 0 };

export function normalizeMaskSpace(raw) {
  if (!raw || !Number.isFinite(raw.width) || !Number.isFinite(raw.height) || raw.width <= 0 || raw.height <= 0) return null;
  const crop = { ...ZERO, ...raw.crop };
  if (Object.values(crop).some(v => !Number.isFinite(v) || v < 0 || v >= 1) || crop.l + crop.r >= 1 || crop.t + crop.b >= 1) return null;
  return { width: raw.width, height: raw.height, crop: { l: crop.l, t: crop.t, r: crop.r, b: crop.b } };
}

/** A crop within a source window, expressed in that window's original frame. */
export function composeMaskCrop(outer, inner) {
  const a = outer || ZERO, b = inner || ZERO;
  const w = 1 - a.l - a.r, h = 1 - a.t - a.b;
  return { l: a.l + b.l * w, r: a.r + b.r * w, t: a.t + b.t * h, b: a.b + b.b * h };
}

/** Capture metadata supplies the coordinate frame, so reusing a result is idempotent. */
export function retainMaskSpace(clip, source, crop) {
  if (!clip.masks?.length || !source || !crop || !Object.values(crop).some(v => v !== 0)) return;
  const frame = source.maskSpace || { width: source.width, height: source.height, crop: ZERO };
  const space = normalizeMaskSpace({ ...frame, crop: composeMaskCrop(frame.crop, crop) });
  if (space) clip.maskSpace = space;
}

/** Layer geometry as seen by masks; image placement still uses the actual asset. */
export function maskLayer(layer) {
  const space = layer.maskSpace;
  return space ? { ...layer, width: space.width, height: space.height, crop: composeMaskCrop(space.crop, layer.crop) } : layer;
}

/** Place a newly created, unrotated default mask in the current source window. */
export function defaultMaskInSpace(mask, space) {
  if (!space) return mask;
  const c = space.crop, w = 1 - c.l - c.r, h = 1 - c.t - c.b;
  return { ...mask, x: c.l + (mask.x + 0.5) * w - 0.5, y: c.t + (mask.y + 0.5) * h - 0.5, w: mask.w * w, h: mask.h * h };
}
