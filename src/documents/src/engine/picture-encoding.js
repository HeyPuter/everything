/**
 * Browser helpers between encoded picture bytes and the RGBA pixels picture-processing.js works on.
 */

/** RGBA pixels of a decoded bitmap (ImageBitmap, canvas or image). */
export function bitmapToImageData(bitmap) {
  const width = bitmap.width, height = bitmap.height;
  const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  return { data, width, height };
}

/** Decode PNG, JPEG, GIF, WebP, BMP or TIFF bytes into RGBA pixels. */
export async function decodeToImageData(bytes, mime = 'image/png') {
  if (/^image\/tiff$/i.test(mime)) {
    // Browsers other than Safari cannot decode TIFF; the engine's decoder shows the same pixels on the page.
    const { tiffInfo } = await import('./tiff-images.js'), { tiffWorker } = await import('../lib/hwp/tiff-worker.js');
    tiffInfo(bytes);
    const { pixels, width, height } = await tiffWorker(bytes);
    return { data: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height };
  }
  let bitmap;
  try { bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); }
  catch { throw new Error('The picture could not be decoded.'); }
  try { return bitmapToImageData(bitmap); } finally { bitmap.close?.(); }
}

/** Encode RGBA pixels as PNG (default) or JPEG bytes; quality 0..1 applies to JPEG. */
export async function encodeImageData(image, mime = 'image/png', quality) {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: mime, ...(quality !== undefined ? { quality } : {}) });
  return new Uint8Array(await blob.arrayBuffer());
}
