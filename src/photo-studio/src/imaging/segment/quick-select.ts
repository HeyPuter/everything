// Quick Selection: brush strokes seed a graph cut (Boykov and Jolly 2001, solved
// with Boykov-Kolmogorov max-flow) on a downsampled grid. A color histogram of the
// strokes against a histogram of everything unlike them drives the data term,
// contrast-sensitive links make the cut follow edges, a mild distance prior keeps
// growth local, and a guided filter lifts the result back up with soft edges.
import { mask8, type Mask8, type RGBA8 } from '../types';
import { downscaleRGBA, guidedFilterGray, resizePlane } from './filters';
import { rgbPlanes, setSmoothness } from './grabcut';
import { GridGraph, INF_CAP } from './maxflow';
import { workSize } from './subject';

export type QuickStroke = { points: [number, number][]; positive: boolean };

const BINS = 16, NB = BINS * BINS * BINS, SCALE = 100;

export class QuickSelector {
  readonly w: number;
  readonly h: number;
  private readonly sx: number;
  private readonly sy: number;
  private readonly edges: Int32Array;
  private readonly bin: Uint16Array;
  // Guide for the edge-aware upsampling, at twice the graph resolution.
  private readonly mw: number;
  private readonly mh: number;
  private readonly mluma: Float32Array;
  constructor(readonly img: RGBA8, opts: { workSize?: number } = {}) {
    const [w, h] = workSize(img.width, img.height, opts.workSize ?? 400);
    this.w = w;
    this.h = h;
    this.sx = w / img.width;
    this.sy = h / img.height;
    const small = downscaleRGBA(img, w, h), px = rgbPlanes(small);
    const g = new GridGraph(w, h, 4);
    setSmoothness(g, px, 40, SCALE);
    this.edges = g.cap;
    this.bin = new Uint16Array(w * h);
    const q = 256 / BINS;
    for (let i = 0; i < w * h; i++)
      this.bin[i] = ((px[i * 3] / q) | 0) * BINS * BINS + ((px[i * 3 + 1] / q) | 0) * BINS + ((px[i * 3 + 2] / q) | 0);
    [this.mw, this.mh] = workSize(img.width, img.height, Math.max(w, h) * 2);
    const mid = downscaleRGBA(img, this.mw, this.mh), d = mid.data;
    this.mluma = new Float32Array(this.mw * this.mh);
    for (let i = 0, j = 0; j < this.mluma.length; i += 4, j++)
      this.mluma[j] = ((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * d[i + 3]) / 65025;
  }

  // Applies `strokes` to `existing`: positive strokes can only add, negative only
  // remove (both kinds in one call let the cut move the edge either way).
  update(strokes: QuickStroke[], existing: Mask8 | undefined, brushSize: number): Mask8 {
    const { w, h, img, bin } = this, n = w * h, W = img.width, H = img.height;
    const pos = new Uint8Array(n), neg = new Uint8Array(n);
    const r = Math.max(0.75, (brushSize / 2) * this.sx);
    let anyPos = false, anyNeg = false;
    for (const s of strokes) {
      if (!s.points.length) continue;
      stamp(s.positive ? pos : neg, w, h, s.points.map(([x, y]) => [x * this.sx, y * this.sy] as [number, number]), r);
      if (s.positive) anyPos = true;
      else anyNeg = true;
    }
    // Strokes that miss the image (painted on the pasteboard) seed nothing.
    anyPos &&= pos.includes(1);
    anyNeg &&= neg.includes(1);
    const prev = existing ?? mask8(W, H);
    if (!anyPos && !anyNeg) return { width: W, height: H, data: new Uint8Array(prev.data) };
    // Existing selection at graph resolution (point-sampled at cell centers).
    const ex = new Uint8Array(n);
    if (existing)
      for (let y = 0; y < h; y++) {
        const Y = Math.min(H - 1, Math.floor((y + 0.5) / this.sy)) * W;
        for (let x = 0; x < w; x++) ex[y * w + x] = existing.data[Y + Math.min(W - 1, Math.floor((x + 0.5) / this.sx))] >= 128 ? 1 : 0;
      }
    // When subtracting, the negative strokes are the seeds that grow (the region
    // to remove), so one "grow from seeds" path serves both modes. `already`
    // marks pixels that are in the result before the cut (selected when adding,
    // unselected when removing).
    const seed = anyPos ? pos : neg, anti = anyPos ? neg : pos;
    const already = new Uint8Array(n);
    if (anyPos !== anyNeg) for (let i = 0; i < n; i++) already[i] = anyPos ? ex[i] : 1 - ex[i];
    const dist = chamfer(seed, w, h);
    const R0 = Math.max(r * 4, Math.max(w, h) * 0.08);
    const hg = new Float32Array(NB), ha = new Float32Array(NB);
    for (let i = 0; i < n; i++) {
      if (seed[i]) hg[bin[i]] += 1;
      else if (anyPos && ex[i]) hg[bin[i]] += 0.3;
    }
    blur3(hg);
    let mg = 0, tg = 0;
    for (let b = 0; b < NB; b++) {
      if (hg[b] > mg) mg = hg[b];
      tg += hg[b];
    }
    // The opposing model: explicit opposite strokes plus every other pixel,
    // discounted by how seed-like its color is, so far-away pixels of the seed
    // color are not counted as evidence against it.
    const disc = new Float32Array(NB);
    for (let b = 0; b < NB; b++) disc[b] = Math.max(0, 1 - (6 * hg[b]) / mg) * 0.25;
    for (let i = 0; i < n; i++) {
      if (seed[i] || already[i]) continue;
      ha[bin[i]] += anti[i] ? 1 : disc[bin[i]];
    }
    blur3(ha);
    let ta = 0;
    for (let b = 0; b < NB; b++) ta += ha[b];
    // Per-bin log-likelihood ratio.
    const eps = 0.02, llr = new Float32Array(NB);
    for (let b = 0; b < NB; b++) llr[b] = Math.log((hg[b] + eps) / (tg + eps * NB)) - Math.log((ha[b] + eps) / (ta + eps * NB));
    const g = new GridGraph(w, h, 4), tr = g.tr;
    g.cap.set(this.edges);
    for (let i = 0; i < n; i++) {
      if (seed[i] || already[i]) tr[i] = INF_CAP;
      else if (anti[i]) tr[i] = -INF_CAP;
      else {
        const pen = Math.min(3, (0.15 * Math.max(0, dist[i] - R0)) / R0);
        const v = llr[bin[i]] - pen;
        tr[i] = Math.round((v > 30 ? 30 : v < -30 ? -30 : v) * SCALE);
      }
    }
    g.maxflow();
    // Keep only the grown region connected to the seeds (and, when adding, to the
    // existing selection).
    const grown = new Uint8Array(n), stack = new Int32Array(n);
    let sp = 0;
    for (let i = 0; i < n; i++) if ((seed[i] || (anyPos && ex[i])) && g.isSource(i)) { grown[i] = 1; stack[sp++] = i; }
    while (sp) {
      const i = stack[--sp], x = i % w;
      if (x > 0 && !grown[i - 1] && g.isSource(i - 1)) { grown[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && !grown[i + 1] && g.isSource(i + 1)) { grown[i + 1] = 1; stack[sp++] = i + 1; }
      if (i >= w && !grown[i - w] && g.isSource(i - w)) { grown[i - w] = 1; stack[sp++] = i - w; }
      if (i + w < n && !grown[i + w] && g.isSource(i + w)) { grown[i + w] = 1; stack[sp++] = i + w; }
    }
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    const low = new Float32Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x, sel = anyPos ? grown[i] : ex[i] && !grown[i] ? 1 : 0;
        low[i] = sel;
        if (sel !== ex[i]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
    const out = { width: W, height: H, data: new Uint8Array(prev.data) };
    if (x1 < 0) return out;
    // Edge-aware upsampling: a guided filter at twice the graph resolution over
    // the changed window, then bilinear to full resolution.
    const { mw, mh } = this, fx = mw / w, fy = mh / h;
    const pad = 3;
    const mx0 = Math.max(0, Math.floor((x0 - pad) * fx)), my0 = Math.max(0, Math.floor((y0 - pad) * fy));
    const mx1 = Math.min(mw, Math.ceil((x1 + 1 + pad) * fx)), my1 = Math.min(mh, Math.ceil((y1 + 1 + pad) * fy));
    const bw = mx1 - mx0, bh = my1 - my0;
    const up = resizePlane(low, w, h, mw, mh);
    const p = new Float32Array(bw * bh), guide = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      p.set(up.subarray((y + my0) * mw + mx0, (y + my0) * mw + mx1), y * bw);
      guide.set(this.mluma.subarray((y + my0) * mw + mx0, (y + my0) * mw + mx1), y * bw);
    }
    const q = guidedFilterGray(guide, p, bw, bh, 2, 1e-3);
    // Full-resolution window covered by the middle-resolution window.
    const X0 = Math.floor((mx0 * W) / mw), X1 = Math.min(W, Math.ceil((mx1 * W) / mw));
    const Y0 = Math.floor((my0 * H) / mh), Y1 = Math.min(H, Math.ceil((my1 * H) / mh));
    const kx = mw / W, ky = mh / H, cols = X1 - X0;
    const xa = new Int32Array(cols), xb = new Int32Array(cols), tx = new Float32Array(cols);
    for (let X = X0; X < X1; X++) {
      const f = Math.min(Math.max((X + 0.5) * kx - 0.5 - mx0, 0), bw - 1), a = Math.floor(f);
      xa[X - X0] = a;
      xb[X - X0] = Math.min(a + 1, bw - 1);
      tx[X - X0] = f - a;
    }
    const mode = anyPos && !anyNeg ? 1 : anyNeg && !anyPos ? -1 : 0, od = out.data, pd = prev.data;
    for (let Y = Y0; Y < Y1; Y++) {
      const f = Math.min(Math.max((Y + 0.5) * ky - 0.5 - my0, 0), bh - 1), a = Math.floor(f), b = Math.min(a + 1, bh - 1), ty = f - a;
      const ra = a * bw, rb = b * bw, o = Y * W;
      for (let c = 0; c < cols; c++) {
        const t = tx[c], top = q[ra + xa[c]] + (q[ra + xb[c]] - q[ra + xa[c]]) * t, bot = q[rb + xa[c]] + (q[rb + xb[c]] - q[rb + xa[c]]) * t;
        let v = ((top + (bot - top) * ty - 0.1) / 0.8) * 255;
        v = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
        const i = o + X0 + c, e = pd[i];
        od[i] = mode === 1 ? (v > e ? v : e) : mode === -1 ? (v < e ? v : e) : v;
      }
    }
    return out;
  }
}

export function quickSelect(img: RGBA8, strokes: QuickStroke[], existing: Mask8 | undefined, brushSize: number): Mask8 {
  return new QuickSelector(img).update(strokes, existing, brushSize);
}

// Two-pass chamfer distance (in pixels) to the nearest set pixel: plenty for a
// soft locality prior and several times cheaper than the exact transform.
function chamfer(src: Uint8Array, w: number, h: number) {
  const d = new Float32Array(w * h), BIG = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : BIG;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
      if (y > 0) {
        if (d[i - w] + 1 < v) v = d[i - w] + 1;
        if (x > 0 && d[i - w - 1] + 1.4142 < v) v = d[i - w - 1] + 1.4142;
        if (x < w - 1 && d[i - w + 1] + 1.4142 < v) v = d[i - w + 1] + 1.4142;
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
      if (y < h - 1) {
        if (d[i + w] + 1 < v) v = d[i + w] + 1;
        if (x < w - 1 && d[i + w + 1] + 1.4142 < v) v = d[i + w + 1] + 1.4142;
        if (x > 0 && d[i + w - 1] + 1.4142 < v) v = d[i + w - 1] + 1.4142;
      }
      d[i] = v;
    }
  return d;
}

// 3x3x3 smoothing of a color histogram so nearby colors share evidence.
function blur3(hist: Float32Array) {
  const tmp = new Float32Array(hist.length);
  for (const s of [1, BINS, BINS * BINS]) {
    tmp.set(hist);
    for (let i = 0; i < hist.length; i++) {
      const c = Math.floor(i / s) % BINS;
      hist[i] = (tmp[i] * 2 + (c > 0 ? tmp[i - s] : tmp[i]) + (c < BINS - 1 ? tmp[i + s] : tmp[i])) / 4;
    }
  }
}

function stamp(dst: Uint8Array, w: number, h: number, pts: [number, number][], r: number) {
  const disk = (cx: number, cy: number) => {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r || (x === Math.floor(cx) && y === Math.floor(cy))) dst[y * w + x] = 1;
  };
  disk(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1], [bx, by] = pts[k], len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / Math.max(0.5, r / 2)));
    for (let s = 1; s <= steps; s++) disk(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
  }
}
