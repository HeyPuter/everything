import { drawPicture } from '../core/picture-geometry.js';
import { applyPictureFilter } from '../core/picture-format.js';

/** Rasterize the visible picture, including its outer DrawingML transform. */
export async function imageToPng(src, obj = {}) {
  if (obj.drawingShape) {
    const { drawingRasterSource } = await import('../core/drawingml-raster.js');
    const drawing = await drawingRasterSource(src, obj);
    if (drawing) { src = drawing.src; obj = { ...obj, w: drawing.w, h: drawing.h }; }
  }
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const canvas = document.createElement('canvas');
      const rotation = Number.isFinite(obj.rotation) ? obj.rotation % 360 : 0;
      const angle = rotation * Math.PI / 180;
      // Vectors have no intrinsic bitmap size. Cropped/rotated pictures must
      // also use their displayed aspect ratio, which may differ from the source.
      const sized = /^data:image\/svg\+xml;/i.test(src) || obj.srcRect || obj.fillRect || rotation;
      const width = sized && Number.isFinite(obj.w) && obj.w > 0 ? obj.w : im.naturalWidth || 1;
      const height = sized && Number.isFinite(obj.h) && obj.h > 0 ? obj.h : im.naturalHeight || 1;
      // Quarter turns are exact: trig roundoff must not add a padding pixel.
      const cos = rotation % 90 === 0 ? Number(rotation % 180 === 0) : Math.abs(Math.cos(angle));
      const sin = rotation % 90 === 0 ? 1 - cos : Math.abs(Math.sin(angle));
      const boundWidth = width * cos + height * sin, boundHeight = width * sin + height * cos;
      const scale = sized ? Math.min(2, 4096 / Math.max(boundWidth, boundHeight)) : 1;
      const pixels = n => Math.max(1, rotation ? Math.min(4096, Math.ceil(n * scale)) : Math.round(n * scale));
      canvas.width = pixels(boundWidth);
      canvas.height = pixels(boundHeight);
      const ctx = canvas.getContext('2d');
      const drawWidth = rotation ? width * scale : canvas.width;
      const drawHeight = rotation ? height * scale : canvas.height;
      if (rotation) {
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(angle);
        ctx.scale(obj.flipH ? -1 : 1, obj.flipV ? -1 : 1);
        ctx.translate(-drawWidth / 2, -drawHeight / 2);
      } else if (obj.flipH || obj.flipV) {
        ctx.translate(obj.flipH ? canvas.width : 0, obj.flipV ? canvas.height : 0);
        ctx.scale(obj.flipH ? -1 : 1, obj.flipV ? -1 : 1);
      }
      if (obj.srcRect || obj.fillRect) drawPicture(ctx, im, obj, drawWidth, drawHeight);
      else ctx.drawImage(im, 0, 0, drawWidth, drawHeight);
      // Picture Format's corrections, grayscale and transparency, drawn into the pixels as the sheet shows them.
      if (obj.adjust || obj.recolor || obj.transparency) {
        try {
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
          applyPictureFilter(pixels.data, obj);
          ctx.putImageData(pixels, 0, 0);
        } catch { /* a canvas that cannot be read keeps the picture as drawn */ }
      }
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('no blob')), 'image/png');
    };
    im.onerror = () => reject(new Error('bad image'));
    im.src = src;
  });
}
