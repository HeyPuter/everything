// Painting directly on an image in the Image Editor (Paint mode): Paint, Soften, Smear and Fill
// with the shared Texture Paint brushes and colors, plus the UV wire overlay of the active mesh.
import { app } from '../../app/app';
import type { ImageData as Img } from '../../data/types';
import { imageCanvas, imageTexture } from '../images';
import { activeBrush, ensureBrushes, type PaintBrush } from '../../paint/brushes';
import { blendColor, falloff, linearToSrgb, type BlendMode, type Falloff } from '../../paint/math';
import { commitImage } from '../../paint/tpaint';
import { modifiedImages } from './imageops';

export interface PaintHost {
  el: HTMLElement;
  /** editor pixel → image pixel (top-left origin) */
  toImage(sx: number, sy: number): [number, number];
  zoom: number;
  draw(): void;
}

interface Work {
  img: Img;
  W: number;
  H: number;
  ctx: CanvasRenderingContext2D;
  data: globalThis.ImageData;
  /** per pixel paint already applied this stroke (limits build-up to the brush strength) */
  acc: Float32Array;
  dirty: [number, number, number, number];
}

export function paintBrush(): PaintBrush | null {
  ensureBrushes(app.doc);
  return activeBrush('TEXTURE_PAINT');
}

function mark(w: Work, x0: number, y0: number, x1: number, y1: number) {
  const d = w.dirty;
  d[0] = Math.min(d[0], x0);
  d[1] = Math.min(d[1], y0);
  d[2] = Math.max(d[2], x1);
  d[3] = Math.max(d[3], y1);
}

function flush(w: Work) {
  const [x0, y0, x1, y1] = w.dirty;
  if (x1 < x0) return;
  w.ctx.putImageData(w.data, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  w.dirty = [Infinity, Infinity, -1, -1];
  imageTexture(w.img).needsUpdate = true;
}

/** One dab at image position (cx, cy) with radius r (image pixels). Exported for tests. */
export function dab(w: Work, tool: string, cx: number, cy: number, r: number, strength: number, fall: Falloff, color: number[], mode: BlendMode, smearFrom?: [number, number]) {
  const p = w.data.data;
  const x0 = Math.max(0, Math.floor(cx - r)),
    x1 = Math.min(w.W - 1, Math.ceil(cx + r)),
    y0 = Math.max(0, Math.floor(cy - r)),
    y1 = Math.min(w.H - 1, Math.ceil(cy + r));
  if (x1 < x0 || y1 < y0) return;
  const src = tool === 'SOFTEN' || tool === 'SMEAR' ? p.slice() : null;
  const dst = [0, 0, 0, 1],
    out = [0, 0, 0, 1],
    col = [0, 0, 0];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r) continue;
      const k = falloff(fall, d / r) * strength;
      if (k <= 0) continue;
      const i = (y * w.W + x) * 4;
      for (let c = 0; c < 4; c++) dst[c] = p[i + c] / 255;
      if (tool === 'SOFTEN') {
        // average of the 3×3 neighbourhood
        let n = 0;
        col[0] = col[1] = col[2] = 0;
        let a = 0;
        for (let oy = -1; oy <= 1; oy++)
          for (let ox = -1; ox <= 1; ox++) {
            const xx = Math.min(w.W - 1, Math.max(0, x + ox)),
              yy = Math.min(w.H - 1, Math.max(0, y + oy));
            const j = (yy * w.W + xx) * 4;
            col[0] += src![j];
            col[1] += src![j + 1];
            col[2] += src![j + 2];
            a += src![j + 3];
            n++;
          }
        for (let c = 0; c < 3; c++) out[c] = dst[c] + (col[c] / n / 255 - dst[c]) * k;
        out[3] = dst[3] + (a / n / 255 - dst[3]) * k;
      } else if (tool === 'SMEAR' && smearFrom) {
        const xx = Math.round(x - (cx - smearFrom[0])),
          yy = Math.round(y - (cy - smearFrom[1]));
        if (xx < 0 || yy < 0 || xx >= w.W || yy >= w.H) continue;
        const j = (yy * w.W + xx) * 4;
        for (let c = 0; c < 4; c++) out[c] = dst[c] + (src![j + c] / 255 - dst[c]) * k;
      } else {
        // limit build-up within one stroke to the brush strength
        const px = y * w.W + x;
        const add = Math.max(0, Math.min(k, strength) - w.acc[px]);
        if (add <= 0) continue;
        w.acc[px] += add;
        const a = add / Math.max(1e-6, 1 - (w.acc[px] - add));
        blendColor(mode, dst, color, Math.min(1, a), out);
      }
      for (let c = 0; c < 4; c++) p[i + c] = Math.round(Math.max(0, Math.min(1, out[c])) * 255);
    }
  mark(w, x0, y0, x1, y1);
}

/** Bucket fill of the contiguous region of similar color around (x, y). */
export function floodFill(w: Work, x: number, y: number, color: number[], strength: number, mode: BlendMode, threshold = 0.15) {
  const p = w.data.data;
  if (x < 0 || y < 0 || x >= w.W || y >= w.H) return;
  const s = (y * w.W + x) * 4;
  const ref = [p[s], p[s + 1], p[s + 2], p[s + 3]];
  const seen = new Uint8Array(w.W * w.H);
  const stack = [y * w.W + x];
  const dst = [0, 0, 0, 1],
    out = [0, 0, 0, 1];
  const t = threshold * 255 * 2;
  let minX = x,
    maxX = x,
    minY = y,
    maxY = y;
  while (stack.length) {
    const q = stack.pop()!;
    if (seen[q]) continue;
    seen[q] = 1;
    const i = q * 4;
    if (Math.abs(p[i] - ref[0]) + Math.abs(p[i + 1] - ref[1]) + Math.abs(p[i + 2] - ref[2]) + Math.abs(p[i + 3] - ref[3]) > t) continue;
    const qx = q % w.W,
      qy = (q - qx) / w.W;
    minX = Math.min(minX, qx);
    maxX = Math.max(maxX, qx);
    minY = Math.min(minY, qy);
    maxY = Math.max(maxY, qy);
    if (qx > 0) stack.push(q - 1);
    if (qx < w.W - 1) stack.push(q + 1);
    if (qy > 0) stack.push(q - w.W);
    if (qy < w.H - 1) stack.push(q + w.W);
  }
  for (let q = 0; q < seen.length; q++) {
    if (!seen[q]) continue;
    const i = q * 4;
    if (Math.abs(p[i] - ref[0]) + Math.abs(p[i + 1] - ref[1]) + Math.abs(p[i + 2] - ref[2]) + Math.abs(p[i + 3] - ref[3]) > t) continue;
    for (let c = 0; c < 4; c++) dst[c] = p[i + c] / 255;
    blendColor(mode, dst, color, strength, out);
    for (let c = 0; c < 4; c++) p[i + c] = Math.round(Math.max(0, Math.min(1, out[c])) * 255);
  }
  mark(w, minX, minY, maxX, maxY);
}

export function makeWork(img: Img): Work {
  const canvas = imageCanvas(img);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const W = canvas.width,
    H = canvas.height;
  return { img, W, H, ctx, data: ctx.getImageData(0, 0, W, H), acc: new Float32Array(W * H), dirty: [Infinity, Infinity, -1, -1] };
}

/** Paint a stroke with the active Texture Paint brush (Ctrl: secondary color, Shift: soften). */
export function imagePaintStroke(host: PaintHost, img: Img, e: PointerEvent): boolean {
  const b = paintBrush();
  if (!b) return false;
  const live = app.doc.images[img.id];
  if (!live) return false;
  const w = makeWork(live);
  const up = app.doc.scene.tool_settings.unified_paint;
  const invert = e.ctrlKey || e.metaKey;
  const tool = e.shiftKey ? 'SOFTEN' : b.sculpt_tool === 'TEXDRAW' ? 'DRAW' : b.sculpt_tool;
  const lin = invert ? up.secondary_color : up.color;
  const color = [linearToSrgb(lin[0]), linearToSrgb(lin[1]), linearToSrgb(lin[2])];
  const mode = (b.blend ?? 'MIX') as BlendMode;
  const r = host.el.getBoundingClientRect();
  const at = (ev: { clientX: number; clientY: number }) => host.toImage(ev.clientX - r.left, ev.clientY - r.top);
  const radius = () => Math.max(0.5, b.radius / host.zoom);
  const strength = Math.max(0, b.strength);
  let last = at(e);
  if (tool === 'FILL') {
    floodFill(w, Math.floor(last[0]), Math.floor(last[1]), color, strength || 1, mode);
    flush(w);
    host.draw();
    modifiedImages.add(live.id);
    void commitImage(live, 'Image Paint');
    return true;
  }
  const fall = (b.falloff ?? 'SMOOTH') as Falloff;
  dab(w, tool, last[0], last[1], radius(), strength, fall, color, mode);
  flush(w);
  host.draw();
  const move = (ev: PointerEvent) => {
    const p = at(ev);
    const step = Math.max(0.5, (radius() * Math.max(1, b.spacing || 10)) / 100);
    const dist = Math.hypot(p[0] - last[0], p[1] - last[1]);
    const n = Math.floor(dist / step);
    for (let i = 1; i <= n; i++) {
      const t = (i * step) / dist;
      const x = last[0] + (p[0] - last[0]) * t,
        y = last[1] + (p[1] - last[1]) * t;
      const prev: [number, number] = [last[0] + (p[0] - last[0]) * ((i - 1) * step) / dist, last[1] + (p[1] - last[1]) * ((i - 1) * step) / dist];
      dab(w, tool, x, y, radius(), strength, fall, color, mode, prev);
    }
    if (n > 0) last = [last[0] + ((p[0] - last[0]) * n * step) / dist, last[1] + ((p[1] - last[1]) * n * step) / dist];
    flush(w);
    host.draw();
  };
  const end = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    flush(w);
    modifiedImages.add(live.id);
    void commitImage(live, 'Image Paint');
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  return true;
}
