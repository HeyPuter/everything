// Stylize menu. Filters that compare straight neighbor colors run on a copy
// whose fully transparent pixels were filled from their neighbors, and keep
// the source alpha, so transparent black never shows up as a fake edge.
import { checkCancelled, type OperationContext, type ParamValues, type Progress, type RGBA8 } from '../types';
import {
  bool,
  boxH,
  boxV,
  channelPlane,
  clamp,
  copyImage,
  defineOp,
  fillTransparent,
  gaussianRGBA,
  hash,
  lumaPlane,
  luma,
  minMaxPlane,
  newImage,
  num,
  px,
  rand,
  rng,
  sample,
  str,
  sub,
  tick,
  type Plane,
} from './common';

const copyAlpha = (src: RGBA8, out: RGBA8) => {
  const s = src.data, o = out.data;
  for (let j = 3; j < o.length; j += 4) o[j] = s[j];
};

export const emboss = defineOp({
  id: 'emboss',
  label: 'Emboss',
  category: 'Stylize',
  support: (p, ctx) => px(ctx, num(p, 'height')) / 2 + 2,
  fillReach: (p, ctx) => px(ctx, num(p, 'height')) / 2 + 2,
  params: [
    { key: 'angle', label: 'Angle', type: 'number', min: -180, max: 180, step: 1, default: 135, unit: '°' },
    { key: 'height', label: 'Height', type: 'number', min: 1, max: 100, step: 1, default: 3, unit: 'px' },
    { key: 'amount', label: 'Amount', type: 'number', min: 1, max: 500, step: 1, default: 100, unit: '%' },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h } = src;
    const a = (num(p, 'angle') * Math.PI) / 180, half = px(ctx, num(p, 'height')) / 2;
    const work = fillTransparent(src, half + 2);
    // Unit vector toward the light; faces that rise toward it turn bright.
    const vx = Math.cos(a) * half, vy = -Math.sin(a) * half, k = num(p, 'amount') / 100;
    const out = newImage(src), o = out.data;
    for (let c = 0; c < 3; c++) {
      const pl = channelPlane(work, c);
      for (let y = 0; y < h; y++) {
        tick(sub(progress, c / 3, (c + 1) / 3), y, h);
        for (let x = 0; x < w; x++)
          o[(y * w + x) * 4 + c] = 128 + k * (sample(pl, w, h, x - vx, y - vy) - sample(pl, w, h, x + vx, y + vy));
      }
    }
    copyAlpha(src, out);
    return out;
  },
});

// Per-channel Sobel gradient magnitude, normalized so a full black/white step
// reaches 255.
function sobel(pl: Plane, w: number, h: number, out: Plane) {
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1) * w, y0 = y * w, yp = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
      const gx = pl[ym + xp] + 2 * pl[y0 + xp] + pl[yp + xp] - pl[ym + xm] - 2 * pl[y0 + xm] - pl[yp + xm];
      const gy = pl[yp + xm] + 2 * pl[yp + x] + pl[yp + xp] - pl[ym + xm] - 2 * pl[ym + x] - pl[ym + xp];
      out[y0 + x] = Math.sqrt(gx * gx + gy * gy) * 0.25;
    }
  }
}

export const findEdges = defineOp({
  id: 'find-edges',
  label: 'Find Edges',
  category: 'Stylize',
  support: () => 1,
  fillReach: () => 1,
  params: [],
  immediate: true,
  run(src) {
    const { width: w, height: h } = src;
    const work = fillTransparent(src, 1), out = newImage(src), o = out.data;
    const mag = new Float32Array(w * h);
    for (let c = 0; c < 3; c++) {
      sobel(channelPlane(work, c), w, h, mag);
      for (let i = 0, j = c; i < mag.length; i++, j += 4) o[j] = 255 - mag[i];
    }
    copyAlpha(src, out);
    return out;
  },
});

export const solarize = defineOp({
  id: 'solarize',
  label: 'Solarize',
  category: 'Stylize',
  support: () => 0,
  params: [],
  immediate: true,
  run(src) {
    const out = copyImage(src), o = out.data;
    for (let j = 0; j < o.length; j++) if ((j & 3) !== 3 && o[j] > 127) o[j] = 255 - o[j];
    return out;
  },
});

export const traceContour = defineOp({
  id: 'trace-contour',
  label: 'Trace Contour',
  category: 'Stylize',
  support: () => 1,
  fillReach: () => 1,
  params: [
    { key: 'level', label: 'Level', type: 'number', min: 0, max: 255, step: 1, default: 128 },
    { key: 'edge', label: 'Edge', type: 'select', options: [{ value: 'lower', label: 'Lower' }, { value: 'upper', label: 'Upper' }], default: 'lower' },
  ],
  run(src, p) {
    const { width: w, height: h } = src;
    const d = fillTransparent(src, 1).data, out = newImage(src), o = out.data;
    const level = num(p, 'level'), upper = str(p, 'edge') === 'upper';
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const v = d[j + c];
          let mark = false;
          // A pixel on the chosen side of the level with a 4-neighbor across it.
          if (upper ? v >= level : v < level)
            for (const [dx, dy] of N4) {
              const xx = x + dx, yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
              const u = d[(yy * w + xx) * 4 + c];
              if (upper ? u < level : u >= level) { mark = true; break; }
            }
          o[j + c] = mark ? 0 : 255;
        }
      }
    copyAlpha(src, out);
    return out;
  },
});
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Streaks start where a pixel is brighter than the trail that reached it and
// fade over a random length; brightness compares premultiplied luma so
// visible pixels can also blow into transparent areas.
export const wind = defineOp({
  id: 'wind',
  label: 'Wind',
  category: 'Stylize',
  params: [
    {
      key: 'method',
      label: 'Method',
      type: 'select',
      options: [{ value: 'wind', label: 'Wind' }, { value: 'blast', label: 'Blast' }, { value: 'stagger', label: 'Stagger' }],
      default: 'wind',
    },
    {
      key: 'direction',
      label: 'Direction',
      type: 'select',
      options: [{ value: 'right', label: 'From the Right' }, { value: 'left', label: 'From the Left' }],
      default: 'right',
    },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h, data: d } = src;
    const out = copyImage(src), o = out.data;
    const method = str(p, 'method'), fromRight = str(p, 'direction') === 'right';
    const [lmin, lmax, chance, strength] =
      method === 'blast' ? [16, 48, 0.9, 1] : method === 'stagger' ? [2, 10, 0.7, 1] : [4, 18, 0.5, 0.85];
    const s = ctx.scale ?? 1, seed = ctx.seed ?? 0;
    for (let y = 0; y < h; y++) {
      tick(progress, y, h);
      let tr = 0, tg = 0, tb = 0, ta = 0, tl = 0, left = 0, len = 1;
      for (let k = 0; k < w; k++) {
        const x = fromRight ? w - 1 - k : k, j = (y * w + x) * 4;
        // Stagger shifts each streak's source by a random few pixels.
        const sx = method === 'stagger' ? clamp(x + ((hash(seed, y, x >> 3) & 7) - 3), 0, w - 1) : x;
        const q = (y * w + sx) * 4, a = d[q + 3], l = (luma(d[q], d[q + 1], d[q + 2]) * a) / 255;
        const trail = left > 0 ? (tl * left) / len : 0;
        if (l > trail + 8 && rand(seed, x, y, 1) < chance) {
          tr = d[q]; tg = d[q + 1]; tb = d[q + 2]; ta = a; tl = l;
          len = left = Math.max(1, Math.round((lmin + rand(seed, x, y, 2) * (lmax - lmin)) * s));
          continue;
        }
        if (left <= 0) continue;
        const t = (strength * left) / len;
        left--;
        const ca = o[j + 3] / 255, A = ta / 255, na = ca + (A - ca) * t;
        if (na <= 0) continue;
        o[j] = (o[j] * ca * (1 - t) + tr * A * t) / na;
        o[j + 1] = (o[j + 1] * ca * (1 - t) + tg * A * t) / na;
        o[j + 2] = (o[j + 2] * ca * (1 - t) + tb * A * t) / na;
        o[j + 3] = na * 255;
      }
    }
    return out;
  },
});

export const diffuse = defineOp({
  id: 'diffuse',
  label: 'Diffuse',
  category: 'Stylize',
  params: [
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'darken', label: 'Darken Only' },
        { value: 'lighten', label: 'Lighten Only' },
        { value: 'anisotropic', label: 'Anisotropic' },
      ],
      default: 'normal',
    },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h, data: d } = src;
    const out = newImage(src), o = out.data, mode = str(p, 'mode'), seed = ctx.seed ?? 0;
    const L = lumaPlane(src);
    for (let y = 0; y < h; y++) {
      tick(progress, y, h);
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let pick = i;
        if (mode === 'anisotropic') {
          // Move toward the neighbor that changes least, softening texture
          // without crossing edges; ties broken by the seeded start offset.
          let best = Infinity;
          const start = hash(seed, x, y) & 7;
          for (let k = 0; k < 8; k++) {
            const [dx, dy] = N8[(start + k) & 7], xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const diff = Math.abs(L[yy * w + xx] - L[i]);
            if (diff < best) { best = diff; pick = yy * w + xx; }
          }
        } else {
          const r = hash(seed, x, y) % 9, xx = clamp(x + (r % 3) - 1, 0, w - 1), yy = clamp(y + ((r / 3) | 0) - 1, 0, h - 1);
          const n = yy * w + xx;
          if (mode === 'normal' || (mode === 'darken' ? L[n] < L[i] : L[n] > L[i])) pick = n;
        }
        const j = i * 4, q = pick * 4;
        o[j] = d[q]; o[j + 1] = d[q + 1]; o[j + 2] = d[q + 2]; o[j + 3] = d[q + 3];
      }
    }
    return out;
  },
});
const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

export const tiles = defineOp({
  id: 'tiles',
  label: 'Tiles',
  category: 'Stylize',
  params: [
    { key: 'count', label: 'Number of Tiles', type: 'number', min: 1, max: 99, step: 1, default: 10 },
    { key: 'offset', label: 'Maximum Offset', type: 'number', min: 1, max: 99, step: 1, default: 10, unit: '%' },
    {
      key: 'fill',
      label: 'Fill Empty Area With',
      type: 'select',
      options: [
        { value: 'background', label: 'Background Color' },
        { value: 'foreground', label: 'Foreground Color' },
        { value: 'inverse', label: 'Inverse Image' },
        { value: 'unaltered', label: 'Unaltered Image' },
      ],
      default: 'background',
    },
  ],
  run(src, p, ctx) {
    const { width: w, height: h, data: d } = src;
    const out = newImage(src), o = out.data, fill = str(p, 'fill');
    for (let j = 0; j < o.length; j += 4) {
      if (fill === 'inverse') { o[j] = 255 - d[j]; o[j + 1] = 255 - d[j + 1]; o[j + 2] = 255 - d[j + 2]; o[j + 3] = d[j + 3]; }
      else if (fill === 'unaltered') { o[j] = d[j]; o[j + 1] = d[j + 1]; o[j + 2] = d[j + 2]; o[j + 3] = d[j + 3]; }
      else {
        const c = fill === 'foreground' ? ctx.foreground : ctx.background;
        o[j] = c[0]; o[j + 1] = c[1]; o[j + 2] = c[2]; o[j + 3] = 255;
      }
    }
    // Tiles are squares sized from the smaller side, each shifted at random.
    const size = Math.max(1, Math.ceil(Math.min(w, h) / num(p, 'count')));
    const maxOff = (num(p, 'offset') / 100) * size;
    const next = rng(ctx.seed ?? 0);
    for (let ty = 0; ty * size < h; ty++)
      for (let tx = 0; tx * size < w; tx++) {
        const ox = Math.round((next() * 2 - 1) * maxOff), oy = Math.round((next() * 2 - 1) * maxOff);
        const x0 = tx * size, y0 = ty * size, x1 = Math.min(w, x0 + size), y1 = Math.min(h, y0 + size);
        for (let y = y0; y < y1; y++) {
          const yy = y + oy;
          if (yy < 0 || yy >= h) continue;
          const xa = Math.max(x0, -ox), xb = Math.min(x1, w - ox);
          if (xb > xa) o.set(d.subarray((y * w + xa) * 4, (y * w + xb) * 4), (yy * w + xa + ox) * 4);
        }
      }
    return out;
  },
});

// Scanline fill of a convex polygon with a solid premultiplied-over color.
function fillConvex(o: Uint8ClampedArray, w: number, h: number, pts: number[], c: [number, number, number, number]) {
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 1; i < pts.length; i += 2) { ymin = Math.min(ymin, pts[i]); ymax = Math.max(ymax, pts[i]); }
  const n = pts.length / 2;
  for (let y = Math.max(0, Math.ceil(ymin - 0.5)); y <= Math.min(h - 1, Math.floor(ymax - 0.5)); y++) {
    const sy = y + 0.5;
    let xl = Infinity, xr = -Infinity;
    for (let i = 0; i < n; i++) {
      const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[(2 * i + 2) % (2 * n)], by = pts[(2 * i + 3) % (2 * n)];
      if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
        const x = ax + ((sy - ay) / (by - ay)) * (bx - ax);
        xl = Math.min(xl, x); xr = Math.max(xr, x);
      }
    }
    for (let x = Math.max(0, Math.ceil(xl - 0.5)); x <= Math.min(w - 1, Math.floor(xr - 0.5)); x++) o.set(c, (y * w + x) * 4);
  }
}

export const extrude = defineOp({
  id: 'extrude',
  label: 'Extrude',
  category: 'Stylize',
  params: [
    { key: 'type', label: 'Type', type: 'select', options: [{ value: 'blocks', label: 'Blocks' }, { value: 'pyramids', label: 'Pyramids' }], default: 'blocks' },
    { key: 'size', label: 'Size', type: 'number', min: 2, max: 255, step: 1, default: 30, unit: 'px' },
    { key: 'depth', label: 'Depth', type: 'number', min: 1, max: 255, step: 1, default: 30 },
    { key: 'depthMode', label: 'Depth From', type: 'select', options: [{ value: 'random', label: 'Random' }, { value: 'level', label: 'Level-based' }], default: 'random' },
    { key: 'solid', label: 'Solid Front Faces', type: 'checkbox', default: false },
    { key: 'mask', label: 'Mask Incomplete Blocks', type: 'checkbox', default: false },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h, data: d } = src;
    const out = copyImage(src), o = out.data;
    const size = Math.max(2, Math.round(px(ctx, num(p, 'size')))), depth = num(p, 'depth');
    const pyramids = str(p, 'type') === 'pyramids', solid = bool(p, 'solid'), mask = bool(p, 'mask');
    const level = str(p, 'depthMode') === 'level', next = rng(ctx.seed ?? 0);
    const cx = w / 2, cy = h / 2;
    type Block = { x0: number; y0: number; x1: number; y1: number; z: number; c: [number, number, number, number] };
    const blocks: Block[] = [];
    for (let y0 = 0; y0 < h; y0 += size)
      for (let x0 = 0; x0 < w; x0 += size) {
        const x1 = Math.min(w, x0 + size), y1 = Math.min(h, y0 + size);
        const r = next();
        if (mask && (x1 - x0 < size || y1 - y0 < size)) continue;
        let R = 0, G = 0, B = 0, A = 0, cnt = 0;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const j = (y * w + x) * 4, a = d[j + 3];
            R += d[j] * a; G += d[j + 1] * a; B += d[j + 2] * a; A += a; cnt++;
          }
        const c: [number, number, number, number] = A > 0 ? [R / A, G / A, B / A, A / cnt] : [0, 0, 0, 0];
        const z = (level ? luma(c[0], c[1], c[2]) / 255 : r) * depth;
        blocks.push({ x0, y0, x1, y1, z, c });
      }
    // Painter's order: low blocks first, then far from the center first.
    blocks.sort((a, b) => a.z - b.z || Math.hypot((b.x0 + b.x1) / 2 - cx, (b.y0 + b.y1) / 2 - cy) - Math.hypot((a.x0 + a.x1) / 2 - cx, (a.y0 + a.y1) / 2 - cy));
    // Simple perspective from a viewer above the center.
    const k = 1 / 400;
    const proj = (x: number, y: number, z: number) => [cx + (x - cx) * (1 + z * k), cy + (y - cy) * (1 + z * k)];
    const shade = (c: number[], f: number): [number, number, number, number] => [c[0] * f, c[1] * f, c[2] * f, c[3]];
    blocks.forEach((b, bi) => {
      if (bi % 64 === 0) progress?.report?.(bi / blocks.length);
      if (b.c[3] === 0) return;
      const { x0, y0, x1, y1, z } = b;
      if (pyramids) {
        const [ax, ay] = proj((x0 + x1) / 2, (y0 + y1) / 2, z);
        const offX = ax - (x0 + x1) / 2, offY = ay - (y0 + y1) / 2;
        // Faces lit from the upper left; faces leaning toward the apex shift are drawn first.
        const faces: [number[], number, number][] = [
          [[x0, y0, x1, y0, ax, ay], 1.0, -offY],
          [[x1, y0, x1, y1, ax, ay], 0.65, offX],
          [[x1, y1, x0, y1, ax, ay], 0.5, offY],
          [[x0, y1, x0, y0, ax, ay], 0.85, -offX],
        ];
        faces.sort((a, b2) => a[2] - b2[2]);
        for (const [pts, f] of faces) fillConvex(o, w, h, pts, shade(b.c, f));
        return;
      }
      const [fx0, fy0] = proj(x0, y0, z), [fx1, fy1] = proj(x1, y1, z);
      if (x0 > cx) fillConvex(o, w, h, [x0, y0, fx0, fy0, fx0, fy1, x0, y1], shade(b.c, 0.8));
      if (x1 < cx) fillConvex(o, w, h, [x1, y0, fx1, fy0, fx1, fy1, x1, y1], shade(b.c, 0.6));
      if (y0 > cy) fillConvex(o, w, h, [x0, y0, fx0, fy0, fx1, fy0, x1, y0], shade(b.c, 0.9));
      if (y1 < cy) fillConvex(o, w, h, [x0, y1, fx0, fy1, fx1, fy1, x1, y1], shade(b.c, 0.5));
      if (solid) fillConvex(o, w, h, [fx0, fy0, fx1, fy0, fx1, fy1, fx0, fy1], b.c);
      else {
        // The front face shows the block's own pixels, scaled with the face.
        const sx = (x1 - x0) / (fx1 - fx0), sy = (y1 - y0) / (fy1 - fy0);
        for (let y = Math.max(0, Math.ceil(fy0 - 0.5)); y <= Math.min(h - 1, Math.floor(fy1 - 0.5)); y++) {
          const yy = clamp(Math.floor(y0 + (y + 0.5 - fy0) * sy), y0, y1 - 1);
          for (let x = Math.max(0, Math.ceil(fx0 - 0.5)); x <= Math.min(w - 1, Math.floor(fx1 - 0.5)); x++) {
            const xx = clamp(Math.floor(x0 + (x + 0.5 - fx0) * sx), x0, x1 - 1), q = (yy * w + xx) * 4;
            o.set(d.subarray(q, q + 4), (y * w + x) * 4);
          }
        }
      }
    });
    return out;
  },
});

// Kuwahara filter (Kuwahara et al. 1976): each pixel takes the mean of the
// least-varying of its four overlapping quadrants, which flattens texture into
// brush-like patches while keeping edges. Quadrant means come from trailing
// box filters (running sums), so cost is independent of the brush size.
export function kuwahara(src: RGBA8, r: number, progress?: Progress, reach?: number): RGBA8 {
  const { width: w, height: h } = src;
  const n = w * h;
  const work = fillTransparent(src, reach);
  const L = lumaPlane(work), L2 = new Float32Array(n), tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) L2[i] = L[i] * L[i];
  const trailing = (pl: Plane) => {
    boxH(pl, tmp, w, h, r, 0);
    boxV(tmp, pl, w, h, r, 0);
  };
  trailing(L);
  trailing(L2);
  // Smooth quadrant weights ~ variance^-4 (the weighting of Papari et al.
  // 2007, "Artistic Edge and Corner Enhancing Smoothing") instead of a hard
  // argmin, so flat gradients average all quadrants rather than banding.
  const wts = new Uint8Array(n * 4);
  for (let y = 0; y < h; y++) {
    tick(sub(progress, 0, 0.4), y, h);
    const ya = y * w, yb = Math.min(h - 1, y + r) * w;
    for (let x = 0; x < w; x++) {
      const xb = Math.min(w - 1, x + r);
      const i0 = ya + x, i1 = ya + xb, i2 = yb + x, i3 = yb + xb;
      const v0 = Math.max(0, L2[i0] - L[i0] * L[i0]) + 1, v1 = Math.max(0, L2[i1] - L[i1] * L[i1]) + 1;
      const v2 = Math.max(0, L2[i2] - L[i2] * L[i2]) + 1, v3 = Math.max(0, L2[i3] - L[i3] * L[i3]) + 1;
      const vm = Math.min(v0, v1, v2, v3);
      const w0 = (vm / v0) ** 4, w1 = (vm / v1) ** 4, w2 = (vm / v2) ** 4, w3 = (vm / v3) ** 4;
      const k = 255 / (w0 + w1 + w2 + w3), q = (y * w + x) * 4;
      wts[q] = w0 * k; wts[q + 1] = w1 * k; wts[q + 2] = w2 * k; wts[q + 3] = w3 * k;
    }
  }
  const out = newImage(src), o = out.data, pl = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    checkProgress(progress, 0.4 + c * 0.2);
    channelPlane(work, c, pl);
    trailing(pl);
    for (let y = 0; y < h; y++) {
      const ya = y * w, yb = Math.min(h - 1, y + r) * w;
      for (let x = 0; x < w; x++) {
        const xb = Math.min(w - 1, x + r), q = (ya + x) * 4;
        const a0 = wts[q], a1 = wts[q + 1], a2 = wts[q + 2], a3 = wts[q + 3];
        o[q + c] = (a0 * pl[ya + x] + a1 * pl[ya + xb] + a2 * pl[yb + x] + a3 * pl[yb + xb]) / (a0 + a1 + a2 + a3);
      }
    }
  }
  copyAlpha(src, out);
  return out;
}
function checkProgress(progress: Progress | undefined, f: number) {
  checkCancelled(progress);
  progress?.report?.(f);
}

const oilReach = (p: ParamValues, ctx: OperationContext) => px(ctx, (num(p, 'cleanliness') * 1.05 + 2 * (1 + num(p, 'stylization') * 1.2) + 2) * num(p, 'scale')) + 4;

export const oilPaint = defineOp({
  id: 'oil-paint',
  label: 'Oil Paint',
  category: 'Stylize',
  support: oilReach,
  fillReach: oilReach,
  params: [
    { key: 'stylization', label: 'Stylization', type: 'number', min: 0.1, max: 10, step: 0.1, default: 4 },
    { key: 'cleanliness', label: 'Cleanliness', type: 'number', min: 0, max: 10, step: 0.1, default: 5 },
    { key: 'scale', label: 'Scale', type: 'number', min: 0.1, max: 10, step: 0.1, default: 1 },
    { key: 'bristle', label: 'Bristle Detail', type: 'number', min: 0, max: 10, step: 0.1, default: 3 },
    { key: 'angle', label: 'Lighting Angle', type: 'number', min: -180, max: 180, step: 1, default: 135, unit: '°' },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h } = src;
    const scale = num(p, 'scale');
    const pre = num(p, 'cleanliness') * 0.35 * scale;
    const base = px(ctx, pre) > 0.3 ? gaussianRGBA(src, px(ctx, pre), sub(progress, 0, 0.2)) : src;
    const r = Math.max(1, Math.round(px(ctx, (1 + num(p, 'stylization') * 1.2) * scale)));
    const out = kuwahara(base, r, sub(progress, 0.2, 0.9), oilReach(p, ctx));
    const bristle = num(p, 'bristle');
    if (bristle > 0) {
      // Relief lighting from the painted luminance gives the strokes body.
      const L = lumaPlane(out), a = (num(p, 'angle') * Math.PI) / 180, s = px(ctx, Math.max(0.5, scale));
      const vx = Math.cos(a) * s, vy = -Math.sin(a) * s, o = out.data, k = bristle * 0.12;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const sh = (sample(L, w, h, x - vx, y - vy) - sample(L, w, h, x + vx, y + vy)) * k, j = (y * w + x) * 4;
          o[j] += sh; o[j + 1] += sh; o[j + 2] += sh;
        }
    }
    return out;
  },
});

export const glowingEdges = defineOp({
  id: 'glowing-edges',
  label: 'Glowing Edges',
  category: 'Stylize',
  support: (p, ctx) => px(ctx, num(p, 'smoothness') * 0.9 + num(p, 'width')) + 4,
  params: [
    { key: 'width', label: 'Edge Width', type: 'number', min: 1, max: 14, step: 1, default: 2 },
    { key: 'brightness', label: 'Edge Brightness', type: 'number', min: 0, max: 20, step: 1, default: 6 },
    { key: 'smoothness', label: 'Smoothness', type: 'number', min: 1, max: 15, step: 1, default: 5 },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h } = src;
    const n = w * h;
    const smooth = fillTransparent(gaussianRGBA(src, px(ctx, num(p, 'smoothness') * 0.3), sub(progress, 0, 0.4)));
    const r = Math.floor(px(ctx, num(p, 'width')) / 2), gain = num(p, 'brightness') / 3;
    const out = newImage(src), o = out.data, mag = new Float32Array(n), q = new Uint8Array(n);
    for (let c = 0; c < 3; c++) {
      sobel(channelPlane(smooth, c), w, h, mag);
      for (let i = 0; i < n; i++) q[i] = clamp(mag[i] * gain, 0, 255);
      const wide = minMaxPlane(q, w, h, r, true, true, sub(progress, 0.4 + c * 0.2, 0.6 + c * 0.2));
      for (let i = 0, j = c; i < n; i++, j += 4) o[j] = wide[i];
    }
    copyAlpha(src, out);
    return out;
  },
});
