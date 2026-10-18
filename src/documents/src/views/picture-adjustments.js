import { drawingParts } from '../engine/drawing-format.js';
import { A, A14, R, child, childrenOf, setCrop, setPictureLayer, readPictureLayer } from '../engine/drawing-xml.js';
import { removeBackground, applyMask, ARTISTIC_EFFECTS, adjustSaturation, adjustTemperature, sharpenSoften, downsample, cropPixels } from '../engine/picture-processing.js';
import { decodeToImageData, encodeImageData } from '../engine/picture-encoding.js';

/**
 * Picture edits that change pixels: Remove Background, Sharpen/Soften, Saturation, Color Tone and
 * Artistic Effects. The picture shows a processed copy and keeps its original with the list of edits
 * (the picture's original layer, see setPictureLayer), so other applications show the result, any edit
 * can be changed later from the original, and Reset Picture restores it. Corrections that DrawingML
 * describes directly (brightness, contrast, recolor, transparency) are written as blip effects instead.
 */
const MAX_SIDE = 4096;
const SVG_URI = '{96DAC541-7B7A-43D3-8B79-37D633B846F1}';
const DEFAULT_MARK_RADIUS = 0.03;

/** The processed edits recorded on a picture's original layer, as a state object. */
export function bakedState(layer) {
  const state = {};
  for (const { name, attrs } of layer?.effects || []) {
    if (name === 'sharpenSoften') state.sharpen = Number(attrs.amount || 0) / 100000;
    else if (name === 'saturation') state.saturation = Number(attrs.sat ?? 100000) / 100000;
    else if (name === 'colorTemperature') state.temperature = Number(attrs.colorTemp || 6500);
    else if (name === 'backgroundRemoval') state.background = { region: { left: Number(attrs.l || 0) / 100000, top: Number(attrs.t || 0) / 100000, right: 1 - Number(attrs.r || 0) / 100000, bottom: 1 - Number(attrs.b || 0) / 100000 }, keep: attrs.keep || [], remove: attrs.remove || [] };
    else { const effect = ARTISTIC_EFFECTS.find(e => e.a14 === name); if (effect) state.artistic = { id: effect.id, amount: 0.5 }; }
  }
  return state;
}
/** Read a picture's original layer including background marks (stored as line segments). */
export function readBakedLayer(blip) {
  const layer = readPictureLayer(blip);
  if (!layer) return null;
  // Background marks are child elements; read them from the XML directly.
  const ext = childrenOf(child(blip, A, 'extLst'), A, ['ext']).find(e => child(e, A14, 'imgProps'));
  const removal = ext?.getElementsByTagNameNS(A14, 'backgroundRemoval')[0];
  if (removal) {
    const marks = kind => [...removal.getElementsByTagNameNS(A14, kind)].map(m => ({ points: [[Number(m.getAttribute('x1')) / 100000, Number(m.getAttribute('y1')) / 100000], [Number(m.getAttribute('x2')) / 100000, Number(m.getAttribute('y2')) / 100000]], radius: DEFAULT_MARK_RADIUS }));
    const entry = layer.effects.find(e => e.name === 'backgroundRemoval');
    if (entry) entry.attrs = { ...entry.attrs, keep: marks('foregroundMark'), remove: marks('backgroundMark') };
  }
  return layer;
}
const neutral = state => !state.background && !state.artistic && !(state.sharpen) && (state.saturation === undefined || state.saturation === 1) && (state.temperature === undefined || state.temperature === 6500);

/** Apply the processed edits to pixels, in a fixed order, from the original. */
export function processPixels(image, state) {
  let out = image;
  if (state.background) out = applyMask(out, state.background.mask || removeBackground(out, state.background).mask);
  if (state.sharpen) out = sharpenSoften(out, state.sharpen);
  if (state.saturation !== undefined && state.saturation !== 1) out = adjustSaturation(out, state.saturation);
  if (state.temperature !== undefined && state.temperature !== 6500) out = adjustTemperature(out, state.temperature);
  if (state.artistic) out = ARTISTIC_EFFECTS.find(e => e.id === state.artistic.id)?.apply(out, state.artistic.amount ?? 0.5) || out;
  return out;
}

/** The original layer's effect list for a state (MS-ODRAWXML a14:imgEffect children). */
function layerEffects(state) {
  const effects = [];
  const p = v => Math.round(v * 100000);
  if (state.background) {
    const r = state.background.region || { left: 0.08, top: 0.08, right: 0.92, bottom: 0.92 };
    const segments = strokes => strokes.flatMap(stroke => stroke.points.length < 2 ? [[stroke.points[0], stroke.points[0]]] : stroke.points.slice(1).map((point, i) => [stroke.points[i], point]));
    effects.push({ name: 'backgroundRemoval', attrs: { t: p(r.top), b: p(1 - r.bottom), l: p(r.left), r: p(1 - r.right) },
      children: [...segments(state.background.keep || []).map(([a, b]) => ({ name: 'foregroundMark', attrs: { x1: p(a[0]), y1: p(a[1]), x2: p(b[0]), y2: p(b[1]) } })),
        ...segments(state.background.remove || []).map(([a, b]) => ({ name: 'backgroundMark', attrs: { x1: p(a[0]), y1: p(a[1]), x2: p(b[0]), y2: p(b[1]) } }))] });
  }
  if (state.sharpen) effects.push({ name: 'sharpenSoften', attrs: { amount: p(state.sharpen) } });
  if (state.saturation !== undefined && state.saturation !== 1) effects.push({ name: 'saturation', attrs: { sat: p(state.saturation) } });
  if (state.temperature !== undefined && state.temperature !== 6500) effects.push({ name: 'colorTemperature', attrs: { colorTemp: Math.round(state.temperature) } });
  if (state.artistic) { const effect = ARTISTIC_EFFECTS.find(e => e.id === state.artistic.id); if (effect) effects.push({ name: effect.a14 }); }
  return effects;
}

/** Pixels of a picture part, scaled to at most MAX_SIDE pixels per side. */
export async function partPixels(bytes, mime) {
  const image = await decodeToImageData(bytes, mime);
  const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
  return scale < 1 ? downsample(image, scale) : image;
}

/**
 * The background removal mask a processed picture already shows, recovered from its transparency against
 * the original's. The saved marks do not record the sensitivity or brush sizes they were made with, so
 * recomputing from them would change which pixels are removed. Null when the shown picture is not a
 * removal of this original (another size, or nothing transparent that the original keeps).
 */
async function shownMask(part, original) {
  if (!part?.bytes) return null;
  let shown;
  try { shown = await partPixels(part.bytes, part.contentType); } catch { return null; }
  if (shown.width !== original.width || shown.height !== original.height) return null;
  const mask = new Uint8ClampedArray(shown.width * shown.height);
  let removes = false;
  for (let i = 0; i < mask.length; i++) {
    const before = original.data[i * 4 + 3], after = shown.data[i * 4 + 3];
    mask[i] = before ? Math.round(Math.min(255, after * 255 / before)) : 255;
    if (mask[i] < 255) removes = true;
  }
  return removes ? mask : null;
}

function dropVectorCompanion(blip) {
  // A processed picture is a bitmap; an SVG companion would show the unprocessed vector instead.
  for (const ext of childrenOf(child(blip, A, 'extLst'), A, ['ext'])) if (ext.getAttribute('uri')?.toUpperCase() === SVG_URI) ext.remove();
  const list = child(blip, A, 'extLst'); if (list && !list.children.length) list.remove();
}

/**
 * An edit for formatDrawing that changes the processed edits: `change` merges into the picture's state
 * (pass a key as undefined/null to clear it). Returns the edit function.
 */
export function processedEdit(change) {
  return async (drawing, context) => {
    const { blip } = drawingParts(drawing);
    if (!blip) throw new Error('Select a picture to adjust it.');
    const layer = readBakedLayer(blip);
    const originalRel = layer?.relId || blip.getAttributeNS(R, 'embed');
    const state = { ...bakedState(layer), ...change };
    for (const key of Object.keys(state)) if (state[key] === null || state[key] === undefined) delete state[key];
    if (neutral(state)) {
      if (!layer) return false;
      blip.setAttributeNS(R, 'r:embed', originalRel);
      setPictureLayer(blip, null);
      return true;
    }
    const part = context.parts.get(originalRel);
    if (!part?.bytes) throw new Error('The picture\'s data is not available.');
    if (!/^image\/(png|jpeg|gif|bmp|webp|tiff)$/.test(part.contentType)) throw new Error('This kind of picture cannot be processed. Pictures in PNG, JPEG, GIF, BMP or TIFF can.');
    const pixels = await partPixels(part.bytes, part.contentType);
    const shownRel = blip.getAttributeNS(R, 'embed');
    if (state.background && !('background' in change) && shownRel !== originalRel) {
      const mask = await shownMask(context.parts.get(shownRel), pixels);
      if (mask) state.background = { ...state.background, mask };
    }
    const processed = processPixels(pixels, state);
    const keepsOpaque = !state.background && part.contentType === 'image/jpeg';
    const bytes = await encodeImageData(processed, keepsOpaque ? 'image/jpeg' : 'image/png', 0.92);
    const rel = context.addPart(bytes, keepsOpaque ? 'image/jpeg' : 'image/png', 'canvas-adjusted');
    dropVectorCompanion(blip);
    blip.setAttributeNS(R, 'r:embed', rel);
    setPictureLayer(blip, originalRel, layerEffects(state).map(effect => ({ ...effect, children: effect.children })));
    return true;
  };
}

/** The current processed state of a picture drawing (for menus and the Format pane). */
export function processedStateOf(drawingXmlBlip) { return bakedState(readBakedLayer(drawingXmlBlip)); }

/**
 * Compress Pictures: resample to `ppi` for the picture's printed size and optionally delete cropped
 * areas. The original layer is discarded (that is the point of compressing). Returns the edit.
 */
export function compressEdit({ ppi = 150, deleteCropped = true } = {}) {
  return async (drawing, context) => {
    const { blip, blipFill, frame } = drawingParts(drawing);
    if (!blip) return false;
    const rel = blip.getAttributeNS(R, 'embed'), part = context.parts.get(rel);
    if (!part?.bytes || !/^image\/(png|jpeg)$/.test(part.contentType)) return false;
    let image = await decodeToImageData(part.bytes, part.contentType);
    const source = child(blipFill, A, 'srcRect');
    const crop = Object.fromEntries(['l', 't', 'r', 'b'].map(k => [k, Number(source?.getAttribute(k) || 0)]));
    let changed = false;
    if (deleteCropped && Object.values(crop).some(v => v > 0) && Object.values(crop).every(v => v >= 0)) {
      image = cropPixels(image, { left: crop.l / 100000, top: crop.t / 100000, right: crop.r / 100000, bottom: crop.b / 100000 });
      setCrop(blipFill, {});
      changed = true;
    }
    const extent = frame.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'extent')[0];
    const inches = [Number(extent.getAttribute('cx')) / 914400, Number(extent.getAttribute('cy')) / 914400];
    // The visible part of the picture fills the frame: its pixels per inch follow from the frame size.
    const visible = changed ? [1, 1] : [1 - (crop.l + crop.r) / 100000, 1 - (crop.t + crop.b) / 100000];
    const scale = ppi > 0 ? Math.min(1, ppi * inches[0] / (image.width * visible[0]), ppi * inches[1] / (image.height * visible[1])) : 1;
    if (scale < 0.97) { image = downsample(image, scale); changed = true; }
    if (!changed && !readPictureLayer(blip)) return false;
    const mime = part.contentType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const bytes = await encodeImageData(image, mime, 0.85);
    const next = context.addPart(bytes, mime, 'canvas-compressed');
    const layer = readPictureLayer(blip);
    context.release?.(rel); if (layer?.relId) context.release?.(layer.relId);
    blip.setAttributeNS(R, 'r:embed', next);
    setPictureLayer(blip, null);
    return true;
  };
}

/** Change Picture: put new picture bytes in the frame, cropped to fill it, keeping size and formatting. */
export function changePictureEdit({ bytes, mime, width, height }) {
  return async (drawing, context) => {
    const { blip, blipFill, frame } = drawingParts(drawing);
    if (!blip) throw new Error('Select a picture to change it.');
    // The replaced picture, its kept original and its SVG companion are released: saving drops whichever
    // nothing else still uses, instead of keeping them in the file for good.
    const replaced = [blip.getAttributeNS(R, 'embed'), readPictureLayer(blip)?.relId,
      ...[...blip.getElementsByTagNameNS('*', 'svgBlip')].map(svg => svg.getAttributeNS(R, 'embed'))].filter(Boolean);
    const rel = context.addPart(bytes, mime, 'canvas-picture');
    dropVectorCompanion(blip);
    setPictureLayer(blip, null);
    blip.setAttributeNS(R, 'r:embed', rel);
    for (const old of replaced) context.release?.(old);
    const extent = frame.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'extent')[0];
    const frameRatio = Number(extent.getAttribute('cx')) / Number(extent.getAttribute('cy')), pictureRatio = width / height;
    const crop = {};
    if (pictureRatio > frameRatio) crop.left = crop.right = Math.round((1 - frameRatio / pictureRatio) / 2 * 100000);
    else if (pictureRatio < frameRatio) crop.top = crop.bottom = Math.round((1 - pictureRatio / frameRatio) / 2 * 100000);
    setCrop(blipFill, crop);
    return true;
  };
}

/** Restore the original picture and clear processed edits; returns whether there was anything to undo. */
export function restoreOriginal(blip) {
  const layer = readPictureLayer(blip);
  if (!layer) return false;
  blip.setAttributeNS(R, 'r:embed', layer.relId);
  setPictureLayer(blip, null);
  return true;
}
