import { paintImage, paintDisplayImage } from './paint-image.js';
import { decodePictureEffects } from './picture-luminance.js';
import { isTiff, tiffInfo, decodeTiffImage, TIFF_MIME } from './tiff-images.js';
import { EMF_MIME, emfInfo, decodeEmf } from './emf-images.js';
import { WMF_MIME, wmfInfo, decodeWmf } from './wmf-images.js';
import { svgInfo, decodeSvg, SVG_MIME } from './svg-images.js';
import { decodeShape } from './canvas-shapes.js';
import { decodeDuotone } from './picture-duotone.js';
import { imageWithPixelEffects } from './vector-image-effects.js';
// Original inline-picture primitives. Binary assets are immutable and separate
// from editable run metadata and history snapshots.
import { decodeChart, paintDecodedChart } from './canvas-charts.js';
export const OBJECT = '\ufffc';
export const EMU_PER_PX = 9525;
// Numeric wp:posOffset resolves in whole twips, truncating toward zero.
// Keep authored EMUs in the model/package; only layout uses this conversion.
// Independent signed body, group and cell controls: anchor-offset-precision.
export const drawingOffsetPixels = emu => Math.trunc(emu / 635) / 15;
export const isSideWrappedImage = image => image?.anchor?.wrap === 'square' && image.anchor.horizontal === 'column';
export const isPositionedImage = image => image?.anchor?.wrap === 'none' || image?.anchor?.wrap === 'topAndBottom' || isSideWrappedImage(image);
export const EMU_PER_INCH = 914400;
export const CROP_SIDES = ['left', 'top', 'right', 'bottom'];
export const ANGLE_PER_DEGREE = 60000;
export const FULL_TURN = 360 * ANGLE_PER_DEGREE;
export const normalizedRotation = angle => ((angle || 0) % FULL_TURN + FULL_TURN) % FULL_TURN;

// Swapped inline axes are reserved in these orientation bands. Painted ink
// rotates continuously and may overflow that frame (native extent controls).
export function inlineImageFrameSize(image) {
  // Retained scenes paint their own rotation. Their modern inline frame can
  // still swap axes without applying that rotation to the bitmap a second time.
  const degrees = normalizedRotation(image.frameRotation ?? image.rotation) / ANGLE_PER_DEGREE;
  const swap = !image.anchor && (degrees >= 45 && degrees < 135 || degrees >= 225 && degrees < 315);
  return { width: swap ? image.height : image.width, height: swap ? image.width : image.height };
}

// Extra ink bounds for geometry edits, relative to the reserved frame. Imported
// saved extents are authoritative; quarter turns need no extra inline padding.
export function rotationOutsets(image) {
  const angle = normalizedRotation(image.rotation), quarter = angle / (90 * ANGLE_PER_DEGREE);
  const c = Number.isInteger(quarter) ? [1, 0, 1, 0][quarter] : Math.abs(Math.cos(angle / ANGLE_PER_DEGREE * Math.PI / 180));
  const s = Number.isInteger(quarter) ? [0, 1, 0, 1][quarter] : Math.abs(Math.sin(angle / ANGLE_PER_DEGREE * Math.PI / 180));
  const frame = inlineImageFrameSize(image);
  const x = Math.max(0, Math.ceil((image.width * c + image.height * s - frame.width) / 2 - 1e-7));
  const y = Math.max(0, Math.ceil((image.width * s + image.height * c - frame.height) / 2 - 1e-7));
  return { left: x, top: y, right: x, bottom: y };
}

export function imageExtents(image) {
  const offsets = image.effectExtent || (image.anchor ? rotationOutsets(image) : {});
  const result = Object.fromEntries(CROP_SIDES.map(side => [side, offsets[side] ?? 0]));
  const frame = inlineImageFrameSize(image);
  return { ...result, width: frame.width + result.left + result.right, height: frame.height + result.top + result.bottom };
}

// Physical unrotated paint rectangle, centered inside the reserved inline frame.
export function inlineImagePaintFrame(image, x, y) {
  const frame = inlineImageFrameSize(image), extent = imageExtents(image);
  return { image, x: x + (extent.left + (frame.width - image.width) / 2) / EMU_PER_PX,
    y: y + (extent.top + (frame.height - image.height) / 2) / EMU_PER_PX,
    width: image.width / EMU_PER_PX, height: image.height / EMU_PER_PX };
}

// Inline pictures remain upright when the surrounding cell text is rotated.
// Reserve their physical height along the reading axis and their width across
// it, without changing immutable picture metadata or its own DrawingML rotation.
export function inlineImageExtents(image, page) {
  const extent = imageExtents(image);
  return page.rotatedCellText ? { ...extent, width: extent.height, height: extent.width } : extent;
}

// DrawingML source offsets use 1/1000 percent; the displayed frame stays fixed.
export function normalizeCrop(crop = {}) {
  if (!crop || typeof crop !== 'object' || Array.isArray(crop) || Object.keys(crop).some(k => !CROP_SIDES.includes(k))) throw new Error('Unknown image crop property.');
  const result = Object.fromEntries(CROP_SIDES.map(side => [side, Object.hasOwn(crop, side) ? crop[side] : 0]));
  // Transitional DrawingML ST_PercentageDecimal is xsd:int. Source and fill
  // rectangles can legitimately extend far beyond 1000% without enlarging
  // the decoded bitmap or the displayed frame.
  if (Object.values(result).some(n => !Number.isInteger(n) || n < -2147483648 || n > 2147483647)) throw new Error('Crop offsets must fit the DrawingML signed 32-bit range, in steps of 0.001%.');
  if (result.left + result.right >= 100000 || result.top + result.bottom >= 100000) throw new Error('Crop offsets must leave a positive source width and height.');
  return result;
}

/** Clip the source viewport to real pixels; outsets leave transparent frame space. */
export function imageCropRect(crop, width, height) {
  const { left, top, right, bottom } = normalizeCrop(crop);
  const x = left / 100000, y = top / 100000, w = 1 - (left + right) / 100000, h = 1 - (top + bottom) / 100000;
  const sx = Math.max(0, x), sy = Math.max(0, y), sw = Math.min(1, 1 - right / 100000) - sx, sh = Math.min(1, 1 - bottom / 100000) - sy;
  if (sw <= 0 || sh <= 0) return null;
  return { source: [sx * width, sy * height, sw * width, sh * height], destination: [(sx - x) / w, (sy - y) / h, sw / w, sh / h] };
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function* inlineSegments(text) {
  let offset = 0;
  for (const part of text.split(OBJECT)) {
    if (offset) yield { segment: OBJECT, index: offset - 1 };
    for (const item of segmenter.segment(part)) yield { segment: item.segment, index: offset + item.index };
    offset += part.length + 1;
  }
}

export const MAX_IMAGE_SIDE = 8192, MAX_IMAGE_PIXELS = 16000000;
/** Format and pixel size of PNG, JPEG or TIFF bytes; `checkSize: false` skips the pixel limits for PNG and JPEG. */
export function imageInfo(bytes, { checkSize = true } = {}) {
  // Embedded PNG/JPEG parts share the session's encoded-byte budget. Their
  // decoded dimensions, rather than compression or metadata size, bound pixels.
  if (!(bytes instanceof Uint8Array) || bytes.length > 50 * 1024 * 1024) throw new Error('Image assets must fit within the 50 MB editing-session budget.');
  if (isTiff(bytes)) return tiffInfo(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let mime, width, height;
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) && view.getUint32(12) === 0x49484452) {
    mime = 'image/png'; width = view.getUint32(16); height = view.getUint32(20);
    for (let at = 8; at + 12 <= bytes.length;) {
      const size = view.getUint32(at), type = view.getUint32(at + 4);
      if (at + size + 12 > bytes.length) throw new Error('The PNG image is incomplete.');
      if (type === 0x6163544c) throw new Error('Animated PNG images are not supported yet.');
      at += size + 12;
    }
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mime = 'image/jpeg';
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (at + 2 > bytes.length) break;
      const size = view.getUint16(at);
      if (size < 2 || at + size > bytes.length) break;
      if ([192, 193, 194].includes(marker) && size >= 8) { height = view.getUint16(at + 3); width = view.getUint16(at + 5); break; }
      at += size;
    }
  }
  if (!width || !height) throw new Error('This image is not a supported PNG, JPEG or TIFF.');
  if (checkSize && (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS)) throw new Error('Images must be at most 8,192 pixels per side and 16 megapixels.');
  return { mime, width, height };
}

export function validateImage(image) {
  if (image.frameRotation !== undefined && (image.kind !== 'drawing' || !image.retainedDrawing || image.anchor || image.flatLine || image.flatGroup || !Number.isInteger(image.frameRotation) || image.frameRotation < 0 || image.frameRotation >= FULL_TURN)) throw new Error('Invalid retained drawing frame rotation.');
  if (image.kind === 'chart' && (Object.values(normalizeCrop(image.crop)).some(Boolean) || image.flipH || image.flipV || normalizedRotation(image.rotation))) throw new Error('Chart cropping, flipping and rotation are not supported.');
  if (image.anchor && image.anchor.wrap !== 'none' && (normalizedRotation(image.rotation) || CROP_SIDES.some(s => image.effectExtent?.[s]))) throw new Error('Text-wrapped pictures with rotation or extra extents are not supported.');
  if (image.flatLine && image.flatGroup) throw new Error('Conflicting flat drawing metadata.');
  const flat = image.flatLine || image.flatGroup;
  if (flat) {
    if (flat.markerPen !== undefined && (!Number.isSafeInteger(flat.markerPen) || flat.markerPen < 0 || flat.markerPen > 22 * EMU_PER_INCH)) throw new Error('Invalid flat line marker pen.');
    for (const end of [flat.headEnd,flat.tailEnd]) if (end && (!['oval','triangle','stealth','diamond','arrow'].includes(end.type) || !['sm','med','lg'].includes(end.width) || !['sm','med','lg'].includes(end.length))) throw new Error('Invalid flat line marker.');
  }
  const empty = image.flatLine?.empty === true && image.width === 0 && image.height === 0 && flat.strokeWidth === 0;
  if (flat && (flat.empty !== undefined && !empty || image.kind !== 'drawing' || !image.retainedDrawing || !Number.isInteger(flat.rotation) || flat.rotation < 0 || flat.rotation >= FULL_TURN || !Number.isSafeInteger(flat.strokeWidth) || flat.strokeWidth < 0 || flat.strokeWidth > 22 * EMU_PER_INCH || typeof flat.flipH !== 'boolean' || typeof flat.flipV !== 'boolean' || !empty && (!image.width === !image.height))) throw new Error('Invalid flat drawing line.');
  for (const key of ['width', 'height']) if (!Number.isSafeInteger(image[key]) || image[key] < (flat ? 0 : 1) || image[key] > 22 * EMU_PER_INCH) throw new Error('Image dimensions must be positive and no larger than 22 inches.');
  if (typeof image.alt !== 'string' || image.alt.length > 2000) throw new Error('Image alt text must be at most 2,000 characters.');
  normalizeCrop(image.crop);
  if (image.opacity !== undefined && (!Number.isFinite(image.opacity) || image.opacity < 0 || image.opacity > 1)) throw new Error('Picture opacity must be between zero and one.');
  for (const key of ['flipH', 'flipV']) if (Object.hasOwn(image, key) && typeof image[key] !== 'boolean') throw new Error('Image flips must be true or false.');
  if (image.rotation !== undefined && (!Number.isInteger(image.rotation) || image.rotation < -2147483648 || image.rotation > 2147483647)) throw new Error('Image rotation must use a signed 32-bit integer in 1/60,000 degree units.');
  if (normalizedRotation(image.rotation) && image.rotateWithShape === false) throw new Error('This picture has a fill that does not rotate with its shape.');
  if (image.effectExtent !== undefined && (!image.effectExtent || typeof image.effectExtent !== 'object' || Array.isArray(image.effectExtent) || Object.keys(image.effectExtent).some(key => !CROP_SIDES.includes(key)))) throw new Error('Unknown image extent.');
  const extent = imageExtents(image);
  for (const side of CROP_SIDES) if (!Number.isSafeInteger(extent[side]) || extent[side] < 0 || extent[side] > 22 * EMU_PER_INCH) throw new Error('Image extra extents must be nonnegative and at most 22 inches.');
  if (extent.width > 22 * EMU_PER_INCH || extent.height > 22 * EMU_PER_INCH) throw new Error('The image including rotation and extra extents must fit within 22 inches.');
  return image;
}

const previewPlaceholder = () => ({ previewPlaceholder: true, width: 1, height: 1, close() {} });

export async function decodeImage(asset, fontAlternatives, onMissingFont) {
  if (asset.previewPlaceholder) return previewPlaceholder();
  if (asset.chart) return decodeChart(asset, fontAlternatives);
  if (asset.mime === WMF_MIME) {
    const image = await decodeWmf(asset.bytes,asset.wmfViewport);
    return asset.pictureEffects ? decodePictureEffects(image, asset.pictureEffects) : asset.duotone ? decodeDuotone(image, asset.duotone) : image;
  }
  if (asset.mime === EMF_MIME) {
    const pixelEffects = !!asset.metafileOpacity || !!asset.duotone || !!asset.pictureEffects?.some(effect => effect.type !== 'luminance' || effect.brightness !== 0 || effect.contrast !== 0);
    const image = await decodeEmf(asset.bytes, onMissingFont, pixelEffects);
    return asset.pictureEffects ? decodePictureEffects(image, asset.pictureEffects) : asset.duotone ? decodeDuotone(image, asset.duotone) : asset.metafileOpacity ? imageWithPixelEffects(image,()=>{}) : image;
  }
  if (asset.mime === SVG_MIME) {
    const image = await decodeSvg(asset.bytes);
    return asset.pictureEffects ? decodePictureEffects(image, asset.pictureEffects) : asset.duotone ? decodeDuotone(image, asset.duotone) : image;
  }
  const info = imageInfo(asset.bytes);
  if (info.mime === TIFF_MIME) {
    const image = await decodeTiffImage(asset.bytes);
    return asset.pictureEffects ? decodePictureEffects(image, asset.pictureEffects) : asset.duotone ? decodeDuotone(image, asset.duotone) : image;
  }
  try {
    // HTMLImageElement can report load/decode success for a corrupt pixel stream.
    // Materialize the bitmap before attaching any save handler.
    const image = await createImageBitmap(new Blob([asset.bytes], { type: info.mime }));
    return asset.pictureEffects ? decodePictureEffects(image, asset.pictureEffects, info.mime) : asset.duotone ? decodeDuotone(image, asset.duotone) : image;
  } catch { throw new Error('The image could not be decoded.'); }
}

export function validateImageAssets(assets, extra) {
  let bytes = 0, pixels = 0;
  for (const asset of [...Object.values(assets), ...(extra ? [extra] : [])]) {
    if (asset.previewPlaceholder) continue; // Vector preview marker, no source bitmap allocation.
    if (asset.chart || asset.scene) { pixels += asset.width * asset.height * 4; continue; }
    const info = asset.mime === SVG_MIME ? svgInfo(asset.bytes) : asset.mime === EMF_MIME ? emfInfo(asset.bytes) : asset.mime === WMF_MIME ? wmfInfo(asset.bytes,asset.wmfViewport) : imageInfo(asset.bytes); bytes += asset.bytes.length; pixels += info.width * info.height;
  }
  if (bytes > 50 * 1024 * 1024 || pixels > 64000000) throw new Error('This editing session supports up to 50 MB and 64 megapixels of image assets.');
}

export async function decodeImages(assets, fontAlternatives, onMissingFont, onFailure) {
  validateImageAssets(assets);
  const entries = Object.entries(assets).filter(([, asset]) => !asset.scene);
  const results = await Promise.allSettled(entries.map(async ([id, asset]) => [id, await decodeImage(asset, fontAlternatives, onMissingFont)]));
  const failure = results.find(r => r.status === 'rejected');
  if (failure && !onFailure) { for (const r of results) if (r.status === 'fulfilled') r.value[1].close(); throw failure.reason; }
  const bitmaps = new Map(results.filter(r => r.status === 'fulfilled').map(r => r.value));
  try {
    // Opening a read-only preview can retain healthy assets. Editing callers
    // keep the strict default, and aggregate resource limits still apply.
    for (let i = 0; i < results.length; i++) if (results[i].status === 'rejected') {
      onFailure(entries[i][0], results[i].reason);
      // A vector marker has no source pixels to crop or allocate. Retaining
      // the asset identity lets groups recover this child without losing siblings.
      bitmaps.set(entries[i][0], previewPlaceholder());
    }
    let pixels = [...bitmaps.values()].reduce((n, bitmap) => n + (bitmap.previewPlaceholder ? 0 : bitmap.width * bitmap.height), 0);
    const resized = (previous,next) => {
      const total = pixels + (next.rasterPixelCount ?? next.bitmap.width*next.bitmap.height) - (previous.rasterPixelCount ?? previous.bitmap.width*previous.bitmap.height);
      if (total > 64000000) throw new Error('This editing session supports up to 64 megapixels of image previews.');
      pixels = total;
    };
    for (const [id, asset] of Object.entries(assets)) if (asset.scene) {
      let preview;
      try { preview = await decodeShape(asset, bitmaps, fontAlternatives, resized); }
      catch (error) {
        if (!onFailure) throw error;
        onFailure(id, error); bitmaps.set(id, previewPlaceholder()); continue;
      }
      bitmaps.set(id, preview); pixels += preview.rasterPixelCount ?? preview.bitmap.width * preview.bitmap.height;
      if (pixels > 64000000) throw new Error('This editing session supports up to 64 megapixels of image previews.');
    }
  }
  catch (error) { for (const bitmap of bitmaps.values()) bitmap.close(); throw error; }
  return bitmaps;
}

// Drawing previews can extend beyond their frame (text-body overflow). The DOCX
// frame and wrapping extents remain independent of this session bitmap.
export function paintDecodedImage(ctx, image, x, y, width, height, fieldContext) {
  if (image.previewPlaceholder) {
    ctx.save();
    // Canvas save/restore does not preserve the current path. A picture-fill
    // caller still needs that path to paint its outline after this marker.
    const clip = new Path2D(); clip.rect(x, y, width, height); ctx.clip(clip);
    ctx.fillStyle = '#F3F4F6'; ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = '#9CA3AF'; ctx.lineWidth = 1;
    ctx.strokeRect(x + .5, y + .5, Math.max(0, width - 1), Math.max(0, height - 1));
    const size = Math.min(16, width / 2, height / 2), left = x + (width - size) / 2, top = y + (height - size) / 2;
    ctx.strokeRect(left, top, size, size);
    const icon = new Path2D(); icon.moveTo(left, top + size); icon.lineTo(left + size * .4, top + size * .45);
    icon.lineTo(left + size * .65, top + size * .7); icon.lineTo(left + size, top + size * .3); ctx.stroke(icon);
    ctx.restore(); return;
  }
  if (paintDecodedChart(ctx, image, x, y, width, height)) return;
  if (image.forPage) {
    if (image.paintDisplay?.(ctx,x,y,width,height,fieldContext)) return;
    const matrix = ctx.getTransform();
    const pixelRatio=Math.max(Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d));
    image = image.forPage(fieldContext, {x,y,width,height,pixelRatio,
      originX:(matrix.a*x+matrix.c*y+matrix.e)/pixelRatio,originY:(matrix.b*x+matrix.d*y+matrix.f)/pixelRatio,
      axisAligned:matrix.b===0 && matrix.c===0 && matrix.a>0 && matrix.a===matrix.d});
  }
  if (image.bitmap) {
    // A flat line has no scale on its collapsed axis; use its nonzero axis.
    const sx = image.frameWidth ? width / image.frameWidth : height / image.frameHeight;
    const sy = image.frameHeight ? height / image.frameHeight : width / image.frameWidth;
    if (image.smoothingQuality) ctx.save();
    if (image.smoothingQuality) ctx.imageSmoothingQuality = image.smoothingQuality;
    ctx.drawImage(image.bitmap, x + image.left * sx, y + image.top * sy, image.width * sx, image.height * sy);
    if (image.smoothingQuality) ctx.restore();
  } else if (fieldContext?.bitmapDisplayScale) paintDisplayImage(ctx, image, x, y, width, height, fieldContext.bitmapDisplayScale);
  else paintImage(ctx, image, x, y, width, height);
}
