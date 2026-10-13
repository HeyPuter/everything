/**
 * Raster effects (Drop Shadow, Outer Glow, Inner Glow, Gaussian Blur,
 * Feather) for Canvas 2D. A node with effects is first drawn into an
 * offscreen layer (device pixels, same transform as the target), then the
 * layer is composited with its effects:
 *
 *   1. content effects in stacking order: Gaussian Blur, Feather, Inner Glow
 *   2. effects behind the content: Drop Shadow and Outer Glow, which use the
 *      final content's alpha as their shape
 *   3. the content itself
 *
 * Shadows and glows use the canvas shadow with the "shadow only" trick (the
 * source is drawn far off-canvas and the shadow offset brings only the
 * shadow back), which works in every engine. Gaussian Blur uses ctx.filter
 * when available and falls back to a downsample/upsample blur on engines
 * without canvas filters (older Safari).
 *
 * Effect records live in node.effects: { type, hidden, ...params } with
 * lengths in document units (scaled by `scale`, device px per unit).
 */

export const RASTER_EFFECTS = new Set(['dropShadow', 'outerGlow', 'innerGlow', 'blur', 'feather']);

/**
 * Content effects from feature modules (applied in stacking order with
 * Gaussian Blur, Feather and Inner Glow): type -> (layer, effect, scale,
 * pool, info) -> a new layer from pool.acquire(), or null to leave the
 * content. `info` is { transform, x, y, doc, node } when known: the
 * document-to-device matrix (a DOMMatrix-like { a, b, c, d, e, f }) and the
 * layer's device origin, so effects can work in document space. Registering
 * one also makes the type a raster effect. `opts.margin(effect)` is how far
 * (document units) the effect reads past what it covers, so the layer keeps
 * that much off-screen content.
 */
export const contentEffects = new Map();
const contentMargins = new Map();

export function registerContentEffect(type, fn, opts = {}) {
  contentEffects.set(type, fn);
  if (opts.margin) contentMargins.set(type, opts.margin);
  RASTER_EFFECTS.add(type);
}

/** Device-pixel margin to keep around a layer for these effects (at least `min`, at most `max`). */
export function effectsMargin(effects, scale, min = 96, max = 1536) {
  let d = min;
  for (const e of effects || []) {
    const f = contentMargins.get(e.type);
    if (f) d = Math.max(d, (f(e) || 0) * scale + 8);
  }
  return Math.min(max, d);
}

const BLEND = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  colorDodge: 'color-dodge',
  colorBurn: 'color-burn',
  hardLight: 'hard-light',
  softLight: 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

export function rasterEffects(node) {
  const fx = node.effects;
  if (!fx || !fx.length) return null;
  const out = fx.filter((e) => e && !e.hidden && RASTER_EFFECTS.has(e.type));
  return out.length ? out : null;
}

function rgba(hex, a) {
  const n = parseInt(String(hex || '#000000').slice(1), 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}

let filterSupport = null;
/** Whether ctx.filter actually works (Safari exposes nothing, some engines ignore it). */
export function supportsCanvasFilter(ctx) {
  if (filterSupport !== null) return filterSupport;
  filterSupport = Boolean(ctx && 'filter' in ctx);
  if (filterSupport) {
    try {
      const prev = ctx.filter;
      ctx.filter = 'blur(1px)';
      filterSupport = ctx.filter === 'blur(1px)';
      ctx.filter = prev;
    } catch {
      filterSupport = false;
    }
  }
  return filterSupport;
}

/** Draw only the shadow of `img` (blurred, tinted, offset) onto ctx at identity. */
export function drawShadowOnly(ctx, img, color, blurPx, dx = 0, dy = 0, x = 0, y = 0) {
  const off = img.width + Math.abs(dx) + Math.abs(x) + blurPx * 3 + 64;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = Math.max(0, blurPx);
  ctx.shadowOffsetX = dx + off;
  ctx.shadowOffsetY = dy;
  ctx.drawImage(img, x - off, y);
  ctx.restore();
}

/** Copy of `src` blurred by a Gaussian of radius px (CSS blur() semantics). */
function blurred(src, px, pool) {
  const out = pool.acquire(src.width, src.height);
  const c = out.ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (px <= 0.01) {
    c.drawImage(src, 0, 0);
    return out;
  }
  if (supportsCanvasFilter(c)) {
    c.filter = `blur(${px}px)`;
    c.drawImage(src, 0, 0);
    c.filter = 'none';
    return out;
  }
  // Fallback: downsample and upsample with smoothing (two passes approximate a Gaussian).
  const k = Math.max(1, Math.min(32, px / 1.5));
  const w = Math.max(1, Math.round(src.width / k));
  const h = Math.max(1, Math.round(src.height / k));
  const tmp = makeCanvas(w, h);
  const t = tmp.getContext('2d');
  t.imageSmoothingEnabled = true;
  t.imageSmoothingQuality = 'high';
  t.drawImage(src, 0, 0, w, h);
  const tmp2 = makeCanvas(w, h);
  const t2 = tmp2.getContext('2d');
  t2.imageSmoothingQuality = 'high';
  t2.drawImage(tmp, 0, 0, w, h, -0.5, -0.5, w + 1, h + 1);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(tmp2, 0, 0, w, h, 0, 0, src.width, src.height);
  return out;
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

/**
 * Inverse alpha of src (opaque where src is transparent), padded by `pad`
 * px on every side: the layer is cropped tightly around the content, but the
 * "outside" an inner glow blurs inward is unbounded, so it must reach at
 * least as far as the blur kernel (3 sigma) beyond the layer.
 */
function inverseAlpha(src, pool, pad = 0) {
  const inv = pool.acquire(src.width + pad * 2, src.height + pad * 2);
  const c = inv.ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = '#000';
  c.fillRect(0, 0, src.width + pad * 2, src.height + pad * 2);
  c.globalCompositeOperation = 'destination-out';
  c.drawImage(src, pad, pad);
  c.globalCompositeOperation = 'source-over';
  return inv;
}

/** Apply one content effect; returns a new layer (caller releases the old one). */
function contentEffect(layer, e, scale, pool, info) {
  const custom = contentEffects.get(e.type);
  if (custom) return custom(layer, e, scale, pool, info);
  const src = layer.canvas;
  if (e.type === 'blur') return blurred(src, (e.radius || 0) * scale, pool);
  if (e.type === 'feather') {
    const r = Math.max(0, (e.radius || 0) * scale);
    const mask = pool.acquire(src.width, src.height);
    mask.ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawShadowOnly(mask.ctx, src, '#000', r * 2);
    const out = pool.acquire(src.width, src.height);
    out.ctx.setTransform(1, 0, 0, 1, 0, 0);
    out.ctx.drawImage(src, 0, 0);
    out.ctx.globalCompositeOperation = 'destination-in';
    out.ctx.drawImage(mask.canvas, 0, 0);
    out.ctx.globalCompositeOperation = 'source-over';
    pool.release(mask);
    return out;
  }
  if (e.type === 'innerGlow') {
    const blurPx = Math.max(0, (e.blur ?? 5) * scale) * 2;
    const color = rgba(e.color || '#ffffff', e.opacity ?? 0.75);
    const glow = pool.acquire(src.width, src.height);
    glow.ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (e.source === 'center') {
      drawShadowOnly(glow.ctx, src, color, blurPx);
    } else {
      const pad = Math.ceil(blurPx * 1.5) + 2;
      const inv = inverseAlpha(src, pool, pad);
      drawShadowOnly(glow.ctx, inv.canvas, color, blurPx, 0, 0, -pad, -pad);
      pool.release(inv);
    }
    // Keep the glow inside the content.
    glow.ctx.globalCompositeOperation = 'destination-in';
    glow.ctx.drawImage(src, 0, 0);
    glow.ctx.globalCompositeOperation = 'source-over';
    const out = pool.acquire(src.width, src.height);
    out.ctx.setTransform(1, 0, 0, 1, 0, 0);
    out.ctx.drawImage(src, 0, 0);
    out.ctx.globalCompositeOperation = BLEND[e.mode || 'screen'] || 'screen';
    out.ctx.drawImage(glow.canvas, 0, 0);
    out.ctx.globalCompositeOperation = 'source-over';
    pool.release(glow);
    return out;
  }
  return null;
}

/**
 * Composite a rendered layer onto ctx with the effects. ctx must be at the
 * identity transform with the node's opacity and blend mode already set.
 * `info` is passed on to content effects (see registerContentEffect).
 */
export function compositeWithEffects(ctx, layer, effects, scale, pool, x = 0, y = 0, info = null) {
  if (!effects || !effects.length) {
    ctx.drawImage(layer.canvas, x, y);
    return;
  }
  let content = layer;
  const owned = [];
  for (const e of effects) {
    if (e.type !== 'blur' && e.type !== 'feather' && e.type !== 'innerGlow' && !contentEffects.has(e.type)) continue;
    const next = contentEffect(content, e, scale, pool, info && { ...info, x, y });
    if (next) {
      owned.push(next);
      content = next;
    }
  }
  const baseOp = ctx.globalCompositeOperation;
  for (const e of effects) {
    if (e.type === 'dropShadow' && e.shadowFrom === 'darkness') {
      // Darkness: the shadow is the artwork's own colors mixed with black.
      ctx.globalCompositeOperation = e.mode && e.mode !== 'normal' ? BLEND[e.mode] || baseOp : baseOp;
      const dark = pool.acquire(content.canvas.width, content.canvas.height);
      const c = dark.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(content.canvas, 0, 0);
      c.globalCompositeOperation = 'source-atop';
      c.fillStyle = `rgba(0,0,0,${Math.max(0, Math.min(1, e.darkness ?? 1))})`;
      c.fillRect(0, 0, content.canvas.width, content.canvas.height);
      c.globalCompositeOperation = 'source-over';
      const soft = blurred(dark.canvas, (e.blur || 0) * scale * 0.5, pool);
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = alpha * (e.opacity ?? 0.75);
      ctx.drawImage(soft.canvas, x + (e.x || 0) * scale, y + (e.y || 0) * scale);
      ctx.globalAlpha = alpha;
      pool.release(soft);
      pool.release(dark);
    } else if (e.type === 'dropShadow') {
      ctx.globalCompositeOperation = e.mode && e.mode !== 'normal' ? BLEND[e.mode] || baseOp : baseOp;
      drawShadowOnly(ctx, content.canvas, rgba(e.color || '#000000', e.opacity ?? 0.75), (e.blur || 0) * scale, (e.x || 0) * scale, (e.y || 0) * scale, x, y);
    } else if (e.type === 'outerGlow') {
      ctx.globalCompositeOperation = e.mode && e.mode !== 'normal' ? BLEND[e.mode] || baseOp : baseOp;
      const blurPx = Math.max(0, (e.blur ?? 5) * scale) * 2;
      const color = rgba(e.color || '#ffff00', e.opacity ?? 0.75);
      // Two passes give the glow a denser core that fades smoothly outward.
      drawShadowOnly(ctx, content.canvas, color, blurPx, 0, 0, x, y);
      drawShadowOnly(ctx, content.canvas, color, blurPx / 2, 0, 0, x, y);
    }
  }
  ctx.globalCompositeOperation = baseOp;
  ctx.drawImage(content.canvas, x, y);
  for (const l of owned) pool.release(l);
}

/**
 * Offscreen layers sized to the region an effect needs (rounded up to 64 px
 * buckets so they can be reused), instead of the whole viewport: blur and
 * shadow cost grows with the area they process.
 */
export class RegionPool {
  constructor(limit = 24) {
    this.free = new Map();
    this.count = 0;
    this.limit = limit;
  }

  acquire(w, h) {
    const W = Math.max(64, Math.ceil(w / 64) * 64);
    const H = Math.max(64, Math.ceil(h / 64) * 64);
    const key = `${W}x${H}`;
    const list = this.free.get(key);
    let layer = list && list.pop();
    if (layer) {
      this.count--;
      const c = layer.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      c.shadowColor = 'rgba(0,0,0,0)';
      c.shadowBlur = 0;
      if ('filter' in c) c.filter = 'none';
      c.clearRect(0, 0, W, H);
    } else {
      const canvas = makeCanvas(W, H);
      layer = { canvas, ctx: canvas.getContext('2d'), key };
    }
    return layer;
  }

  release(layer) {
    if (!layer || this.count >= this.limit) return;
    let list = this.free.get(layer.key);
    if (!list) this.free.set(layer.key, (list = []));
    list.push(layer);
    this.count++;
  }
}

export const regionPool = new RegionPool();

/**
 * Integer device-pixel region covering document rect `r` under ctx's
 * transform, clipped to the canvas (plus a margin so blurs near the edge
 * still see their neighbors). Null when nothing is visible.
 */
export function deviceRegion(ctx, r, margin = 96) {
  if (!r) return null;
  const m = ctx.getTransform();
  const xs = [];
  const ys = [];
  for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
    xs.push(m.a * x + m.c * y + m.e);
    ys.push(m.b * x + m.d * y + m.f);
  }
  const W = ctx.canvas?.width ?? 4096;
  const H = ctx.canvas?.height ?? 4096;
  const x0 = Math.max(-margin, Math.floor(Math.min(...xs)) - 2);
  const y0 = Math.max(-margin, Math.floor(Math.min(...ys)) - 2);
  const x1 = Math.min(W + margin, Math.ceil(Math.max(...xs)) + 2);
  const y1 = Math.min(H + margin, Math.ceil(Math.max(...ys)) + 2);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
