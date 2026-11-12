// Smudge: the tip carries the colors it passes over, so paint drags along the
// stroke. The finger buffer is a tip-sized square centred on the dab holding
// premultiplied RGBA; each dab picks up some of the canvas under it and lays
// the carried paint back down. Strength is the share of carried paint kept
// per tenth of a tip diameter of travel; at 100% the stroke's starting colors
// are dragged all the way. Overlapping dabs reinforce the carried paint, so
// the tool paints with a fixed fine spacing (see `smudgeSpacing`).

/** Dab spacing (fraction of the diameter) that smudge strokes use. */
export const smudgeSpacing = 0.05;

export class SmudgeFinger {
  private size: number;
  private paint: Float32Array;
  private loaded: Uint8Array;
  private cx = 0;
  private cy = 0;
  private last?: [number, number];
  private keep = 1;
  constructor(
    maxSize: number,
    private strength: number,
  ) {
    this.size = Math.max(1, Math.ceil(maxSize) + 4);
    this.paint = new Float32Array(this.size * this.size * 4);
    this.loaded = new Uint8Array(this.size * this.size);
  }
  /** Start a dab of diameter `size` centred at (cx, cy). */
  dab(cx: number, cy: number, size: number) {
    this.cx = Math.round(cx);
    this.cy = Math.round(cy);
    const travel = this.last ? Math.hypot(cx - this.last[0], cy - this.last[1]) : 0;
    this.last = [cx, cy];
    const s = Math.min(1, Math.max(0, this.strength));
    this.keep = s >= 1 ? 1 : Math.pow(s, travel / Math.max(0.5, size * 0.1));
  }
  /** Smudge one pixel: `cur` is the canvas pixel (straight RGBA), `alpha` the
   * tip coverage; writes the new straight RGBA into `out`. */
  pixel(x: number, y: number, alpha: number, cur: ArrayLike<number>, out: Uint8ClampedArray) {
    out[0] = cur[0];
    out[1] = cur[1];
    out[2] = cur[2];
    out[3] = cur[3];
    const n = this.size,
      h = n >> 1;
    const u = x - this.cx + h,
      v = y - this.cy + h;
    if (u < 0 || v < 0 || u >= n || v >= n || alpha <= 0) return;
    const j = v * n + u,
      i = j * 4,
      f = this.paint;
    const ca = cur[3] / 255;
    const cr = cur[0] * ca,
      cg = cur[1] * ca,
      cb = cur[2] * ca;
    if (!this.loaded[j]) {
      // The first touch only picks up what is there.
      f[i] = cr;
      f[i + 1] = cg;
      f[i + 2] = cb;
      f[i + 3] = ca;
      this.loaded[j] = 1;
      return;
    }
    // Pick up: the carried paint gives way to the canvas by (1 - keep).
    const k = this.keep;
    f[i] = cr + (f[i] - cr) * k;
    f[i + 1] = cg + (f[i + 1] - cg) * k;
    f[i + 2] = cb + (f[i + 2] - cb) * k;
    f[i + 3] = ca + (f[i + 3] - ca) * k;
    // Lay the carried paint down with the tip's coverage.
    const a = Math.min(1, alpha);
    const oa = ca + (f[i + 3] - ca) * a;
    if (oa <= 0) {
      out[3] = 0;
      return;
    }
    out[0] = (cr + (f[i] - cr) * a) / oa;
    out[1] = (cg + (f[i + 1] - cg) * a) / oa;
    out[2] = (cb + (f[i + 2] - cb) * a) / oa;
    out[3] = oa * 255;
  }
}
