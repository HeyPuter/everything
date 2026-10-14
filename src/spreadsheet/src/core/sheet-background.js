/** A sheet's background picture (Page Layout ▸ Background), tiled behind its cells on screen and never printed. */

/** The largest background picture kept, decoded: pictures are embedded in the workbook. */
export const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;

/** A background as the model keeps it, { src } with a PNG, JPEG, GIF or BMP data URL, or null. */
export function normalizeBackground(raw) {
  const src = typeof raw === 'string' ? raw : raw?.src;
  if (typeof src !== 'string' || src.length > MAX_BACKGROUND_BYTES * 1.4) return null;
  return /^data:image\/(png|jpeg|gif|bmp);base64,[a-z0-9+/=\s]+$/i.test(src) ? { src } : null;
}
