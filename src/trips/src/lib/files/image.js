// Browser image work: decoding (including HEIC where the platform can), thumbnails and re-encoding.
export const THUMB_SIZE = 320;
export const THUMB_MAX_BYTES = 256 * 1024;
export const COVER_SIZE = 1600;
// Safari refuses canvases above about 16.7 million pixels.
const MAX_PIXELS = 16_000_000;

/** Fits `width × height` inside `max` on the longest side and under the pixel cap, never upscaling. */
export function fitSize(width, height, max = Infinity, maxPixels = MAX_PIXELS) {
  if (!(width > 0) || !(height > 0)) return null;
  let scale = Math.min(1, max / Math.max(width, height));
  const capped = width * height * scale * scale > maxPixels;
  if (capped) scale = Math.sqrt(maxPixels / (width * height));
  const size = capped ? Math.floor : Math.round;
  return { width: Math.max(1, size(width * scale)), height: Math.max(1, size(height * scale)) };
}

/** Decodes an image Blob with the platform decoder (orientation applied), or null when it cannot. */
export async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* try an <img> */ }
  }
  if (typeof Image !== 'function' || typeof URL?.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image.naturalWidth > 0 ? image : null;
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

const sizeOf = (image) => ({ width: image.naturalWidth ?? image.width, height: image.naturalHeight ?? image.height });

function canvasFor(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  return Object.assign(document.createElement('canvas'), { width, height });
}

async function encode(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Draws a decoded image at `max` and encodes it; returns null when the browser cannot. Types fall back in order. */
export async function render(image, { max = Infinity, types = ['image/webp', 'image/jpeg'], quality = 0.82 } = {}) {
  const { width, height } = sizeOf(image);
  const size = fitSize(width, height, max);
  if (!size) return null;
  const canvas = canvasFor(size.width, size.height);
  const context = canvas?.getContext('2d');
  if (!context) return null;
  let opaque = false;
  const draw = (fill) => {
    context.clearRect(0, 0, size.width, size.height);
    // JPEG has no alpha; transparent pixels would turn black.
    if (fill) { context.fillStyle = 'white'; context.fillRect(0, 0, size.width, size.height); }
    context.drawImage(image, 0, 0, size.width, size.height);
  };
  draw(false);
  for (const type of types) {
    if (type === 'image/jpeg' && !opaque) { draw(true); opaque = true; }
    try {
      const blob = await encode(canvas, type, quality);
      // Browsers that cannot encode a type silently return PNG.
      if (blob && blob.type === type) return { blob, ...size };
    } catch { /* next type */ }
  }
  return null;
}

/** A WebP (or JPEG) thumbnail of at most 320 px and 256 KB, or null. */
export async function makeThumbnail(blob) {
  const image = await decodeImage(blob);
  if (!image) return null;
  try {
    for (const quality of [0.8, 0.6]) {
      const result = await render(image, { max: THUMB_SIZE, quality });
      if (result && result.blob.size <= THUMB_MAX_BYTES) return result.blob;
    }
    return null;
  } finally { image.close?.(); }
}

/** Re-encodes HEIC as JPEG when this browser can decode it; null means keep the original. */
export async function convertHeic(blob) {
  const image = await decodeImage(blob);
  if (!image) return null;
  try { return (await render(image, { types: ['image/jpeg'], quality: 0.9 }))?.blob ?? null; } finally { image.close?.(); }
}

/** A cover-sized JPEG, or null when the image cannot be decoded here. */
export async function coverImage(blob) {
  const image = await decodeImage(blob);
  if (!image) return null;
  try { return (await render(image, { max: COVER_SIZE, types: ['image/jpeg'], quality: 0.85 }))?.blob ?? null; } finally { image.close?.(); }
}
