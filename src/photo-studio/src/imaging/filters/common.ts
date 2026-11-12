// Shared kernels for the pixel filters. Everything works on planar Float32 or
// Uint8 channels so each pass is a tight loop over one typed array; edges are
// clamped (replicated) and anything that averages colors does it on
// alpha-premultiplied values so transparent pixels never bleed black.
import {
  CancelledError,
  checkCancelled,
  cleanPaths,
  cleanPins,
  type ImageOperation,
  type IRect,
  type Mask8,
  type OperationContext,
  type ParamSpec,
  type ParamValues,
  type Progress,
  type RGBA8,
} from '../types';

export type Plane = Float32Array;
export type Point = { x: number; y: number };

// ---------------------------------------------------------------------------
// Operation plumbing

export type Run = (src: RGBA8, p: ParamValues, ctx: OperationContext, progress?: Progress) => RGBA8;

// Wraps a filter body so every operation sanitizes its parameters the same way
// (missing or out-of-range values fall back to or clamp into the spec), always
// returns a new buffer and honors the selection.
//
// Neighborhood filters declare `support`, how far (in pixels of `src`) a
// result pixel can depend on its input. With a selection they then process
// only the selection's bounds grown by that margin, which makes filtering a
// small selection of a large image proportionally cheap. Filters whose output
// depends on absolute position (seeded noise, render, radial centers) omit it.
export type OpDef = Omit<ImageOperation, 'apply'> & {
  run: Run;
  support?: (p: ParamValues, ctx: OperationContext) => number;
  // Reach of the transparent-pixel fill the filter reads (fillTransparent
  // with a reach). A selection crop grows by it only when fully transparent
  // pixels lie within the normal crop: elsewhere the fill changes nothing.
  fillReach?: (p: ParamValues, ctx: OperationContext) => number;
};
export function defineOp(op: OpDef): ImageOperation {
  const { run, support, fillReach, ...meta } = op;
  return {
    ...meta,
    apply(src, params, ctx, progress) {
      const sel = ctx.selection;
      if (sel && (sel.width !== src.width || sel.height !== src.height))
        throw new Error('Selection size does not match the image.');
      checkCancelled(progress);
      const p = sanitize(meta.params, params);
      let out: RGBA8;
      let crop = sel && support ? cropRect(sel, Math.ceil(support(p, ctx))) : null;
      if (crop && crop.width && fillReach && hasTransparentIn(src, crop)) crop = cropRect(sel!, Math.ceil(support!(p, ctx)) + Math.ceil(fillReach(p, ctx)));
      if (crop && crop.width === 0) out = copyImage(src);
      else if (crop && sel && crop.width * crop.height < 0.8 * src.width * src.height) {
        const subSrc = cropImage(src, crop), subSel = cropMask(sel, crop);
        let sub = run(subSrc, p, { ...ctx, selection: subSel }, progress);
        if (sub === subSrc) sub = copyImage(subSrc);
        applySelection(subSrc, sub, subSel);
        out = copyImage(src);
        for (let y = 0; y < crop.height; y++)
          out.data.set(sub.data.subarray(y * crop.width * 4, (y + 1) * crop.width * 4), ((crop.y + y) * src.width + crop.x) * 4);
      } else {
        out = run(src, p, ctx, progress);
        if (out === src) out = copyImage(src);
        if (sel) applySelection(src, out, sel);
      }
      progress?.report?.(1);
      return out;
    },
  };
}

// Bounds of the nonzero selection grown by `margin` and clipped to the
// image; width 0 when nothing is selected.
export function cropRect(sel: Mask8, margin: number): IRect {
  const { width: w, height: h, data } = sel;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (data[o + x]) { first = x; break; }
    if (first < 0) continue;
    for (let x = w - 1; x >= first; x--) if (data[o + x]) { last = x; break; }
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
    if (y < y0) y0 = y;
    y1 = y;
  }
  if (x1 < 0) return { x: 0, y: 0, width: 0, height: 0 };
  x0 = Math.max(0, x0 - margin); y0 = Math.max(0, y0 - margin);
  x1 = Math.min(w - 1, x1 + margin); y1 = Math.min(h - 1, y1 + margin);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
/** True when a pixel inside `r` is fully transparent. */
export function hasTransparentIn(src: RGBA8, r: IRect): boolean {
  const d = src.data;
  for (let y = r.y; y < r.y + r.height; y++)
    for (let j = (y * src.width + r.x) * 4 + 3, end = j + r.width * 4; j < end; j += 4) if (d[j] === 0) return true;
  return false;
}
export function cropImage(src: RGBA8, r: IRect): RGBA8 {
  const data = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    const so = ((r.y + y) * src.width + r.x) * 4;
    data.set(src.data.subarray(so, so + r.width * 4), y * r.width * 4);
  }
  return { width: r.width, height: r.height, data };
}
function cropMask(src: Mask8, r: IRect): Mask8 {
  const data = new Uint8Array(r.width * r.height);
  for (let y = 0; y < r.height; y++) {
    const so = (r.y + y) * src.width + r.x;
    data.set(src.data.subarray(so, so + r.width), y * r.width);
  }
  return { width: r.width, height: r.height, data };
}

export function sanitize(specs: ParamSpec[], params: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const s of specs) {
    const v = params[s.key];
    switch (s.type) {
      case 'number':
        out[s.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, v)) : s.default;
        break;
      case 'select':
        out[s.key] = typeof v === 'string' && s.options.some((o) => o.value === v) ? v : s.default;
        break;
      case 'checkbox':
        out[s.key] = typeof v === 'boolean' ? v : s.default;
        break;
      case 'color':
        out[s.key] = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : s.default;
        break;
      case 'point': {
        const q = v as { x: number; y: number } | undefined;
        out[s.key] = q && typeof q === 'object' && Number.isFinite(q.x) && Number.isFinite(q.y) ? { x: q.x, y: q.y } : s.default;
        break;
      }
      case 'pins':
        out[s.key] = cleanPins(s, v);
        break;
      case 'paths':
        out[s.key] = cleanPaths(s, v);
        break;
    }
  }
  return out;
}

export const num = (p: ParamValues, k: string) => p[k] as number;
export const str = (p: ParamValues, k: string) => p[k] as string;
export const bool = (p: ParamValues, k: string) => p[k] as boolean;
export const point = (p: ParamValues, k: string) => p[k] as Point;
export function hexColor(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
// Radius-like parameters scale with preview resolution.
export const px = (ctx: OperationContext, v: number) => v * (ctx.scale ?? 1);

// Maps a stage of a multi-stage filter into a sub-range of the overall progress.
export function sub(progress: Progress | undefined, a: number, b: number): Progress | undefined {
  if (!progress) return undefined;
  const report = progress.report;
  return { cancelled: progress.cancelled, report: report ? (f) => report(a + (b - a) * f) : undefined };
}
// Per-row heartbeat: cheap enough to call on every row.
export function tick(progress: Progress | undefined, y: number, h: number) {
  if (progress && (y & 15) === 0) {
    if (progress.cancelled?.()) throw new CancelledError();
    progress.report?.(y / h);
  }
}

export function newImage(src: RGBA8): RGBA8 {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data.length) };
}
export function copyImage(src: RGBA8): RGBA8 {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}

// ---------------------------------------------------------------------------
// Selection

// Blends `out` back toward `src` by selection coverage, in place. Partial
// coverage mixes premultiplied colors so a half-selected edge between an
// opaque and a transparent result does not darken.
export function applySelection(src: RGBA8, out: RGBA8, selection: Mask8): RGBA8 {
  const s = src.data, o = out.data, m = selection.data;
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    const t = m[i];
    if (t === 255) continue;
    if (t === 0) {
      o[j] = s[j]; o[j + 1] = s[j + 1]; o[j + 2] = s[j + 2]; o[j + 3] = s[j + 3];
      continue;
    }
    const k = t / 255;
    const as = s[j + 3] * (1 - k), ao = o[j + 3] * k, a = as + ao;
    if (a <= 0) {
      o[j] = s[j]; o[j + 1] = s[j + 1]; o[j + 2] = s[j + 2]; o[j + 3] = 0;
      continue;
    }
    const inv = 1 / a;
    o[j] = (s[j] * as + o[j] * ao) * inv;
    o[j + 1] = (s[j + 1] * as + o[j + 1] * ao) * inv;
    o[j + 2] = (s[j + 2] * as + o[j + 2] * ao) * inv;
    o[j + 3] = a;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Channels and luminance

// Rec. 601 luma on encoded values, the usual weighting for "brightness" in filters.
export const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

export function lumaPlane(src: RGBA8, out = new Float32Array(src.width * src.height)): Plane {
  const d = src.data;
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return out;
}
export function isOpaque(src: RGBA8): boolean {
  const d = src.data;
  for (let j = 3; j < d.length; j += 4) if (d[j] !== 255) return false;
  return true;
}
export function hasTransparent(src: RGBA8): boolean {
  const d = src.data;
  for (let j = 3; j < d.length; j += 4) if (d[j] === 0) return true;
  return false;
}
export function channelPlane(src: RGBA8, c: number, out = new Float32Array(src.width * src.height)): Plane {
  const d = src.data;
  for (let i = 0, j = c; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}
export function premulPlane(src: RGBA8, c: number, out = new Float32Array(src.width * src.height)): Plane {
  const d = src.data, k = 1 / 255;
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j + c] * d[j + 3] * k;
  return out;
}

// Runs a linear plane filter over an image with straight alpha: alpha is
// filtered first, then each premultiplied color channel, which is divided by
// the filtered alpha before `sink` sees it. Opaque images skip the alpha work.
// `filter` may return either of its two buffers.
export type PlaneFilter = (plane: Plane, tmp: Plane, w: number, h: number, progress?: Progress) => Plane;
export function filterChannels(
  src: RGBA8,
  filter: PlaneFilter,
  sink: (c: number, straight: Plane, alpha: Plane | null) => void,
  progress?: Progress,
) {
  const { width: w, height: h, data: d } = src;
  const n = w * h;
  const opaque = isOpaque(src);
  const plane = new Float32Array(n), tmp = new Float32Array(n);
  let alpha: Plane | null = null;
  const steps = opaque ? 3 : 4;
  let step = 0;
  if (!opaque) {
    channelPlane(src, 3, plane);
    alpha = Float32Array.from(filter(plane, tmp, w, h, sub(progress, 0, 1 / steps)));
    sink(3, alpha, alpha);
    step++;
  }
  for (let c = 0; c < 3; c++, step++) {
    if (opaque) channelPlane(src, c, plane);
    else premulPlane(src, c, plane);
    const r = filter(plane, tmp, w, h, sub(progress, step / steps, (step + 1) / steps));
    if (alpha) {
      for (let i = 0, j = c; i < n; i++, j += 4) {
        const a = alpha[i];
        r[i] = a > 1e-3 ? (r[i] * 255) / a : d[j];
      }
    }
    sink(c, r, alpha);
  }
}

// The common case: write the filtered channels straight to a new image.
export function linearFilterRGBA(src: RGBA8, filter: PlaneFilter, progress?: Progress): RGBA8 {
  const out = newImage(src);
  const o = out.data, n = src.width * src.height;
  let wroteAlpha = false;
  filterChannels(
    src,
    filter,
    (c, plane) => {
      if (c === 3) wroteAlpha = true;
      for (let i = 0, j = c; i < n; i++, j += 4) o[j] = plane[i];
    },
    progress,
  );
  if (!wroteAlpha) for (let j = 3; j < o.length; j += 4) o[j] = 255;
  return out;
}

// Fills the color of fully transparent pixels by pull-push interpolation of
// their visible neighbors (Gortler et al. 1996, "The Lumigraph"), keeping their
// alpha at 0. Filters that look at straight neighbor colors (sharpening, edge
// detection, embossing) run on the result so transparent areas, often stored
// as black, do not leak into visible edges. Returns `src` itself when nothing
// is fully transparent.
//
// With `reach`, only transparent pixels within that many pixels (8-connected
// steps) of a visible one are filled, ring by ring from the average of the
// already filled neighbors. That fill depends on nothing farther away, so a
// filter that reads `reach` pixels around each visible pixel gives the same
// result on a crop grown by twice its reach (selections) as on the whole image.
export function fillTransparent(src: RGBA8, reach?: number): RGBA8 {
  if (!hasTransparent(src)) return src;
  if (reach !== undefined) return fillNear(src, Math.max(0, Math.ceil(reach)));
  const { width: w0, height: h0, data: d } = src;
  type Level = { w: number; h: number; c: Float32Array };
  // Each level stores r, g, b, weight.
  const base = new Float32Array(w0 * h0 * 4);
  let any = false;
  for (let i = 0; i < w0 * h0; i++) {
    const j = i * 4;
    if (d[j + 3] > 0) {
      base[j] = d[j]; base[j + 1] = d[j + 1]; base[j + 2] = d[j + 2]; base[j + 3] = 1;
      any = true;
    }
  }
  const out = copyImage(src);
  if (!any) return out;
  const levels: Level[] = [{ w: w0, h: h0, c: base }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const f = levels[levels.length - 1];
    const w = (f.w + 1) >> 1, h = (f.h + 1) >> 1;
    const c = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, wt = 0;
        for (let dy = 0; dy < 2; dy++) {
          const yy = 2 * y + dy;
          if (yy >= f.h) break;
          for (let dx = 0; dx < 2; dx++) {
            const xx = 2 * x + dx;
            if (xx >= f.w) break;
            const k = (yy * f.w + xx) * 4, q = f.c[k + 3];
            r += f.c[k] * q; g += f.c[k + 1] * q; b += f.c[k + 2] * q; wt += q;
          }
        }
        const k = (y * w + x) * 4;
        if (wt > 0) {
          c[k] = r / wt; c[k + 1] = g / wt; c[k + 2] = b / wt; c[k + 3] = Math.min(1, wt);
        }
      }
    levels.push({ w, h, c });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], p = levels[l + 1];
    for (let y = 0; y < f.h; y++) {
      const py = Math.min(p.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(py), y1 = Math.min(p.h - 1, y0 + 1), fy = py - y0;
      for (let x = 0; x < f.w; x++) {
        const k = (y * f.w + x) * 4, q = f.c[k + 3];
        if (q >= 1) continue;
        const pxx = Math.min(p.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(pxx), x1 = Math.min(p.w - 1, x0 + 1), fx = pxx - x0;
        const a = (y0 * p.w + x0) * 4, b = (y0 * p.w + x1) * 4, c = (y1 * p.w + x0) * 4, e = (y1 * p.w + x1) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const top = p.c[a + ch] + (p.c[b + ch] - p.c[a + ch]) * fx;
          const bot = p.c[c + ch] + (p.c[e + ch] - p.c[c + ch]) * fx;
          f.c[k + ch] = f.c[k + ch] * q + (top + (bot - top) * fy) * (1 - q);
        }
        f.c[k + 3] = 1;
      }
    }
  }
  const o = out.data;
  for (let j = 0; j < o.length; j += 4)
    if (d[j + 3] === 0) {
      o[j] = base[j]; o[j + 1] = base[j + 1]; o[j + 2] = base[j + 2];
    }
  return out;
}

function fillNear(src: RGBA8, reach: number): RGBA8 {
  const { width: w, height: h, data: d } = src, n = w * h;
  const out = copyImage(src), o = out.data;
  if (reach <= 0) return out;
  // Chessboard distance to the nearest visible pixel (two chamfer passes),
  // capped past the reach; ring k holds the pixels at distance k.
  const cap = Math.min(reach + 1, 65535);
  const dist = new Uint16Array(n);
  for (let i = 0; i < n; i++) dist[i] = d[i * 4 + 3] > 0 ? 0 : cap;
  for (let y = 0; y < h; y++)
    for (let x = 0, i = y * w; x < w; x++, i++) {
      let v = dist[i];
      if (!v) continue;
      if (x > 0 && dist[i - 1] + 1 < v) v = dist[i - 1] + 1;
      if (y > 0) {
        const u = i - w;
        if (dist[u] + 1 < v) v = dist[u] + 1;
        if (x > 0 && dist[u - 1] + 1 < v) v = dist[u - 1] + 1;
        if (x + 1 < w && dist[u + 1] + 1 < v) v = dist[u + 1] + 1;
      }
      dist[i] = v;
    }
  const count = new Int32Array(reach + 2);
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1, i = y * w + x; x >= 0; x--, i--) {
      let v = dist[i];
      if (v) {
        if (x + 1 < w && dist[i + 1] + 1 < v) v = dist[i + 1] + 1;
        if (y + 1 < h) {
          const u = i + w;
          if (dist[u] + 1 < v) v = dist[u] + 1;
          if (x + 1 < w && dist[u + 1] + 1 < v) v = dist[u + 1] + 1;
          if (x > 0 && dist[u - 1] + 1 < v) v = dist[u - 1] + 1;
        }
        dist[i] = v;
      }
      if (v <= reach) count[v]++;
    }
  if (count[0] === 0) return out;
  // Pixels in ring order; each takes the average of its neighbors in earlier
  // rings, which are final by then.
  const start = new Int32Array(reach + 2);
  for (let k = 1; k <= reach; k++) start[k + 1] = start[k] + count[k];
  const order = new Int32Array(start[reach + 1]);
  for (let i = 0; i < n; i++) {
    const v = dist[i];
    if (v > 0 && v <= reach) order[start[v]++] = i;
  }
  for (let t = 0; t < order.length; t++) {
    const i = order[t], k = dist[i], x = i % w, y = (i - x) / w;
    let r = 0, g = 0, b = 0, m = 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
      for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
        const q = yy * w + xx;
        if (dist[q] >= k) continue;
        r += o[q * 4]; g += o[q * 4 + 1]; b += o[q * 4 + 2];
        m++;
      }
    const j = i * 4;
    o[j] = r / m; o[j + 1] = g / m; o[j + 2] = b / m;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Box blur with running sums, any window [x - a, x + b]

export function boxH(src: Plane, dst: Plane, w: number, h: number, a: number, b: number, progress?: Progress) {
  const n = a + b + 1, inv = 1 / n;
  const pad = new Float32Array(w + n - 1);
  for (let y = 0, off = 0; y < h; y++, off += w) {
    tick(progress, y, h);
    const first = src[off], last = src[off + w - 1];
    for (let i = 0; i < a; i++) pad[i] = first;
    pad.set(src.subarray(off, off + w), a);
    for (let i = a + w; i < pad.length; i++) pad[i] = last;
    let s = 0;
    for (let i = 0; i < n - 1; i++) s += pad[i];
    for (let x = 0; x < w; x++) {
      s += pad[x + n - 1];
      dst[off + x] = s * inv;
      s -= pad[x];
    }
  }
}
export function boxV(src: Plane, dst: Plane, w: number, h: number, a: number, b: number, progress?: Progress) {
  const inv = 1 / (a + b + 1);
  const acc = new Float64Array(w);
  for (let j = -a; j < b; j++) {
    const off = Math.min(h - 1, Math.max(0, j)) * w;
    for (let x = 0; x < w; x++) acc[x] += src[off + x];
  }
  for (let y = 0; y < h; y++) {
    tick(progress, y, h);
    const add = Math.min(y + b, h - 1) * w, rem = Math.max(y - a, 0) * w, o = y * w;
    for (let x = 0; x < w; x++) {
      const s = acc[x] + src[add + x];
      dst[o + x] = s * inv;
      acc[x] = s - src[rem + x];
    }
  }
}
// Symmetric box blur of radius rx, ry; result in `plane`.
export function boxBlurPlane(plane: Plane, tmp: Plane, w: number, h: number, rx: number, ry: number, progress?: Progress): Plane {
  if (rx > 0) {
    boxH(plane, tmp, w, h, rx, rx, sub(progress, 0, 0.5));
    plane.set(tmp);
  }
  if (ry > 0) {
    boxV(plane, tmp, w, h, ry, ry, sub(progress, 0.5, 1));
    plane.set(tmp);
  }
  return plane;
}

// ---------------------------------------------------------------------------
// Gaussian blur: exact separable kernel for small sigma, three box passes for
// large sigma (Wells 1986; box widths chosen as in Kutskir's "Fastest Gaussian
// blur"), which is O(1) per pixel regardless of radius.

export const EXACT_GAUSS_MAX_SIGMA = 2.5;

export function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}
export function boxesForGauss(sigma: number, n = 3): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const radii: number[] = [];
  for (let i = 0; i < n; i++) radii.push(((i < m ? wl : wu) - 1) / 2);
  return radii;
}

// Separable 1-D convolution with an odd, centered kernel. Symmetric kernels
// (all the blurs) fold mirrored taps to halve the multiplies.
const isSymmetric = (k: Float32Array) => k.every((v, i) => v === k[k.length - 1 - i]);
export function convolveH(src: Plane, dst: Plane, w: number, h: number, k: Float32Array, progress?: Progress) {
  const r = (k.length - 1) >> 1, sym = isSymmetric(k), k0 = k[r];
  const pad = new Float32Array(w + 2 * r);
  for (let y = 0, off = 0; y < h; y++, off += w) {
    tick(progress, y, h);
    const first = src[off], last = src[off + w - 1];
    for (let i = 0; i < r; i++) { pad[i] = first; pad[r + w + i] = last; }
    pad.set(src.subarray(off, off + w), r);
    if (sym)
      for (let x = 0; x < w; x++) {
        const c = x + r;
        let s = pad[c] * k0;
        for (let i = 1; i <= r; i++) s += (pad[c - i] + pad[c + i]) * k[r + i];
        dst[off + x] = s;
      }
    else
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = 0; i < k.length; i++) s += pad[x + i] * k[i];
        dst[off + x] = s;
      }
  }
}
export function convolveV(src: Plane, dst: Plane, w: number, h: number, k: Float32Array, progress?: Progress) {
  const r = (k.length - 1) >> 1, sym = isSymmetric(k);
  const acc = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    tick(progress, y, h);
    const o = y * w;
    if (sym) {
      const k0 = k[r];
      for (let x = 0; x < w; x++) acc[x] = src[o + x] * k0;
      for (let i = 1; i <= r; i++) {
        const a = Math.max(0, y - i) * w, b = Math.min(h - 1, y + i) * w, kv = k[r + i];
        for (let x = 0; x < w; x++) acc[x] += (src[a + x] + src[b + x]) * kv;
      }
    } else {
      acc.fill(0);
      for (let i = 0; i < k.length; i++) {
        const off = Math.min(h - 1, Math.max(0, y + i - r)) * w, kv = k[i];
        for (let x = 0; x < w; x++) acc[x] += src[off + x] * kv;
      }
    }
    dst.set(acc, o);
  }
}
export function separablePlane(plane: Plane, tmp: Plane, w: number, h: number, kx: Float32Array | null, ky: Float32Array | null, progress?: Progress): Plane {
  if (kx) { convolveH(plane, tmp, w, h, kx, sub(progress, 0, 0.5)); plane.set(tmp); }
  if (ky) { convolveV(plane, tmp, w, h, ky, sub(progress, 0.5, 1)); plane.set(tmp); }
  return plane;
}

export function gaussianPlane(plane: Plane, tmp: Plane, w: number, h: number, sigma: number, progress?: Progress): Plane {
  return gaussianPlaneXY(plane, tmp, w, h, sigma, sigma, progress);
}
export function gaussianPlaneXY(plane: Plane, tmp: Plane, w: number, h: number, sx: number, sy: number, progress?: Progress): Plane {
  const tiny = 0.05;
  if (sx <= EXACT_GAUSS_MAX_SIGMA && sy <= EXACT_GAUSS_MAX_SIGMA)
    return separablePlane(plane, tmp, w, h, sx > tiny ? gaussianKernel(sx) : null, sy > tiny ? gaussianKernel(sy) : null, progress);
  // Large sigma: horizontal then vertical, each either exact or three boxes,
  // ping-ponging between the two buffers so only a final copy may be needed.
  let a = plane, b = tmp;
  if (sx > tiny) {
    const p = sub(progress, 0, 0.5);
    if (sx <= EXACT_GAUSS_MAX_SIGMA) { convolveH(a, b, w, h, gaussianKernel(sx), p); [a, b] = [b, a]; }
    else for (const r of boxesForGauss(sx)) { boxH(a, b, w, h, r, r, p); [a, b] = [b, a]; }
  }
  if (sy > tiny) {
    const p = sub(progress, 0.5, 1);
    if (sy <= EXACT_GAUSS_MAX_SIGMA) { convolveV(a, b, w, h, gaussianKernel(sy), p); [a, b] = [b, a]; }
    else for (const r of boxesForGauss(sy)) { boxV(a, b, w, h, r, r, p); [a, b] = [b, a]; }
  }
  if (a !== plane) plane.set(a);
  return plane;
}

// Gaussian blur of a whole image with alpha-weighted color.
export function gaussianRGBA(src: RGBA8, sigma: number, progress?: Progress): RGBA8 {
  return linearFilterRGBA(src, (p, t, w, h, pr) => gaussianPlane(p, t, w, h, sigma, pr), progress);
}

// General 2-D convolution of a plane with a square odd kernel (3x3, 5x5).
export function convolve2D(src: Plane, dst: Plane, w: number, h: number, k: ArrayLike<number>, size: number, progress?: Progress) {
  const r = (size - 1) >> 1;
  const rows: number[] = new Array(size);
  for (let y = 0; y < h; y++) {
    tick(progress, y, h);
    for (let i = 0; i < size; i++) rows[i] = Math.min(h - 1, Math.max(0, y + i - r)) * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < size; j++) {
        const xx = Math.min(w - 1, Math.max(0, x + j - r));
        for (let i = 0; i < size; i++) s += src[rows[i] + xx] * k[i * size + j];
      }
      dst[y * w + x] = s;
    }
  }
}

// ---------------------------------------------------------------------------
// Bilinear sampling with clamped edges

export function sample(p: Plane, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = x | 0, y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const a = p[y0 * w + x0], b = p[y0 * w + x1], c = p[y1 * w + x0], d = p[y1 * w + x1];
  const top = a + (b - a) * fx;
  return top + (c + (d - c) * fx - top) * fy;
}

// ---------------------------------------------------------------------------
// Minimum / maximum (van Herk 1992; Gil and Werman 1993): O(1) per pixel per
// pass independent of radius.

function vhgwRow(f: Uint8Array, g: Uint8Array, hh: Uint8Array, len: number, k: number, isMax: boolean) {
  for (let i = 0; i < len; i++) {
    const v = f[i];
    if (i % k === 0) g[i] = v;
    else { const p = g[i - 1]; g[i] = isMax ? (v > p ? v : p) : v < p ? v : p; }
  }
  for (let i = len - 1; i >= 0; i--) {
    const v = f[i];
    if (i % k === k - 1 || i === len - 1) hh[i] = v;
    else { const p = hh[i + 1]; hh[i] = isMax ? (v > p ? v : p) : v < p ? v : p; }
  }
}
// Horizontal running min/max over [x - r, x + r], window truncated at edges
// (equal to clamping for an order statistic).
export function minMaxH(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number, isMax: boolean, progress?: Progress) {
  if (r <= 0) { dst.set(src); return; }
  const len = w + 2 * r, k = 2 * r + 1, neutral = isMax ? 0 : 255;
  const f = new Uint8Array(len), g = new Uint8Array(len), hh = new Uint8Array(len);
  f.fill(neutral);
  for (let y = 0, off = 0; y < h; y++, off += w) {
    tick(progress, y, h);
    f.set(src.subarray(off, off + w), r);
    vhgwRow(f, g, hh, len, k, isMax);
    for (let x = 0; x < w; x++) {
      const a = hh[x], b = g[x + 2 * r];
      dst[off + x] = isMax ? (a > b ? a : b) : a < b ? a : b;
    }
  }
}
// Vertical pass done row by row so memory access stays sequential.
export function minMaxV(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number, isMax: boolean, progress?: Progress) {
  if (r <= 0) { dst.set(src); return; }
  const len = h + 2 * r, k = 2 * r + 1, neutral = isMax ? 0 : 255;
  const g = new Uint8Array(len * w), hh = new Uint8Array(len * w);
  const row = (i: number) => i - r; // padded row -> source row
  for (let i = 0; i < len; i++) {
    const sy = row(i), o = i * w, so = sy * w, inside = sy >= 0 && sy < h;
    if (i % k === 0 || !inside) {
      if (inside) g.set(src.subarray(so, so + w), o);
      else if (i % k === 0) g.fill(neutral, o, o + w);
      else g.copyWithin(o, o - w, o);
    } else
      for (let x = 0; x < w; x++) {
        const v = src[so + x], p = g[o - w + x];
        g[o + x] = isMax ? (v > p ? v : p) : v < p ? v : p;
      }
  }
  for (let i = len - 1; i >= 0; i--) {
    const sy = row(i), o = i * w, so = sy * w, inside = sy >= 0 && sy < h;
    if (i % k === k - 1 || i === len - 1) {
      if (inside) hh.set(src.subarray(so, so + w), o);
      else hh.fill(neutral, o, o + w);
    } else if (!inside) hh.copyWithin(o, o + w, o + 2 * w);
    else
      for (let x = 0; x < w; x++) {
        const v = src[so + x], p = hh[o + w + x];
        hh[o + x] = isMax ? (v > p ? v : p) : v < p ? v : p;
      }
  }
  for (let y = 0; y < h; y++) {
    tick(progress, y, h);
    const a = y * w, b = (y + 2 * r) * w, o = y * w;
    for (let x = 0; x < w; x++) {
      const p = hh[a + x], q = g[b + x];
      dst[o + x] = isMax ? (p > q ? p : q) : p < q ? p : q;
    }
  }
}
// Min or max of one Uint8 plane over a square or a disc of radius r.
export function minMaxPlane(src: Uint8Array, w: number, h: number, r: number, isMax: boolean, round: boolean, progress?: Progress): Uint8Array {
  const out = new Uint8Array(w * h);
  if (r <= 0) { out.set(src); return out; }
  const tmp = new Uint8Array(w * h);
  if (!round) {
    minMaxH(src, tmp, w, h, r, isMax, sub(progress, 0, 0.5));
    minMaxV(tmp, out, w, h, r, isMax, sub(progress, 0.5, 1));
    return out;
  }
  // A disc is the union of horizontal runs: one horizontal pass per distinct
  // half-width, then each run is combined at its vertical offset.
  out.fill(isMax ? 0 : 255);
  const R = r + 0.5;
  const byWidth = new Map<number, number[]>();
  for (let dy = 0; dy <= r; dy++) {
    const hw = Math.floor(Math.sqrt(R * R - dy * dy));
    const list = byWidth.get(hw) ?? [];
    list.push(dy);
    byWidth.set(hw, list);
  }
  let done = 0;
  for (const [hw, dys] of byWidth) {
    checkCancelled(progress);
    minMaxH(src, tmp, w, h, hw, isMax);
    for (const dy of dys)
      for (const sgn of dy === 0 ? [0] : [-1, 1])
        for (let y = 0; y < h; y++) {
          const sy = y + sgn * dy;
          if (sy < 0 || sy >= h) continue; // truncated window
          const o = y * w, so = sy * w;
          for (let x = 0; x < w; x++) {
            const v = tmp[so + x], p = out[o + x];
            out[o + x] = isMax ? (v > p ? v : p) : v < p ? v : p;
          }
        }
    progress?.report?.(++done / byWidth.size);
  }
  return out;
}
// Min/max on an image. Fully transparent pixels take the neutral value in the
// color channels so they never pull color into visible pixels; alpha is
// filtered like any channel, so Maximum grows and Minimum chokes the shape.
export function minMaxRGBA(src: RGBA8, r: number, isMax: boolean, round: boolean, progress?: Progress): RGBA8 {
  const { width: w, height: h, data: d } = src;
  const n = w * h, out = newImage(src), o = out.data;
  const plane = new Uint8Array(n), neutral = isMax ? 0 : 255;
  for (let c = 0; c < 4; c++) {
    for (let i = 0, j = 0; i < n; i++, j += 4) plane[i] = c < 3 && d[j + 3] === 0 ? neutral : d[j + c];
    const res = minMaxPlane(plane, w, h, r, isMax, round, sub(progress, c / 4, (c + 1) / 4));
    for (let i = 0, j = c; i < n; i++, j += 4) o[j] = res[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Median (Huang, Yang and Tang 1979): sliding 256-bin histograms with an
// incrementally tracked median. Color histograms are weighted by alpha so
// transparent pixels do not vote; alpha itself is an unweighted median.

export function medianRGBA(src: RGBA8, r: number, progress?: Progress): RGBA8 {
  const { width: w, height: h, data: s } = src;
  const out = newImage(src), o = out.data;
  if (r <= 0) { o.set(s); return out; }
  const hist = new Int32Array(1024);
  const rowOff = new Int32Array(2 * r + 1);
  const count = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < h; y++) {
    tick(progress, y, h);
    hist.fill(0);
    // Per channel: current median m and the weight strictly below it, l.
    let m0 = 0, m1 = 0, m2 = 0, m3 = 0, l0 = 0, l1 = 0, l2 = 0, l3 = 0;
    let total = 0; // alpha-weighted color total
    for (let i = 0; i <= 2 * r; i++) rowOff[i] = Math.min(h - 1, Math.max(0, y + i - r)) * w;
    for (let i = 0; i <= 2 * r; i++)
      for (let dx = -r; dx <= r; dx++) {
        const j = (rowOff[i] + Math.min(w - 1, Math.max(0, dx))) * 4, a = s[j + 3];
        hist[s[j]] += a; hist[256 + s[j + 1]] += a; hist[512 + s[j + 2]] += a; hist[768 + a]++;
        total += a;
      }
    for (let x = 0; x < w; x++) {
      if (x > 0) {
        const xr = Math.max(0, x - r - 1), xa = Math.min(w - 1, x + r);
        for (let i = 0; i <= 2 * r; i++) {
          // Branch-free "if (v < m) l -= a": comparisons on noisy data
          // mispredict about half the time.
          let j = (rowOff[i] + xr) * 4, a = s[j + 3], v = s[j];
          hist[v] -= a; l0 -= ((v - m0) >> 31) & a;
          v = s[j + 1]; hist[256 + v] -= a; l1 -= ((v - m1) >> 31) & a;
          v = s[j + 2]; hist[512 + v] -= a; l2 -= ((v - m2) >> 31) & a;
          hist[768 + a]--; l3 -= ((a - m3) >> 31) & 1;
          total -= a;
          j = (rowOff[i] + xa) * 4; a = s[j + 3]; v = s[j];
          hist[v] += a; l0 += ((v - m0) >> 31) & a;
          v = s[j + 1]; hist[256 + v] += a; l1 += ((v - m1) >> 31) & a;
          v = s[j + 2]; hist[512 + v] += a; l2 += ((v - m2) >> 31) & a;
          hist[768 + a]++; l3 += ((a - m3) >> 31) & 1;
          total += a;
        }
      }
      const q = (y * w + x) * 4;
      if (total === 0) {
        o[q] = s[q]; o[q + 1] = s[q + 1]; o[q + 2] = s[q + 2];
      } else {
        let k = settleMedian(hist, 0, m0, l0, total); m0 = k % 256; l0 = (k - m0) / 256;
        k = settleMedian(hist, 256, m1, l1, total); m1 = k % 256; l1 = (k - m1) / 256;
        k = settleMedian(hist, 512, m2, l2, total); m2 = k % 256; l2 = (k - m2) / 256;
        o[q] = m0; o[q + 1] = m1; o[q + 2] = m2;
      }
      const k = settleMedian(hist, 768, m3, l3, count); m3 = k % 256; l3 = (k - m3) / 256;
      o[q + 3] = m3;
    }
  }
  return out;
}
// Moves a tracked median to the lower median of histogram `hist[base..]`
// (smallest m with 2 * cumulative(<= m) >= T); returns l * 256 + m, where l
// is the weight below m.
function settleMedian(hist: Int32Array, base: number, m: number, l: number, T: number): number {
  while (m > 0 && 2 * l >= T) { m--; l -= hist[base + m]; }
  while (2 * (l + hist[base + m]) < T) { l += hist[base + m]; m++; }
  return l * 256 + m;
}

// ---------------------------------------------------------------------------
// Bilateral filter (Tomasi and Manduchi 1998). Small spatial sigmas use the
// direct sum; larger ones use the bilateral grid (Paris and Durand 2006,
// "A Fast Approximation of the Bilateral Filter using a Signal Processing
// Approach"), processed in horizontal strips to bound memory.
// `v` holds values in [0, 255]; `wt` optionally weights samples (alpha).

// `fine` > 1 samples the grid more densely than the sigmas (slower, closer to exact).
export function bilateralPlane(v: Plane, wt: Plane | null, w: number, h: number, sigmaS: number, sigmaR: number, progress?: Progress, fine = 1): Plane {
  sigmaR = Math.max(0.5, sigmaR);
  if (sigmaS < 3) return bilateralDirect(v, wt, w, h, Math.max(0.3, sigmaS), sigmaR, progress);
  return bilateralGrid(v, wt, w, h, sigmaS / fine, Math.max(2, sigmaR) / fine, fine, progress);
}

// Sparse taps for direct bilateral sums: a lattice with stride chosen so at
// most 9x9 samples are taken (the stride stays below sigma, so the Gaussian is
// still well sampled), minus corner taps with negligible spatial weight.
export function bilateralTaps(sigmaS: number, w: number) {
  const r = Math.max(1, Math.ceil(2 * sigmaS));
  const stride = Math.max(1, Math.ceil((2 * r + 1) / 9));
  const tx: number[] = [], ty: number[] = [], tw: number[] = [];
  const lim = Math.floor(r / stride) * stride;
  for (let dy = -lim; dy <= lim; dy += stride)
    for (let dx = -lim; dx <= lim; dx += stride) {
      const k = Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS));
      if (k < 0.01) continue;
      tx.push(dx); ty.push(dy); tw.push(k);
    }
  const n = tx.length, TX = Int32Array.from(tx), TY = Int32Array.from(ty), TW = Float32Array.from(tw);
  const TO = new Int32Array(n).map((_, i) => TY[i] * w + TX[i]);
  return { lim, n, TX, TY, TW, TO };
}
// Gaussian range weights tabulated in quarter levels over [0, 256].
export function rangeLut(sigmaR: number): Float32Array {
  const lut = new Float32Array(1025);
  for (let i = 0; i <= 1024; i++) lut[i] = Math.exp(-((i / 4) ** 2) / (2 * sigmaR * sigmaR));
  return lut;
}

function bilateralDirect(v: Plane, wt: Plane | null, w: number, h: number, sigmaS: number, sigmaR: number, progress?: Progress): Plane {
  const { lim, n, TX, TY, TW, TO } = bilateralTaps(sigmaS, w);
  const lut = rangeLut(sigmaR);
  const out = new Float32Array(w * h);
  const edge = (x: number, y: number) => {
    const i0 = y * w + x, c = v[i0];
    let sum = 0, norm = 0;
    for (let t = 0; t < n; t++) {
      const idx = Math.min(h - 1, Math.max(0, y + TY[t])) * w + Math.min(w - 1, Math.max(0, x + TX[t]));
      const s = v[idx];
      let k = TW[t] * lut[Math.min(1024, Math.abs(s - c) * 4) | 0];
      if (wt) k *= wt[idx];
      sum += s * k;
      norm += k;
    }
    out[i0] = norm > 1e-8 ? sum / norm : c;
  };
  for (let y = 0; y < h; y++) {
    tick(progress, y, h);
    if (y < lim || y >= h - lim || w <= 2 * lim) {
      for (let x = 0; x < w; x++) edge(x, y);
      continue;
    }
    for (let x = 0; x < lim; x++) edge(x, y);
    for (let x = w - lim; x < w; x++) edge(x, y);
    if (wt) bilateralSpanW(v, wt, out, y * w + lim, w - 2 * lim, n, TO, TW, lut);
    else bilateralSpan(v, out, y * w + lim, w - 2 * lim, n, TO, TW, lut);
  }
  return out;
}
// Interior spans need no clamping. Branch-free on purpose: with noisy data a
// comparison in the tap loop mispredicts about half the time.
function bilateralSpan(v: Plane, out: Plane, start: number, count: number, n: number, TO: Int32Array, TW: Float32Array, lut: Float32Array) {
  for (let i0 = start; i0 < start + count; i0++) {
    const c = v[i0];
    let sum = 0, norm = 0;
    for (let t = 0; t < n; t++) {
      const s = v[i0 + TO[t]];
      const k = TW[t] * lut[Math.min(1024, Math.abs(s - c) * 4) | 0];
      sum += s * k;
      norm += k;
    }
    out[i0] = sum / norm;
  }
}
function bilateralSpanW(v: Plane, wt: Plane, out: Plane, start: number, count: number, n: number, TO: Int32Array, TW: Float32Array, lut: Float32Array) {
  for (let i0 = start; i0 < start + count; i0++) {
    const c = v[i0];
    let sum = 0, norm = 0;
    for (let t = 0; t < n; t++) {
      const idx = i0 + TO[t], s = v[idx];
      const k = TW[t] * lut[Math.min(1024, Math.abs(s - c) * 4) | 0] * wt[idx];
      sum += s * k;
      norm += k;
    }
    out[i0] = norm > 1e-8 ? sum / norm : c;
  }
}

function blur5Line(g: Float32Array, start: number, count: number, stride: number, line: Float32Array) {
  // [1 4 6 4 1] / 16 over `count` interleaved (value, weight) pairs, zero outside.
  for (let i = 0; i < count; i++) {
    const p = start + i * stride;
    line[2 * i] = g[p];
    line[2 * i + 1] = g[p + 1];
  }
  for (let i = 0; i < count; i++) {
    let a = 6 * line[2 * i], b = 6 * line[2 * i + 1];
    if (i > 0) { a += 4 * line[2 * i - 2]; b += 4 * line[2 * i - 1]; }
    if (i > 1) { a += line[2 * i - 4]; b += line[2 * i - 3]; }
    if (i + 1 < count) { a += 4 * line[2 * i + 2]; b += 4 * line[2 * i + 3]; }
    if (i + 2 < count) { a += line[2 * i + 4]; b += line[2 * i + 5]; }
    const p = start + i * stride;
    g[p] = a * 0.0625;
    g[p + 1] = b * 0.0625;
  }
}

function bilateralGrid(v: Plane, wt: Plane | null, w: number, h: number, ss: number, sr: number, fine: number, progress?: Progress): Plane {
  // With `fine` cells per sigma the grid blur must widen to keep the same sigma.
  const passes = Math.max(1, Math.round(fine * fine));
  const pad = 2 * passes;
  const gw = Math.floor((w - 1) / ss + 0.5) + 1 + 2 * pad;
  const gd = Math.floor(255 / sr + 0.5) + 1 + 2 * pad;
  const ghTotal = Math.floor((h - 1) / ss + 0.5) + 1;
  // Grid cell rows per strip, keeping the strip grid near 4M cells.
  const stripCells = Math.min(ghTotal, Math.max(4, Math.floor(4e6 / (gw * gd)) - 2 * pad - 2));
  const gh = stripCells + 2 * pad + 2;
  const grid = new Float32Array(gw * gh * gd * 2);
  const line = new Float32Array(Math.max(gw, gh, gd) * 2);
  const out = new Float32Array(w * h);
  const zs = gd * 2, xs = gw * zs;
  for (let c0 = 0; c0 < ghTotal; c0 += stripCells) {
    checkCancelled(progress);
    progress?.report?.(c0 / ghTotal);
    grid.fill(0);
    // Grid row g holds cell row c0 - pad - 1 + g.
    const first = c0 - pad - 1;
    const yStart = Math.max(0, Math.ceil((first - 0.5) * ss));
    const yEnd = Math.min(h - 1, Math.floor((first + gh - 0.5) * ss));
    for (let y = yStart; y <= yEnd; y++) {
      const gy = Math.round(y / ss) - first;
      if (gy < 0 || gy >= gh) continue;
      for (let x = 0; x < w; x++) {
        const i = y * w + x, val = clamp(v[i], 0, 255), k = wt ? wt[i] : 1;
        if (k <= 0) continue;
        const p = gy * xs + (Math.round(x / ss) + pad) * zs + (Math.round(val / sr) + pad) * 2;
        grid[p] += val * k;
        grid[p + 1] += k;
      }
    }
    for (let k = 0; k < passes; k++) {
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) blur5Line(grid, gy * xs + gx * zs, gd, 2, line);
      for (let gy = 0; gy < gh; gy++) for (let gz = 0; gz < gd; gz++) blur5Line(grid, gy * xs + gz * 2, gw, zs, line);
      for (let gx = 0; gx < gw; gx++) for (let gz = 0; gz < gd; gz++) blur5Line(grid, gx * zs + gz * 2, gh, xs, line);
    }
    const rowStart = Math.ceil((c0 - 0.5) * ss), rowEnd = Math.min(h - 1, Math.ceil((c0 + stripCells - 0.5) * ss) - 1);
    for (let y = Math.max(0, rowStart); y <= rowEnd; y++) {
      const fy = y / ss - first;
      const y0 = Math.min(gh - 2, fy | 0), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x, val = v[i];
        const fx = x / ss + pad, fz = clamp(val, 0, 255) / sr + pad;
        const x0 = fx | 0, z0 = fz | 0, tx = fx - x0, tz = fz - z0;
        const p = y0 * xs + x0 * zs + z0 * 2;
        let num = 0, den = 0;
        for (let k = 0; k < 8; k++) {
          const dy = k >> 2, dx = (k >> 1) & 1, dz = k & 1;
          const wgt = (dy ? ty : 1 - ty) * (dx ? tx : 1 - tx) * (dz ? tz : 1 - tz);
          const q = p + dy * xs + dx * zs + dz * 2;
          num += grid[q] * wgt;
          den += grid[q + 1] * wgt;
        }
        out[i] = den > 1e-6 ? num / den : val;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic randomness

// Murmur3 finalizer: a well-mixed 32-bit hash of a few integers, so noise at a
// pixel depends only on (seed, x, y, channel) and not on iteration order.
export function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
export function hash(seed: number, a: number, b = 0, c = 0): number {
  let h = mix32(seed ^ 0x9e3779b9);
  h = mix32(h + a);
  h = mix32(h + b);
  return mix32(h + c);
}
// Uniform in [0, 1).
export const rand = (seed: number, a: number, b = 0, c = 0) => hash(seed, a, b, c) / 4294967296;
// Sequential generator (Mulberry32) for per-object randomness.
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
