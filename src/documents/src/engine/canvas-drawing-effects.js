import { drawingRasterScale } from './drawing-raster-scale.js';

/**
 * Painting a drawing's soft edges, glow and reflection (read by docx-drawing-effects.js) around its
 * decoded raster: { bitmap, left, top, width, height, frameWidth, frameHeight, rasterScale, close }
 * in physical CSS pixels relative to the drawing frame. Like shadows, effects only add ink around the
 * drawing: they never change its frame, its wrapping or the saved document.
 *
 * Order: the soft edge fades the drawing itself; then its shadow (`withShadow`, which consumes the
 * raster it is given); the glow goes behind everything and the reflection is a mirror image of the
 * softened drawing below its frame.
 */
const MAX_SIDE = 4096, MAX_AREA = 4000000;
const limit = (width, height) => {
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_AREA) throw new Error('This drawing preview exceeds the image resource limit.');
};
const surface = (width, height) => {
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
};
/** The raster's pixel size: its physical size at its raster scale. */
const pixels = raster => ({ w: Math.max(1, Math.round(raster.width * raster.rasterScale)), h: Math.max(1, Math.round(raster.height * raster.rasterScale)) });

/** Multiply the raster's alpha by a ramp that is zero on its silhouette's edge and full `radius` inside it. */
export function softenEdges(source, radius) {
  const scale = source.rasterScale || 1, { w, h } = pixels(source);
  const { canvas, ctx } = surface(w, h);
  ctx.drawImage(source.bitmap, 0, 0, w, h);
  // A Gaussian of the silhouette is one half on the edge and nearly full two deviations inside it.
  const mask = surface(w, h);
  mask.ctx.filter = `blur(${radius * scale / 2}px)`;
  mask.ctx.drawImage(canvas, 0, 0);
  const image = ctx.getImageData(0, 0, w, h), blurred = mask.ctx.getImageData(0, 0, w, h).data, data = image.data;
  for (let i = 3; i < data.length; i += 4) {
    const coverage = data[i] ? blurred[i] / data[i] : 0;
    data[i] = Math.round(data[i] * Math.max(0, Math.min(1, 2 * coverage - 1)));
  }
  ctx.putImageData(image, 0, 0);
  source.close();
  const bitmap = canvas.transferToImageBitmap();
  return { ...source, bitmap, close: () => bitmap.close() };
}

/** The glow around the silhouette: { canvas, left, top, width, height } in physical pixels at `scale`. */
function glowLayer(source, glow, scale) {
  const pad = glow.radius * 2 + 1;
  const left = source.left - pad, top = source.top - pad, width = source.width + 2 * pad, height = source.height + 2 * pad;
  limit(width, height);
  const { canvas, ctx } = surface(width * scale, height * scale);
  ctx.filter = `blur(${glow.radius * scale / 2}px)`;
  ctx.drawImage(source.bitmap, pad * scale, pad * scale, source.width * scale, source.height * scale);
  ctx.filter = 'none';
  // Strengthen the blurred silhouette so the halo is full against the edge and fades over the radius.
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height), data = image.data;
  const [r, g, b] = glow.color.rgb.match(/../g).map(c => parseInt(c, 16)), alpha = glow.color.alpha ?? 1;
  for (let i = 0; i < data.length; i += 4) {
    const a = Math.min(1, data[i + 3] / 255 * 2) * alpha;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = Math.round(a * 255);
  }
  ctx.putImageData(image, 0, 0);
  return { canvas, left, top, width, height };
}

/** The mirror image below the frame, fading from the start to the end alpha. */
function reflectionLayer(source, reflection, scale) {
  const frameHeight = source.frameHeight || source.height;
  // Mirror about the frame's bottom edge, moved down by the distance.
  const axis = frameHeight + reflection.distance / 2;
  const pad = reflection.blur + 1;
  const top = 2 * axis - (source.top + source.height) - pad, left = source.left - pad;
  const width = source.width + 2 * pad, height = source.height + 2 * pad;
  limit(width, height);
  const { canvas, ctx } = surface(width * scale, height * scale);
  if (reflection.blur) ctx.filter = `blur(${reflection.blur * scale / 2}px)`;
  ctx.save();
  ctx.translate(0, height * scale); ctx.scale(1, -1);
  ctx.drawImage(source.bitmap, pad * scale, pad * scale, source.width * scale, source.height * scale);
  ctx.restore();
  ctx.filter = 'none';
  // The fade runs over the drawing's own height, from just below the frame.
  const start = frameHeight + reflection.distance, span = frameHeight;
  const gradient = ctx.createLinearGradient(0, (start - top) * scale, 0, (start + span - top) * scale);
  gradient.addColorStop(reflection.startPosition, `rgba(0,0,0,${reflection.startAlpha})`);
  gradient.addColorStop(reflection.endPosition, `rgba(0,0,0,${reflection.endAlpha})`);
  if (reflection.endPosition < 1) gradient.addColorStop(Math.min(1, reflection.endPosition + 1e-6), 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Nothing of the reflection shows above the frame's bottom edge.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, Math.max(0, (start - top) * scale));
  return { canvas, left, top, width, height };
}

/**
 * Apply effects ({ softEdge?, glow?, reflection? }) to a decoded raster. `withShadow(raster)` adds the
 * drawing's shadow (and consumes its argument); pass null when there is none. Returns a new raster.
 */
export function paintDrawingEffects(source, effects, withShadow = null) {
  if (!effects) return withShadow ? withShadow(source) : source;
  let shape = effects.softEdge ? softenEdges(source, effects.softEdge.radius) : source;
  const scale = shape.rasterScale || 2;
  let glow, reflection;
  try {
    glow = effects.glow ? glowLayer(shape, effects.glow, scale) : null;
    reflection = effects.reflection ? reflectionLayer(shape, effects.reflection, scale) : null;
  } catch (error) { shape.close(); throw error; }
  const main = withShadow ? withShadow(shape) : shape;
  if (!glow && !reflection) return main;
  const layers = [glow, reflection].filter(Boolean);
  const left = Math.floor(Math.min(main.left, ...layers.map(l => l.left))), top = Math.floor(Math.min(main.top, ...layers.map(l => l.top)));
  const right = Math.ceil(Math.max(main.left + main.width, ...layers.map(l => l.left + l.width)));
  const bottom = Math.ceil(Math.max(main.top + main.height, ...layers.map(l => l.top + l.height)));
  const width = right - left, height = bottom - top;
  try { limit(width, height); } catch (error) { main.close(); throw error; }
  const resolution = drawingRasterScale(width, height, main.rasterScale || scale);
  const canvas = new OffscreenCanvas(Math.max(1, width * resolution), Math.max(1, height * resolution)), ctx = canvas.getContext('2d');
  const place = (image, at) => ctx.drawImage(image, (at.left - left) * resolution, (at.top - top) * resolution, at.width * resolution, at.height * resolution);
  if (glow) place(glow.canvas, glow);
  place(main.bitmap, main);
  if (reflection) place(reflection.canvas, reflection);
  main.close();
  const bitmap = canvas.transferToImageBitmap();
  return { ...main, bitmap, left, top, width, height, rasterScale: resolution, close: () => bitmap.close() };
}

