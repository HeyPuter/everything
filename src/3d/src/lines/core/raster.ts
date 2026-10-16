// Software rasterizer for styled strokes: anti-aliased variable-width polylines with round joins
// and butt / round / square caps, composited "over" into a premultiplied RGBA float image
// (rows top-down). Each stroke covers a pixel once (its strongest segment), so translucent
// strokes do not darken at their joints.
import type { StyledStroke } from './style';

export class StrokeRaster {
  readonly width: number;
  readonly height: number;
  private seg: Int32Array;
  private par: Float32Array;
  private cov: Float32Array;
  private touched = new Int32Array(1024);
  private nTouched = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.seg = new Int32Array(n).fill(-1);
    this.par = new Float32Array(n);
    this.cov = new Float32Array(n);
  }

  private touch(p: number) {
    if (this.nTouched === this.touched.length) {
      const t = new Int32Array(this.touched.length * 2);
      t.set(this.touched);
      this.touched = t;
    }
    this.touched[this.nTouched++] = p;
  }

  /** Draw one stroke over `dst` (premultiplied RGBA, width × height × 4). */
  draw(s: StyledStroke, dst: Float32Array) {
    const W = this.width,
      H = this.height;
    const N = s.x.length;
    if (N < 2) return;
    const seg = this.seg,
      par = this.par,
      cov = this.cov;
    this.nTouched = 0;
    // square caps extend the ends by the half width
    const ext0 = s.caps === 'SQUARE' ? (s.tl[0] + s.tr[0]) / 2 : 0,
      ext1 = s.caps === 'SQUARE' ? (s.tl[N - 1] + s.tr[N - 1]) / 2 : 0;
    for (let i = 0; i < N - 1; i++) {
      let x0 = s.x[i],
        y0 = s.y[i],
        x1 = s.x[i + 1],
        y1 = s.y[i + 1];
      let dx = x1 - x0,
        dy = y1 - y0;
      let len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const ux = dx / len,
        uy = dy / len;
      if (i === 0 && ext0) {
        x0 -= ux * ext0;
        y0 -= uy * ext0;
      }
      if (i === N - 2 && ext1) {
        x1 += ux * ext1;
        y1 += uy * ext1;
      }
      dx = x1 - x0;
      dy = y1 - y0;
      len = Math.hypot(dx, dy);
      const nx = -uy,
        ny = ux;
      const l0 = s.tl[i],
        l1 = s.tl[i + 1],
        r0 = s.tr[i],
        r1 = s.tr[i + 1];
      const maxW = Math.max(l0, l1, r0, r1) + 1.5;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1) - maxW)),
        maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + maxW)),
        minY = Math.max(0, Math.floor(Math.min(y0, y1) - maxW)),
        maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + maxW));
      if (minX > maxX || minY > maxY) continue;
      const butt0 = i === 0 && s.caps !== 'ROUND',
        butt1 = i === N - 2 && s.caps !== 'ROUND';
      const inv = 1 / (len * len);
      for (let py = minY; py <= maxY; py++) {
        const qy = py + 0.5;
        for (let px = minX; px <= maxX; px++) {
          const qx = px + 0.5;
          const tu = ((qx - x0) * dx + (qy - y0) * dy) * inv;
          const t = tu < 0 ? 0 : tu > 1 ? 1 : tu;
          const L = l0 + (l1 - l0) * t,
            R = r0 + (r1 - r0) * t;
          const hw = (L + R) / 2;
          if (hw <= 0) continue;
          const off = (L - R) / 2;
          const cx = x0 + dx * t + nx * off,
            cy = y0 + dy * t + ny * off;
          let d: number;
          let endCut = 1;
          if ((butt0 && tu < 0) || (butt1 && tu > 1)) {
            // flat end: distance across the line, cut along it
            d = Math.abs((qx - cx) * nx + (qy - cy) * ny);
            const beyond = tu < 0 ? -tu * len : (tu - 1) * len;
            endCut = 0.5 - beyond;
            if (endCut <= 0) continue;
            if (endCut > 1) endCut = 1;
          } else d = Math.hypot(qx - cx, qy - cy);
          let c = hw + 0.5 - d;
          if (c <= 0) continue;
          if (c > 1) c = 1;
          if (hw < 0.5) c *= 2 * hw;
          c *= endCut;
          const p = py * W + px;
          if (seg[p] < 0) {
            this.touch(p);
            seg[p] = i;
            par[p] = t;
            cov[p] = c;
          } else if (c > cov[p]) {
            seg[p] = i;
            par[p] = t;
            cov[p] = c;
          }
        }
      }
    }
    // composite the stroke's coverage
    for (let k = 0; k < this.nTouched; k++) {
      const p = this.touched[k];
      const i = seg[p],
        t = par[p];
      const lerp = (a: Float32Array) => a[i] + (a[i + 1] - a[i]) * t;
      const a = cov[p] * lerp(s.a);
      if (a > 0) {
        const o = p * 4;
        const keep = 1 - a;
        dst[o] = lerp(s.r) * a + dst[o] * keep;
        dst[o + 1] = lerp(s.g) * a + dst[o + 1] * keep;
        dst[o + 2] = lerp(s.b) * a + dst[o + 2] * keep;
        dst[o + 3] = a + dst[o + 3] * keep;
      }
      seg[p] = -1;
      cov[p] = 0;
    }
  }
}

/** Rasterize strokes into a new premultiplied RGBA image (or over `dst`). */
export function rasterizeStrokes(strokes: StyledStroke[], W: number, H: number, dst = new Float32Array(W * H * 4)): Float32Array {
  const r = new StrokeRaster(W, H);
  for (const s of strokes) r.draw(s, dst);
  return dst;
}

/** Composite a premultiplied layer over an image (both RGBA float, same size). */
export function compositeOver(layer: Float32Array, dst: Float32Array) {
  for (let i = 0; i < dst.length; i += 4) {
    const a = layer[i + 3];
    if (a <= 0) continue;
    const k = 1 - a;
    dst[i] = layer[i] + dst[i] * k;
    dst[i + 1] = layer[i + 1] + dst[i + 1] * k;
    dst[i + 2] = layer[i + 2] + dst[i + 2] * k;
    dst[i + 3] = a + dst[i + 3] * k;
  }
}
