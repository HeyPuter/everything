import { paintDecodedImage } from './images.js';

// Paint Word watermarks (retained VML, see vml-watermarks.js) behind a page's text: a WordArt text
// path stretched to fill its box (v:textpath fitshape), in its fill colour and opacity, or a picture
// washed out by its gain. Both turn about the box's centre by the shape's rotation (degrees clockwise).
export function paintWatermark(ctx, frame, images) {
  const { watermark: w, x, y, width, height } = frame;
  if (!(width > 0 && height > 0)) return;
  ctx.save();
  ctx.translate(x + width / 2, y + height / 2);
  if (w.rotation) ctx.rotate(w.rotation * Math.PI / 180);
  if (w.kind === 'text') {
    if (!w.color) { ctx.restore(); return; }
    ctx.globalAlpha *= w.opacity ?? 1;
    ctx.fillStyle = `#${w.color}`;
    const size = 100;
    ctx.font = `${size}px "${String(w.font).replace(/["\\]/g, '')}", sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(w.text), ascent = m.actualBoundingBoxAscent || size * 0.72, descent = m.actualBoundingBoxDescent || 0;
    const left = m.actualBoundingBoxLeft ?? 0, inkWidth = (m.actualBoundingBoxRight ?? m.width) + left || m.width;
    if (inkWidth > 0 && ascent + descent > 0) {
      ctx.scale(width / inkWidth, height / (ascent + descent));
      ctx.fillText(w.text, -inkWidth / 2 + left, (ascent - descent) / 2);
    }
  } else if (w.kind === 'picture') {
    const bitmap = w.assetId && images?.get(w.assetId);
    if (bitmap) {
      // Washout (gain below 1) lightens the picture towards the page.
      ctx.globalAlpha *= w.gain > 0 && w.gain < 1 ? w.gain : 1;
      paintDecodedImage(ctx, bitmap, -width / 2, -height / 2, width, height);
    }
  }
  ctx.restore();
}
