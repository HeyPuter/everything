// Blur Gallery: Field Blur (blur amounts at pins, interpolated), Path Blur
// (motion along drawn paths) and Spin Blur (rotation inside an ellipse).
import { rgba8, type NormPath, type Pin, type Progress } from '../types';
import { variableBlur } from './blur';
import { bool, channelPlane, clamp, copyImage, defineOp, isOpaque, linearFilterRGBA, num, point, premulPlane, px, sample, tick, type Plane } from './common';

const smoothstep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// ---------------------------------------------------------------------------
// Field Blur

/** Per-pixel blur from pins by inverse-squared-distance weighting. Distances
 * gain a small floor so the field stays smooth around each pin. */
export function fieldSigma(w: number, h: number, pins: { x: number; y: number; value: number }[]): Float32Array {
  const sigma = new Float32Array(w * h);
  if (!pins.length) return sigma;
  if (pins.length === 1) return sigma.fill(pins[0].value);
  const eps = (0.02 * Math.hypot(w, h)) ** 2 + 1;
  // The field is smooth, so evaluate it on a coarse grid and interpolate.
  const step = Math.max(1, Math.min(8, Math.floor(Math.min(w, h) / 16)));
  const gw = Math.ceil((w - 1) / step) + 1, gh = Math.ceil((h - 1) / step) + 1;
  const grid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const x = Math.min(w - 1, gx * step) + 0.5, y = Math.min(h - 1, gy * step) + 0.5;
      let ws = 0, vs = 0;
      for (const p of pins) {
        const d2 = (x - p.x) ** 2 + (y - p.y) ** 2;
        const wt = 1 / (d2 + eps);
        ws += wt;
        vs += wt * p.value;
      }
      grid[gy * gw + gx] = vs / ws;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) sigma[y * w + x] = sample(grid, gw, gh, Math.min(x, w - 1) / step, Math.min(y, h - 1) / step);
  return sigma;
}

export const fieldBlur = defineOp({
  id: 'field-blur',
  label: 'Field Blur',
  category: 'Blur Gallery',
  params: [{ key: 'pins', label: 'Blur Pins', type: 'pins', min: 0, max: 500, unit: 'px', default: [{ x: 0.5, y: 0.5, value: 15 }], limit: 32 }],
  run(src, p, ctx, progress) {
    const { width: w, height: h } = src;
    const pins = (p.pins as Pin[]).map((q) => ({ x: q.x * w, y: q.y * h, value: px(ctx, q.value) }));
    if (!pins.length) return copyImage(src);
    const sigma = fieldSigma(w, h, pins);
    let max = 0;
    for (const v of sigma) if (v > max) max = v;
    return variableBlur(src, sigma, max, progress);
  },
});

// ---------------------------------------------------------------------------
// Path Blur

type Seg = { ax: number; ay: number; bx: number; by: number; dx: number; dy: number; len: number; strength: number };
/** Path segments in pixels, resampled to a manageable count; `strength`
 * fades toward the path ends by `taper` (fraction of the path at each end). */
export function pathSegments(paths: NormPath[], w: number, h: number, taper: number): Seg[] {
  const out: Seg[] = [];
  for (const path of paths) {
    const pts = path.map((q) => [q.x * w, q.y * h] as [number, number]);
    if (pts.length < 2) continue;
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (total < 1e-6) continue;
    // Resample so a path has at most ~96 segments of at least 2 px.
    const n = Math.max(1, Math.min(96, Math.round(total / 2)));
    const step = total / n;
    const res: [number, number][] = [pts[0]];
    let acc = 0, k = 1, prev = pts[0];
    for (let s = 1; s <= n; s++) {
      const target = s * step;
      while (k < pts.length) {
        const seg = Math.hypot(pts[k][0] - prev[0], pts[k][1] - prev[1]);
        if (acc + seg >= target - 1e-9) {
          const t = seg > 0 ? (target - acc) / seg : 0;
          const q: [number, number] = [prev[0] + (pts[k][0] - prev[0]) * t, prev[1] + (pts[k][1] - prev[1]) * t];
          acc = target;
          prev = q;
          res.push(q);
          break;
        }
        acc += seg;
        prev = pts[k++];
      }
    }
    for (let i = 1; i < res.length; i++) {
      const [ax, ay] = res[i - 1], [bx, by] = res[i];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-9) continue;
      const t = (i - 0.5) / (res.length - 1);
      const strength = taper > 0 ? smoothstep(Math.min(t, 1 - t) / (taper / 2)) : 1;
      out.push({ ax, ay, bx, by, dx: (bx - ax) / len, dy: (by - ay) / len, len, strength });
    }
  }
  return out;
}

/** Motion direction (unit vector scaled by local strength) at each point of a
 * coarse grid, blended from nearby segments by inverse squared distance. */
export function directionField(segs: Seg[], w: number, h: number, step: number) {
  const gw = Math.ceil((w - 1) / step) + 1, gh = Math.ceil((h - 1) / step) + 1;
  const fx = new Float32Array(gw * gh), fy = new Float32Array(gw * gh);
  const eps = (0.01 * Math.hypot(w, h)) ** 2 + 1;
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const x = Math.min(w - 1, gx * step) + 0.5, y = Math.min(h - 1, gy * step) + 0.5;
      let sx = 0, sy = 0, ws = 0, ss = 0;
      for (const s of segs) {
        const t = clamp(((x - s.ax) * s.dx + (y - s.ay) * s.dy) / s.len, 0, 1);
        const px0 = s.ax + (s.bx - s.ax) * t, py0 = s.ay + (s.by - s.ay) * t;
        const wt = 1 / ((x - px0) ** 2 + (y - py0) ** 2 + eps);
        sx += wt * s.dx;
        sy += wt * s.dy;
        ss += wt * s.strength;
        ws += wt;
      }
      const m = Math.hypot(sx, sy);
      const strength = ws > 0 ? ss / ws : 0;
      fx[gy * gw + gx] = m > 1e-9 ? (sx / m) * strength : 0;
      fy[gy * gw + gx] = m > 1e-9 ? (sy / m) * strength : 0;
    }
  return { fx, fy, gw, gh };
}

function streak(plane: Plane, dst: Plane, w: number, h: number, dirX: Float32Array, dirY: Float32Array, length: number, centered: boolean, progress?: Progress): Plane {
  const n = Math.max(2, Math.min(96, Math.ceil(length)));
  for (let y = 0; y < h; y++) {
    tick(progress, y, h);
    for (let x = 0; x < w; x++) {
      const i = y * w + x, dx = dirX[i] * length, dy = dirY[i] * length;
      if (Math.abs(dx) + Math.abs(dy) < 0.25) {
        dst[i] = plane[i];
        continue;
      }
      let acc = 0;
      for (let k = 0; k < n; k++) {
        const t = centered ? k / (n - 1) - 0.5 : -k / (n - 1);
        acc += sample(plane, w, h, x + dx * t, y + dy * t);
      }
      dst[i] = acc / n;
    }
  }
  return dst;
}

export const pathBlur = defineOp({
  id: 'path-blur',
  label: 'Path Blur',
  category: 'Blur Gallery',
  params: [
    { key: 'paths', label: 'Motion Paths', type: 'paths', default: [[{ x: 0.25, y: 0.55 }, { x: 0.5, y: 0.45 }, { x: 0.75, y: 0.55 }]], limit: 16 },
    { key: 'speed', label: 'Speed', type: 'number', min: 0, max: 500, step: 1, default: 40, unit: 'px' },
    { key: 'taper', label: 'Taper', type: 'number', min: 0, max: 100, step: 1, default: 0, unit: '%' },
    { key: 'centered', label: 'Centered Blur', type: 'checkbox', default: true },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h } = src;
    const length = px(ctx, num(p, 'speed'));
    const segs = pathSegments(p.paths as NormPath[], w, h, num(p, 'taper') / 100);
    if (!segs.length || length < 0.5) return copyImage(src);
    const step = Math.max(1, Math.min(8, Math.floor(Math.min(w, h) / 16)));
    const f = directionField(segs, w, h, step);
    const dirX = new Float32Array(w * h), dirY = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        dirX[y * w + x] = sample(f.fx, f.gw, f.gh, x / step, y / step);
        dirY[y * w + x] = sample(f.fy, f.gw, f.gh, x / step, y / step);
      }
    const centered = bool(p, 'centered');
    return linearFilterRGBA(src, (pl, t, ww, hh, pr) => streak(pl, t, ww, hh, dirX, dirY, length, centered, pr), progress);
  },
});

// ---------------------------------------------------------------------------
// Spin Blur

/** Arc (radians) of the spin at each pixel: the full blur angle inside the
 * ellipse, fading to zero across the feather band outside it. */
export function spinArc(w: number, h: number, cx: number, cy: number, rx: number, ry: number, rot: number, angle: number, feather: number): Float32Array {
  const arc = new Float32Array(w * h);
  const c = Math.cos(rot), s = Math.sin(rot);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry;
      const rho = Math.hypot(u, v);
      const wt = rho <= 1 ? 1 : feather > 0 ? 1 - smoothstep((rho - 1) / feather) : 0;
      arc[y * w + x] = angle * wt;
    }
  return arc;
}

export const spinBlur = defineOp({
  id: 'spin-blur',
  label: 'Spin Blur',
  category: 'Blur Gallery',
  params: [
    { key: 'center', label: 'Center', type: 'point', default: { x: 0.5, y: 0.5 } },
    { key: 'radiusX', label: 'Radius X', type: 'number', min: 1, max: 200, step: 1, default: 35, unit: '%' },
    { key: 'radiusY', label: 'Radius Y', type: 'number', min: 1, max: 200, step: 1, default: 35, unit: '%' },
    { key: 'rotation', label: 'Ellipse Rotation', type: 'number', min: -180, max: 180, step: 1, default: 0, unit: '°' },
    { key: 'angle', label: 'Blur Angle', type: 'number', min: 0, max: 360, step: 1, default: 15, unit: '°' },
    { key: 'feather', label: 'Feather', type: 'number', min: 0, max: 100, step: 1, default: 20, unit: '%' },
  ],
  run(src, p, _ctx, progress) {
    const { width: w, height: h } = src;
    const c = point(p, 'center'), m = Math.min(w, h);
    const cx = c.x * w, cy = c.y * h;
    const rx = Math.max(0.5, (num(p, 'radiusX') / 100) * m), ry = Math.max(0.5, (num(p, 'radiusY') / 100) * m);
    const rot = (num(p, 'rotation') * Math.PI) / 180, angle = (num(p, 'angle') * Math.PI) / 180;
    if (angle <= 0) return copyImage(src);
    const arc = spinArc(w, h, cx, cy, rx, ry, rot, angle, num(p, 'feather') / 100);
    const cr = Math.cos(rot), sr = Math.sin(rot);
    // Rotation happens in the ellipse's normalized frame, so points travel
    // along concentric ellipses (a wheel seen at an angle). The arc through a
    // pixel is the same for every channel, so it is traced once and alpha and
    // the premultiplied colors are sampled together (the same arithmetic as
    // filtering each plane on its own, at a fraction of the cost).
    const n = w * h, opaque = isOpaque(src);
    const planes = opaque ? [0, 1, 2].map((ch) => channelPlane(src, ch)) : [channelPlane(src, 3), ...[0, 1, 2].map((ch) => premulPlane(src, ch))];
    const P = planes.length;
    const outs = planes.map(() => new Float32Array(n));
    const acc = new Float64Array(P);
    for (let y = 0; y < h; y++) {
      tick(progress, y, h);
      for (let x = 0; x < w; x++) {
        const i = y * w + x, a = arc[i];
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const u = (dx * cr + dy * sr) / rx, v = (-dx * sr + dy * cr) / ry;
        const r = Math.hypot(u * rx, v * ry);
        const steps = Math.min(128, Math.ceil(a * r));
        if (steps < 1) {
          for (let q = 0; q < P; q++) outs[q][i] = planes[q][i];
          continue;
        }
        acc.fill(0);
        for (let k = 0; k <= steps; k++) {
          const phi = a * (k / steps - 0.5), co = Math.cos(phi), si = Math.sin(phi);
          const uu = (u * co - v * si) * rx, vv = (u * si + v * co) * ry;
          // Clamped bilinear sample, as `sample` does for one plane.
          let sx = cx + uu * cr - vv * sr - 0.5, sy = cy + uu * sr + vv * cr - 0.5;
          if (sx < 0) sx = 0; else if (sx > w - 1) sx = w - 1;
          if (sy < 0) sy = 0; else if (sy > h - 1) sy = h - 1;
          const x0 = sx | 0, y0 = sy | 0;
          const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
          const fx = sx - x0, fy = sy - y0;
          const i00 = y0 * w + x0, i10 = y0 * w + x1, i01 = y1 * w + x0, i11 = y1 * w + x1;
          for (let q = 0; q < P; q++) {
            const pl = planes[q];
            const p00 = pl[i00], p10 = pl[i10], p01 = pl[i01], p11 = pl[i11];
            const top = p00 + (p10 - p00) * fx;
            acc[q] += top + (p01 + (p11 - p01) * fx - top) * fy;
          }
        }
        for (let q = 0; q < P; q++) outs[q][i] = acc[q] / (steps + 1);
      }
    }
    // Back to straight color, as linearFilterRGBA does.
    const out = rgba8(w, h), o = out.data, d = src.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (opaque) {
        o[j] = outs[0][i]; o[j + 1] = outs[1][i]; o[j + 2] = outs[2][i]; o[j + 3] = 255;
        continue;
      }
      const al = outs[0][i];
      o[j + 3] = al;
      for (let c = 0; c < 3; c++) o[j + c] = al > 1e-3 ? Math.fround((outs[c + 1][i] * 255) / al) : d[j + c];
    }
    progress?.report?.(1);
    return out;
  },
});
