// Running filters: one destructive filter, a Live Filter stack or the Filter
// Gallery's effect layers. Pure functions on RGBA8 so the worker and tests use
// them unchanged.
import { compositeRGBA8, isBlendMode, type BlendMode } from '../../imaging/blend';
import { checkCancelled, cloneRGBA8, type Mask8, type OperationContext, type ParamValues, type Progress, type RGBA8 } from '../../imaging/types';
import { GALLERY_ID, RESTORE_ID, filterOp, galleryEffects, normalizeFor } from './catalog';

export type StackEntry = {
  id: string;
  params: ParamValues;
  enabled?: boolean;
  // Blending of the filter result onto its input (Live Filter blending options).
  opacity?: number;
  blend?: BlendMode;
  seed?: number;
};
export type StackContext = Omit<OperationContext, 'selection'>;

function sub(progress: Progress | undefined, a: number, b: number): Progress | undefined {
  if (!progress) return undefined;
  return { report: (f) => progress.report?.(a + (b - a) * Math.max(0, Math.min(1, f))), cancelled: progress.cancelled };
}

/** Apply one operation (or the gallery pseudo-operation) by ID. */
export async function runOperation(id: string, src: RGBA8, params: ParamValues, ctx: OperationContext, progress?: Progress): Promise<RGBA8> {
  if (id === GALLERY_ID) {
    // Effect layers run in order on the whole region; the selection limits the
    // combined result once, as with any single filter.
    const effects = galleryEffects(params).filter((x) => x.enabled);
    let cur = src;
    for (let i = 0; i < effects.length; i++) {
      checkCancelled(progress);
      cur = await runOperation(effects[i].id, cur, effects[i].params, { ...ctx, selection: undefined }, sub(progress, i / effects.length, (i + 1) / effects.length));
    }
    return ctx.selection ? mixByMask(src, cur === src ? cloneRGBA8(src) : cur, ctx.selection) : cur === src ? cloneRGBA8(src) : cur;
  }
  if (id === RESTORE_ID) {
    // Portrait & Restore loads its algorithms on first use (Live Filters, actions).
    const { applyRestore } = await import('../../imaging/restore/pipeline');
    return applyRestore(src, params, ctx, progress);
  }
  const op = filterOp(id);
  if (!op) throw new Error(`Unknown filter: ${id}`);
  return op.apply(src, normalizeFor(id, params), ctx, progress);
}

/** Run enabled entries in order, blending each result onto its input. With a
 * selection each filter is limited by it; a Live Filter mask instead mixes
 * the final result with the source. */
export async function runStack(
  src: RGBA8,
  entries: StackEntry[],
  ctx: StackContext,
  opts: { selection?: Mask8; mask?: Mask8 } = {},
  progress?: Progress,
): Promise<RGBA8> {
  const active = entries.filter((x) => x.enabled !== false);
  let cur = src;
  for (let i = 0; i < active.length; i++) {
    const x = active[i];
    checkCancelled(progress);
    const out = await runOperation(x.id, cur, x.params, { ...ctx, seed: x.seed ?? ctx.seed, selection: opts.selection }, sub(progress, i / active.length, (i + 1) / active.length));
    const blend = x.blend && isBlendMode(x.blend) ? x.blend : 'normal';
    const opacity = x.opacity ?? 1;
    cur = blend === 'normal' && opacity >= 1 ? out : fadeMix(cur, out, blend, opacity);
  }
  if (opts.mask) cur = mixByMask(src, cur === src ? cloneRGBA8(src) : cur, opts.mask);
  progress?.report?.(1);
  return cur === src ? cloneRGBA8(src) : cur;
}

/** Fade: the filtered image blended onto the original with a mode, then mixed
 * by opacity. Normal mode is a straight mix, so transparency changes made by
 * the filter (erased or new pixels) fade too. */
export function fadeMix(before: RGBA8, after: RGBA8, mode: BlendMode, opacity: number): RGBA8 {
  let blended = after;
  if (mode !== 'normal') {
    blended = cloneRGBA8(before);
    compositeRGBA8(blended, after, mode, 1);
  }
  return lerpRGBA(before, blended, Math.max(0, Math.min(1, opacity)));
}
/** Alpha-weighted mix of two images: t = 0 gives `a`, 1 gives `b`. */
export function lerpRGBA(a: RGBA8, b: RGBA8, t: number, out = new Uint8ClampedArray(a.data.length)): RGBA8 {
  const ad = a.data,
    bd = b.data;
  for (let i = 0; i < ad.length; i += 4) {
    const aa = ad[i + 3] * (1 - t),
      ba = bd[i + 3] * t,
      alpha = aa + ba;
    if (alpha <= 0) {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
      continue;
    }
    out[i] = (ad[i] * aa + bd[i] * ba) / alpha;
    out[i + 1] = (ad[i + 1] * aa + bd[i + 1] * ba) / alpha;
    out[i + 2] = (ad[i + 2] * aa + bd[i + 2] * ba) / alpha;
    out[i + 3] = alpha;
  }
  return { width: a.width, height: a.height, data: out };
}
/** Per-pixel mix by coverage: 0 keeps `before`, 255 takes `after` (in place). */
export function mixByMask(before: RGBA8, after: RGBA8, mask: Mask8): RGBA8 {
  const bd = before.data,
    od = after.data,
    m = mask.data;
  for (let p = 0, i = 0; p < m.length; p++, i += 4) {
    const k = m[p];
    if (k === 255) continue;
    if (k === 0) {
      od[i] = bd[i];
      od[i + 1] = bd[i + 1];
      od[i + 2] = bd[i + 2];
      od[i + 3] = bd[i + 3];
      continue;
    }
    const t = k / 255,
      aa = bd[i + 3] * (1 - t),
      ba = od[i + 3] * t,
      alpha = aa + ba;
    if (alpha <= 0) {
      od[i] = od[i + 1] = od[i + 2] = od[i + 3] = 0;
      continue;
    }
    od[i] = (bd[i] * aa + od[i] * ba) / alpha;
    od[i + 1] = (bd[i + 1] * aa + od[i + 1] * ba) / alpha;
    od[i + 2] = (bd[i + 2] * aa + od[i + 2] * ba) / alpha;
    od[i + 3] = alpha;
  }
  return after;
}

/** Half-size reduction with alpha-weighted 2x2 averaging (odd edges repeat). */
export function halveRGBA(src: RGBA8): RGBA8 {
  const w = Math.max(1, Math.ceil(src.width / 2)),
    h = Math.max(1, Math.ceil(src.height / 2));
  const out = new Uint8ClampedArray(w * h * 4),
    d = src.data,
    sw = src.width,
    sh = src.height;
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(sh - 1, y * 2),
      y1 = Math.min(sh - 1, y * 2 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(sw - 1, x * 2),
        x1 = Math.min(sw - 1, x * 2 + 1);
      const i0 = (y0 * sw + x0) * 4,
        i1 = (y0 * sw + x1) * 4,
        i2 = (y1 * sw + x0) * 4,
        i3 = (y1 * sw + x1) * 4;
      const a0 = d[i0 + 3],
        a1 = d[i1 + 3],
        a2 = d[i2 + 3],
        a3 = d[i3 + 3],
        a = a0 + a1 + a2 + a3;
      const o = (y * w + x) * 4;
      if (!a) continue;
      out[o] = (d[i0] * a0 + d[i1] * a1 + d[i2] * a2 + d[i3] * a3) / a;
      out[o + 1] = (d[i0 + 1] * a0 + d[i1 + 1] * a1 + d[i2 + 1] * a2 + d[i3 + 1] * a3) / a;
      out[o + 2] = (d[i0 + 2] * a0 + d[i1 + 2] * a1 + d[i2 + 2] * a2 + d[i3 + 2] * a3) / a;
      out[o + 3] = a / 4;
    }
  }
  return { width: w, height: h, data: out };
}
export function halveMask(src: Mask8): Mask8 {
  const w = Math.max(1, Math.ceil(src.width / 2)),
    h = Math.max(1, Math.ceil(src.height / 2));
  const out = new Uint8Array(w * h),
    d = src.data,
    sw = src.width,
    sh = src.height;
  for (let y = 0; y < h; y++) {
    const r0 = Math.min(sh - 1, y * 2) * sw,
      r1 = Math.min(sh - 1, y * 2 + 1) * sw;
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(sw - 1, x * 2),
        x1 = Math.min(sw - 1, x * 2 + 1);
      out[y * w + x] = (d[r0 + x0] + d[r0 + x1] + d[r1 + x0] + d[r1 + x1] + 2) >> 2;
    }
  }
  return { width: w, height: h, data: out };
}
export function cropRGBA(src: RGBA8, x: number, y: number, w: number, h: number): RGBA8 {
  const out = new Uint8ClampedArray(w * h * 4);
  const x0 = Math.max(0, x),
    x1 = Math.min(src.width, x + w);
  if (x1 > x0)
    for (let r = 0; r < h; r++) {
      const sy = y + r;
      if (sy < 0 || sy >= src.height) continue;
      out.set(src.data.subarray((sy * src.width + x0) * 4, (sy * src.width + x1) * 4), (r * w + (x0 - x)) * 4);
    }
  return { width: w, height: h, data: out };
}
export function cropMask(src: Mask8, x: number, y: number, w: number, h: number): Mask8 {
  const out = new Uint8Array(w * h);
  const x0 = Math.max(0, x),
    x1 = Math.min(src.width, x + w);
  if (x1 > x0)
    for (let r = 0; r < h; r++) {
      const sy = y + r;
      if (sy < 0 || sy >= src.height) continue;
      out.set(src.data.subarray(sy * src.width + x0, sy * src.width + x1), r * w + (x0 - x));
    }
  return { width: w, height: h, data: out };
}
/** Grayscale RGBA view of a mask (masks are filtered as gray images). */
export function maskToRGBA(m: Mask8): RGBA8 {
  const out = new Uint8ClampedArray(m.data.length * 4);
  for (let i = 0; i < m.data.length; i++) {
    const v = m.data[i];
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return { width: m.width, height: m.height, data: out };
}
/** Luminance of a filtered gray image back to mask values. */
export function rgbaToMask(img: RGBA8): Mask8 {
  const out = new Uint8Array(img.width * img.height);
  const d = img.data;
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
  return { width: img.width, height: img.height, data: out };
}
