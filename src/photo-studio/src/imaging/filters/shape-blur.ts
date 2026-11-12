// Shape Blur: convolution with a kernel shaped like one of the library's
// custom shapes, plus the small path flattener and bounded-area polygon fill
// that the procedural render filters share.
import type { Mask8, Progress } from '../types';
import { builtinShapes } from '../../model/shape-library';
import { rasterizePolygon, type Point as MaskPoint } from '../segment/mask-ops';
import { defineOp, linearFilterRGBA, num, px, str, tick, type Plane } from './common';

export type Contour = [number, number][];

// ---------------------------------------------------------------------------
// SVG path data -> polygons. Handles M L H V C S Q T Z in absolute and relative
// form (arcs are not used by the library); curves are split into enough
// segments for a chord error well below a pixel at the drawn size.

export function flattenPath(d: string, curveSteps = 16): Contour[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: Contour[] = [];
  let cur: Contour = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  let lcx = 0, lcy = 0, lastCurve = ''; // previous control point for S and T
  const isCmd = (t: string) => /^[a-zA-Z]$/.test(t);
  const n = () => Number(tokens[i++]);
  const close = () => {
    if (cur.length > 2) out.push(cur);
    cur = [];
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    for (let k = 1; k <= curveSteps; k++) {
      const t = k / curveSteps, u = 1 - t;
      cur.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
    }
  };
  const quad = (x1: number, y1: number, x2: number, y2: number) => {
    for (let k = 1; k <= curveSteps; k++) {
      const t = k / curveSteps, u = 1 - t;
      cur.push([u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2]);
    }
  };
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        close();
        x = ox + n(); y = oy + n();
        sx = x; sy = y;
        cur.push([x, y]);
        // Further pairs after a move are implicit line-tos.
        cmd = rel ? 'l' : 'L';
        lastCurve = '';
        break;
      }
      case 'L': x = ox + n(); y = oy + n(); cur.push([x, y]); lastCurve = ''; break;
      case 'H': x = ox + n(); cur.push([x, y]); lastCurve = ''; break;
      case 'V': y = oy + n(); cur.push([x, y]); lastCurve = ''; break;
      case 'C': {
        const x1 = ox + n(), y1 = oy + n(), x2 = ox + n(), y2 = oy + n(), x3 = ox + n(), y3 = oy + n();
        cubic(x1, y1, x2, y2, x3, y3);
        lcx = x2; lcy = y2; lastCurve = 'C';
        x = x3; y = y3;
        break;
      }
      case 'S': {
        const x1 = lastCurve === 'C' ? 2 * x - lcx : x, y1 = lastCurve === 'C' ? 2 * y - lcy : y;
        const x2 = ox + n(), y2 = oy + n(), x3 = ox + n(), y3 = oy + n();
        cubic(x1, y1, x2, y2, x3, y3);
        lcx = x2; lcy = y2; lastCurve = 'C';
        x = x3; y = y3;
        break;
      }
      case 'Q': {
        const x1 = ox + n(), y1 = oy + n(), x2 = ox + n(), y2 = oy + n();
        quad(x1, y1, x2, y2);
        lcx = x1; lcy = y1; lastCurve = 'Q';
        x = x2; y = y2;
        break;
      }
      case 'T': {
        const x1 = lastCurve === 'Q' ? 2 * x - lcx : x, y1 = lastCurve === 'Q' ? 2 * y - lcy : y;
        const x2 = ox + n(), y2 = oy + n();
        quad(x1, y1, x2, y2);
        lcx = x1; lcy = y1; lastCurve = 'Q';
        x = x2; y = y2;
        break;
      }
      case 'Z':
        close();
        x = sx; y = sy;
        lastCurve = '';
        break;
      default:
        // Unsupported command: skip its numbers.
        while (i < tokens.length && !isCmd(tokens[i])) i++;
    }
  }
  close();
  return out;
}

export function contoursBounds(contours: Contour[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of contours)
    for (const [x, y] of c) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Exact-coverage fill of contours restricted to their bounds (clipped to
 * the w x h canvas); returns the coverage tile and where it goes. */
export function fillContours(contours: Contour[], w: number, h: number, rule: 'nonzero' | 'evenodd' = 'nonzero'): { x: number; y: number; mask: Mask8 } | null {
  if (!contours.length) return null;
  const b = contoursBounds(contours);
  const x0 = Math.max(0, Math.floor(b.x)), y0 = Math.max(0, Math.floor(b.y));
  const x1 = Math.min(w, Math.ceil(b.x + b.width) + 1), y1 = Math.min(h, Math.ceil(b.y + b.height) + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  const shifted = contours.map((c) => c.map(([x, y]) => [x - x0, y - y0] as MaskPoint));
  return { x: x0, y: y0, mask: rasterizePolygon(shifted, x1 - x0, y1 - y0, { fillRule: rule }) };
}

// ---------------------------------------------------------------------------
// Kernel convolution

export type ShapeKernel = { size: number; weights: Float32Array };

/** The shape fitted (aspect kept) into a (2r+1)-pixel square, normalized to sum 1. */
export function shapeKernel(d: string, radius: number): ShapeKernel {
  const r = Math.max(0, Math.round(radius));
  const size = 2 * r + 1;
  const weights = new Float32Array(size * size);
  if (r === 0) {
    weights[0] = 1;
    return { size, weights };
  }
  const contours = flattenPath(d);
  const b = contoursBounds(contours);
  const s = size / Math.max(b.width, b.height, 1e-6);
  const offX = (size - b.width * s) / 2 - b.x * s, offY = (size - b.height * s) / 2 - b.y * s;
  const fitted = contours.map((c) => c.map(([x, y]) => [x * s + offX, y * s + offY] as MaskPoint));
  const m = rasterizePolygon(fitted, size, size, { fillRule: 'evenodd' });
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i] = m.data[i] / 255;
  if (sum <= 0) {
    weights.fill(0);
    weights[r * size + r] = 1;
    return { size, weights };
  }
  for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  return { size, weights };
}

// Each kernel row becomes spans of full-weight pixels (summed through row
// prefix sums in O(1)) plus the few fractional edge taps, so the cost is about
// pixels x kernel rows instead of pixels x kernel area.
export type KernelRow = { dy: number; spans: [number, number, number][]; taps: [number, number][] };
export function kernelRows(k: ShapeKernel): KernelRow[] {
  const { size, weights } = k, r = (size - 1) / 2;
  let max = 0;
  for (const v of weights) if (v > max) max = v;
  const rows: KernelRow[] = [];
  for (let ky = 0; ky < size; ky++) {
    const row: KernelRow = { dy: ky - r, spans: [], taps: [] };
    let start = -1;
    for (let kx = 0; kx <= size; kx++) {
      const v = kx < size ? weights[ky * size + kx] : 0;
      const full = v >= max * 0.999;
      if (full && start < 0) start = kx;
      if (!full && start >= 0) {
        if (kx - start >= 3) row.spans.push([start - r, kx - 1 - r, max]);
        else for (let t = start; t < kx; t++) row.taps.push([t - r, max]);
        start = -1;
      }
      if (!full && v > 0) row.taps.push([kx - r, v]);
    }
    if (row.spans.length || row.taps.length) rows.push(row);
  }
  return rows;
}

/** Convolve a plane with a kernel (edges replicated). Writes and returns `dst`. */
export function kernelConvolve(src: Plane, dst: Plane, w: number, h: number, k: ShapeKernel, progress?: Progress): Plane {
  const r = (k.size - 1) / 2;
  const rows = kernelRows(k);
  const pw = w + 2 * r;
  // Prefix sums of each source row padded by r replicated pixels on both sides.
  const prefix = new Float32Array((pw + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * w, p = y * (pw + 1);
    let acc = 0;
    prefix[p] = 0;
    for (let i = 0; i < pw; i++) {
      const x = i - r;
      acc += src[o + (x < 0 ? 0 : x >= w ? w - 1 : x)];
      prefix[p + i + 1] = acc;
    }
  }
  // Adds one kernel row read from source row `sy` to out[at .. at + w).
  const addRow = (out: Plane, at: number, row: KernelRow, sy: number) => {
    const p = sy * (pw + 1), o = sy * w;
    for (const [a, b, wt] of row.spans) {
      const ia = p + a + r, ib = p + b + r + 1;
      for (let x = 0; x < w; x++) out[at + x] += wt * (prefix[ib + x] - prefix[ia + x]);
    }
    for (const [dx, wt] of row.taps) {
      // Columns left of xa and from xb on read the replicated edge pixels.
      const xa = Math.min(w, Math.max(0, -dx)), xb = Math.max(xa, Math.min(w, w - dx));
      const left = src[o], right = src[o + w - 1];
      for (let x = 0; x < xa; x++) out[at + x] += wt * left;
      for (let x = xa, s = o + xa + dx; x < xb; x++, s++) out[at + x] += wt * src[s];
      for (let x = xb; x < w; x++) out[at + x] += wt * right;
    }
  };
  // Kernel rows above the image all read the top row and come first in every
  // output row's sum, so the running sum over them is shared: going up the
  // image, output row y continues it with the rows that just went above.
  // Same additions in the same order, so the result is unchanged; at large
  // radii on small images this skips most of the work.
  const lead = new Float32Array(w);
  let led = 0;
  for (let y = h - 1, done = 0; y >= 0; y--, done++) {
    tick(progress, done, h);
    while (led < rows.length && rows[led].dy < -y) addRow(lead, 0, rows[led++], 0);
    const out = y * w;
    dst.set(lead, out);
    for (let i = led; i < rows.length; i++) {
      const row = rows[i];
      const sy = y + row.dy;
      addRow(dst, out, row, sy < 0 ? 0 : sy >= h ? h - 1 : sy);
    }
  }
  return dst;
}

const shapeOptions = builtinShapes.map((s) => ({ value: s.id, label: s.name }));
const defaultShape = builtinShapes.some((s) => s.id === 'star') ? 'star' : builtinShapes[0].id;
const kernels = new Map<string, ShapeKernel>();
function cachedKernel(id: string, radius: number): ShapeKernel {
  const key = `${id}:${Math.round(radius)}`;
  let k = kernels.get(key);
  if (!k) {
    const shape = builtinShapes.find((s) => s.id === id) ?? builtinShapes[0];
    k = shapeKernel(shape.d, radius);
    if (kernels.size > 16) kernels.clear();
    kernels.set(key, k);
  }
  return k;
}

export const shapeBlur = defineOp({
  id: 'shape-blur',
  label: 'Shape Blur',
  category: 'Blur',
  support: (p, ctx) => Math.round(px(ctx, num(p, 'radius'))) + 1,
  params: [
    { key: 'radius', label: 'Radius', type: 'number', min: 1, max: 1000, step: 1, default: 10, unit: 'px' },
    { key: 'shape', label: 'Shape', type: 'select', options: shapeOptions, default: defaultShape },
  ],
  run(src, p, ctx, progress) {
    const r = Math.round(px(ctx, num(p, 'radius')));
    if (r < 1) return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
    const k = cachedKernel(str(p, 'shape'), r);
    return linearFilterRGBA(src, (pl, t, w, h, pr) => kernelConvolve(pl, t, w, h, k, pr), progress);
  },
});
