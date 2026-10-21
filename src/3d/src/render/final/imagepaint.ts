// Painting directly on an image in the Image Editor (Paint mode) with the shared Texture Paint
// brushes and colors: Paint, Soften, Smear, Clone and Fill, the brush's stroke method, stabilizer,
// pen pressure, falloff and hardness, brush texture / mask texture (including stencils), the clone
// source (Ctrl+click; right-drag moves it), plus the UV wire overlay of the active mesh.
import { app, registerOperators } from '../../app/app';
import type { ImageData as Img } from '../../data/types';
import { imageCanvas, imageTexture } from '../images';
import { activeBrush, ensureBrushes, type PaintBrush } from '../../paint/brushes';
import { blendColor, cachedCurveTable, falloff, linearToSrgb, type BlendMode, type Falloff } from '../../paint/math';
import { commitImage } from '../../paint/tpaint';
import { runStroke, type StrokeView } from '../../paint/stroke';
import { dabMaskAt, dabTextureColor, dabTextureAt, maskTextureActive, textureActive } from '../../paint/brushtex';
import { modifiedImages } from './imageops';
import { stencilControlIn, textureStencils } from '../../paint/stencil';

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
  /** pixels at the start of the stroke (cancel, anchored strokes) */
  orig?: Uint8ClampedArray;
  /** per pixel paint already applied this stroke (limits build-up to the brush strength) */
  acc: Float32Array;
  dirty: [number, number, number, number];
}

/** Clone source of 2D painting: image pixel offset from the painted pixel to its source. */
export const clone2D = { set: false, x: 0, y: 0, offset: [0, 0] as [number, number], image: null as string | null };

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

/** Per-dab extras: brush texture color / strength, clone source, hardness. */
export interface DabExtras {
  hardness?: number;
  /** custom falloff curve table */
  curve?: Float32Array | null;
  /** texture strength factor at an image pixel (mask texture, or the texture for non-paint tools) */
  strengthAt?: ((x: number, y: number) => number) | null;
  /** texture color (display RGBA) at an image pixel, null outside a stencil */
  colorAt?: ((x: number, y: number, out: number[]) => number[] | null) | null;
  /** clone: source pixels and the offset from the painted pixel to its source */
  clone?: { data: Uint8ClampedArray; W: number; H: number; dx: number; dy: number } | null;
}

/** One dab at image position (cx, cy) with radius r (image pixels). Exported for tests. */
export function dab(w: Work, tool: string, cx: number, cy: number, r: number, strength: number, fall: Falloff, color: number[], mode: BlendMode, smearFrom?: [number, number], ex: DabExtras = {}) {
  const p = w.data.data;
  const x0 = Math.max(0, Math.floor(cx - r)),
    x1 = Math.min(w.W - 1, Math.ceil(cx + r)),
    y0 = Math.max(0, Math.floor(cy - r)),
    y1 = Math.min(w.H - 1, Math.ceil(cy + r));
  if (x1 < x0 || y1 < y0) return;
  const src = tool === 'SOFTEN' || tool === 'SMEAR' ? p.slice() : null;
  const dst = [0, 0, 0, 1],
    out = [0, 0, 0, 1],
    col = [0, 0, 0],
    tc = [1, 1, 1, 1],
    pc = [0, 0, 0];
  const hard = ex.hardness ?? 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r) continue;
      let k = falloff(fall, d / r, hard, ex.curve) * strength;
      if (k <= 0) continue;
      if (ex.strengthAt) k *= ex.strengthAt(x + 0.5, y + 0.5);
      let paint = color;
      if (ex.colorAt && tool === 'DRAW') {
        if (!ex.colorAt(x + 0.5, y + 0.5, tc)) continue;
        k *= tc[3];
        pc[0] = color[0] * tc[0];
        pc[1] = color[1] * tc[1];
        pc[2] = color[2] * tc[2];
        paint = pc;
      }
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
      } else if (tool === 'CLONE') {
        const cl = ex.clone;
        if (!cl) continue;
        const sx = Math.floor(x + cl.dx),
          sy = Math.floor(y + cl.dy);
        if (sx < 0 || sy < 0 || sx >= cl.W || sy >= cl.H) continue;
        const px = y * w.W + x;
        const add = Math.max(0, Math.min(k, strength) - w.acc[px]);
        if (add <= 0) continue;
        w.acc[px] += add;
        const a = Math.min(1, add / Math.max(1e-6, 1 - (w.acc[px] - add)));
        const j = (sy * cl.W + sx) * 4;
        for (let c = 0; c < 4; c++) out[c] = dst[c] + (cl.data[j + c] / 255 - dst[c]) * a;
      } else if (tool === 'SMEAR') {
        continue;
      } else {
        // limit build-up within one stroke to the brush strength
        const px = y * w.W + x;
        const add = Math.max(0, Math.min(k, strength) - w.acc[px]);
        if (add <= 0) continue;
        w.acc[px] += add;
        const a = add / Math.max(1e-6, 1 - (w.acc[px] - add));
        blendColor(mode, dst, paint, Math.min(1, a), out);
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

/** Editor pixels for an image pixel (the inverse of `host.toImage`, which is a pan and zoom). */
function screenOf(host: PaintHost) {
  const [ox, oy] = host.toImage(0, 0);
  const z = host.zoom;
  return (ix: number, iy: number): [number, number] => [(ix - ox) * z, (iy - oy) * z];
}

/** Clone source pixels: another image, or the painted image as it was when the stroke started. */
function cloneData(b: PaintBrush, w: Work): { data: Uint8ClampedArray; W: number; H: number } {
  const srcId = b.clone_image && b.clone_image !== w.img.id ? b.clone_image : null;
  const src = srcId ? app.doc.images[srcId] : null;
  if (src) {
    const c = imageCanvas(src);
    const g = c.getContext('2d', { willReadFrequently: true });
    if (g) return { data: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  }
  return { data: w.orig ?? w.data.data.slice(), W: w.W, H: w.H };
}

/** Paint a stroke with the active Texture Paint brush (Ctrl: secondary color, Shift: soften). */
export function imagePaintStroke(host: PaintHost, img: Img, e: PointerEvent): boolean {
  const b = paintBrush();
  if (!b) return false;
  const live = app.doc.images[img.id];
  if (!live) return false;
  const w = makeWork(live);
  w.orig = w.data.data.slice();
  const up = app.doc.scene.tool_settings.unified_paint;
  const invert = e.ctrlKey || e.metaKey;
  const tool = e.shiftKey ? 'SOFTEN' : b.sculpt_tool === 'TEXDRAW' ? 'DRAW' : b.sculpt_tool;
  const lin = invert && tool !== 'CLONE' ? up.secondary_color : up.color;
  const color = [linearToSrgb(lin[0]), linearToSrgb(lin[1]), linearToSrgb(lin[2])];
  const mode = (b.blend ?? 'MIX') as BlendMode;
  const r = host.el.getBoundingClientRect();
  const at = (ev: { clientX: number; clientY: number }) => host.toImage(ev.clientX - r.left, ev.clientY - r.top);
  const strength = Math.max(0, b.strength);
  const start = at(e);
  if (tool === 'FILL') {
    floodFill(w, Math.floor(start[0]), Math.floor(start[1]), color, strength || 1, mode);
    flush(w);
    host.draw();
    modifiedImages.add(live.id);
    void commitImage(live, 'Image Paint');
    return true;
  }
  let cloneSrc: DabExtras['clone'] = null;
  if (tool === 'CLONE') {
    if (invert) {
      // Ctrl+click: pick the clone source point
      clone2D.set = true;
      clone2D.x = start[0];
      clone2D.y = start[1];
      clone2D.image = live.id;
      host.draw();
      return true;
    }
    const cd = cloneData(b, w);
    // the first dab copies from the source point (or straight across from another image)
    const dx = clone2D.set && clone2D.image === live.id && !b.clone_image ? clone2D.x - start[0] : clone2D.offset[0];
    const dy = clone2D.set && clone2D.image === live.id && !b.clone_image ? clone2D.y - start[1] : clone2D.offset[1];
    if (!b.clone_image && !clone2D.set) {
      app.report('INFO', 'Clone: Ctrl+click to set the source point first');
      return true;
    }
    cloneSrc = { ...cd, dx, dy };
  }
  const fall = (b.falloff ?? 'SMOOTH') as Falloff;
  const toScreen = screenOf(host);
  const view: StrokeView = { el: host.el, local: (ev) => ({ x: ev.clientX - r.left, y: ev.clientY - r.top }), drawSvg: () => host.draw() };
  const viewH = host.el.clientHeight;
  let last: [number, number] | null = null;
  let dabIndex = 0;
  runStroke(view, e, {
    spacing: () => Math.max(1, b.spacing || 10),
    radiusPx: () => b.radius,
    settings: () => b,
    canRestore: true,
    dab: (d) => {
      if (d.restore && w.orig) {
        // anchored / drag dot: start over from the pixels before the stroke
        w.data.data.set(w.orig);
        w.acc.fill(0);
        mark(w, 0, 0, w.W - 1, w.H - 1);
      }
      const [ix, iy] = host.toImage(d.x, d.y);
      const radius = Math.max(0.5, ((d.radiusPx ?? b.radius) * (d.sizeFactor ?? 1)) / host.zoom);
      const place = { cx: d.x, cy: d.y, radiusPx: (d.radiusPx ?? b.radius) * (d.sizeFactor ?? 1), index: dabIndex++, viewH };
      const colorAt = tool === 'DRAW' && textureActive(b) ? dabTextureColor(b, place) : null;
      const strengthAt = tool === 'DRAW' ? (maskTextureActive(b) ? dabMaskAt(b, place) : null) : dabTextureAt(b, place);
      const ex: DabExtras = {
        hardness: b.hardness ?? 0,
        curve: b.falloff === 'CUSTOM' ? cachedCurveTable(b.falloff_curve) : null,
        colorAt: colorAt ? (x, y, out) => colorAt(...toScreen(x, y), x, y, 0, out) : null,
        strengthAt: strengthAt ? (x, y) => strengthAt(...toScreen(x, y), x, y, 0) : null,
        clone: cloneSrc,
      };
      dab(w, tool, ix, iy, radius, strength * d.pressure, fall, color, mode, last ?? undefined, ex);
      last = [ix, iy];
    },
    update: () => {
      flush(w);
      host.draw();
    },
    cancel: () => {
      if (w.orig) w.data.data.set(w.orig);
      mark(w, 0, 0, w.W - 1, w.H - 1);
      flush(w);
      host.draw();
    },
    end: () => {
      flush(w);
      host.draw();
      modifiedImages.add(live.id);
      // a source point follows the stroke (aligned cloning)
      if (cloneSrc && clone2D.set && !b.clone_image) clone2D.offset = [cloneSrc.dx, cloneSrc.dy];
      void commitImage(live, 'Image Paint');
    },
  });
  return true;
}

/**
 * Right-drag in Paint mode with the Clone brush: move the clone source. Returns true when it
 * took the press.
 */
export function imagePaintRightDown(host: PaintHost & { area?: unknown }, e: PointerEvent): boolean {
  if (e.button !== 2) return false;
  // a stencil texture: move / scale / rotate it
  if (stencilControlIn({ el: host.el, redraw: () => host.draw() }, e)) {
    e.preventDefault();
    return true;
  }
  const b = paintBrush();
  if (!b || b.sculpt_tool !== 'CLONE') return false;
  e.preventDefault();
  grabHost = host;
  app.run('paint.grab_clone', {}, { event: { x: e.clientX, y: e.clientY } });
  return true;
}

let grabHost: PaintHost | null = null;
const stencilImages = new Map<string, HTMLImageElement>();

function moveClone(dx: number, dy: number) {
  clone2D.x += dx;
  clone2D.y += dy;
  clone2D.offset = [clone2D.offset[0] + dx, clone2D.offset[1] + dy];
}

registerOperators([
  {
    idname: 'paint.grab_clone',
    label: 'Grab Clone',
    description: 'Move the source of the Clone brush (in image pixels)',
    props: [{ id: 'delta', label: 'Delta', type: 'vec2', default: [0, 0] }],
    undo: false,
    poll: () => paintBrush()?.sculpt_tool === 'CLONE',
    invoke: (ctx) => {
      const host = grabHost;
      if (!host || !ctx.event) return 'CANCELLED';
      const z = host.zoom;
      const sx = ctx.event.x,
        sy = ctx.event.y;
      const p0 = { x: clone2D.x, y: clone2D.y, o: [...clone2D.offset] as [number, number] };
      const apply = (ev: PointerEvent) => {
        clone2D.x = p0.x;
        clone2D.y = p0.y;
        clone2D.offset = [...p0.o];
        moveClone((ev.clientX - sx) / z, (ev.clientY - sy) / z);
        host.draw();
      };
      app.startModal({
        label: 'Grab Clone',
        onPointerMove: apply,
        onPointerUp: (ev) => (ev.button === 2 || ev.button === 0 ? 'FINISHED' : undefined),
        onKey: (ev) => (ev.type === 'keydown' && ev.key === 'Escape' ? 'CANCELLED' : true),
        cancel: () => {
          clone2D.x = p0.x;
          clone2D.y = p0.y;
          clone2D.offset = p0.o;
          host.draw();
        },
        header: () => 'Move the clone source · release to confirm',
      });
      return 'RUNNING_MODAL';
    },
    exec: (_ctx, p) => {
      const d = (p.delta as number[]) ?? [0, 0];
      moveClone(d[0] ?? 0, d[1] ?? 0);
      grabHost?.draw();
    },
  },
]);

/** Clone source marker over the image (editor pixels from image pixels). */
export function drawPaintOverlay(ctx: CanvasRenderingContext2D, imageToScreen: (x: number, y: number) => [number, number], imageId: string | null, viewH = 0, redraw?: () => void) {
  // stencils of the brush textures
  for (const st of viewH ? textureStencils(viewH) : []) {
    let im = stencilImages.get(st.url);
    if (!im) {
      im = new Image();
      im.onload = () => redraw?.();
      im.src = st.url;
      if (stencilImages.size > 8) stencilImages.clear();
      stencilImages.set(st.url, im);
    }
    if (!im.complete) continue;
    ctx.save();
    ctx.translate(st.cx, st.cy);
    ctx.rotate(-st.angle);
    ctx.globalAlpha = st.alpha;
    ctx.drawImage(im, -st.hw, -st.hh, st.hw * 2, st.hh * 2);
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(-st.hw, -st.hh, st.hw * 2, st.hh * 2);
    ctx.restore();
  }
  const b = paintBrush();
  if (!b || b.sculpt_tool !== 'CLONE' || !clone2D.set || clone2D.image !== imageId) return;
  const [x, y] = imageToScreen(clone2D.x, clone2D.y);
  ctx.save();
  for (const [col, wdt] of [
    ['rgba(0, 0, 0,0.6)', 3],
    ['#ffffff', 1.2],
  ] as [string, number][]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = wdt;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.moveTo(x - 11, y);
    ctx.lineTo(x + 11, y);
    ctx.moveTo(x, y - 11);
    ctx.lineTo(x, y + 11);
    ctx.stroke();
  }
  ctx.restore();
}
