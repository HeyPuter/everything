/**
 * Encode RGBA ImageData to JPEG via OffscreenCanvas / canvas when available.
 * Falls back to a tiny embedded JPEG for tests without a canvas.
 */

const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z';

function decodeBase64(b64) {
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(b64, 'base64'));
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const TINY_JPEG = decodeBase64(TINY_JPEG_B64);

export async function rgbaToJpeg(rgba, width, height, quality = 0.92) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imageData = new ImageData(rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba), width, height);
    ctx.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = new ImageData(rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba), width, height);
    ctx.putImageData(imageData, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    return new Uint8Array(await blob.arrayBuffer());
  }
  // Node/unit tests without canvas: return a valid tiny JPEG placeholder.
  return TINY_JPEG.slice();
}

export { TINY_JPEG };
