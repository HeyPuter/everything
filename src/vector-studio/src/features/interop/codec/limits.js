/**
 * Size limits for decoding untrusted files. Images larger than this are
 * not decoded: their pixels (and the working buffers decoding needs)
 * would exhaust the tab's memory. 2^27 pixels is about 11,500 x 11,500.
 */
export const MAX_IMAGE_PIXELS = 1 << 27;

/** True when width x height pixels may be decoded. */
export function imageSizeOk(width, height) {
  return width > 0 && height > 0 && width * height <= MAX_IMAGE_PIXELS;
}
