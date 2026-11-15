/**
 * Stroke smoothing for freehand tools (Pencil, Paintbrush, Merge Brush). It
 * acts while drawing (the preview shows the smoothed line), unlike Fidelity,
 * which only simplifies the finished stroke. There are two styles
 * (the `smoothingStyle` preference):
 *
 * - 'live' (the default): the line stays under the pen. Each drawn point is
 *   the pen's path averaged over a stretch on both sides of it (a straight
 *   line fitted to the samples within reach, read at the point), so tremor
 *   and jitter average out. Near the pen there is nothing ahead yet, so the
 *   last stretch of the line is fitted from what is behind it and settles as
 *   the pen moves on: push() moves the points it returned earlier, in place,
 *   until they are `firm`. Nothing trails the pen, so no guide is drawn.
 * - 'string': a pulled string. The drawn point trails the pen on a string
 *   whose length grows with the smoothing amount; it only moves when the pen
 *   pulls the string tight. The string is drawn as a guide.
 *
 * Every pen sample gives exactly one drawn point, so lists kept beside the
 * points (pen pressure, timestamps) stay aligned. Distances are in screen
 * pixels, so smoothing feels the same at every zoom.
 *
 * With the Corners setting on, settle() finds the stroke's corners on the
 * pen's own samples and redoes the smoothing so it no longer cuts across
 * them (corners.js).
 */
import { detectCorners, restoreCorners } from './corners.js';

/** String length in screen pixels at smoothing 100. */
export const MAX_STRING_PX = 40;

/** String length in document units for a smoothing amount 0 (off) .. 100 at a zoom. */
export function stringLength(amount, zoom) {
  const a = Math.max(0, Math.min(100, Number(amount) || 0));
  return ((a / 100) * MAX_STRING_PX) / (zoom > 0 ? zoom : 1);
}

/** How far along the stroke, in screen pixels, live smoothing averages on each side of a point at smoothing 100. */
export const MAX_REACH_PX = 48;

/** Live smoothing's reach in document units for a smoothing amount 0 (off) .. 100 at a zoom. */
export function reachLength(amount, zoom) {
  const a = Math.max(0, Math.min(100, Number(amount) || 0));
  return ((a / 100) * MAX_REACH_PX) / (zoom > 0 ? zoom : 1);
}

/** The smoothing style the preferences ask for: 'live' unless set to 'string'. */
export function smoothingStyle(prefs) {
  return prefs?.get?.('smoothingStyle') === 'string' ? 'string' : 'live';
}

/** Choices for the Smoothing style setting (tool options and the Properties panel). */
export const SMOOTHING_STYLES = [
  { value: 'live', label: 'Live' },
  { value: 'string', label: 'Pulled string' },
];

/** First index in [lo, hi] whose value is at least v (hi + 1 if none). */
function firstAtLeast(list, v, lo, hi) {
  let a = lo;
  let b = hi + 1;
  while (a < b) {
    const m = (a + b) >> 1;
    if (list[m] < v) a = m + 1;
    else b = m;
  }
  return a;
}

export class Stabilizer {
  /**
   * @param {number} amount smoothing 0 (off) .. 100
   * @param {number} zoom view zoom (screen pixels per document unit)
   * @param {{x:number,y:number}} start where the stroke starts
   * @param {number} [time] when it starts (ms), for telling where the pen slowed down
   * @param {'live'|'string'} [style] how the line is steadied
   */
  constructor(amount, zoom, start, time, style = 'live') {
    this.style = style === 'string' ? 'string' : 'live';
    this.length = this.style === 'string' ? stringLength(amount, zoom) : 0;
    this.reach = this.style === 'live' ? reachLength(amount, zoom) : 0;
    this.zoom = zoom > 0 ? zoom : 1;
    // Live smoothing: the drawn points (moved in place until firm), the distance along the pen's
    // path at each sample, and running sums for fitting a line to any run of samples.
    this.out = [{ x: start.x, y: start.y }];
    this.along = [0];
    this.sums = [[0, 0, 0, 0, 0, 0]];
    this.#add(0, 0, 0);
    this.firmCount = 1;
    this.cur = { x: start.x, y: start.y };
    this.pen = { x: start.x, y: start.y };
    this.raw = [{ x: start.x, y: start.y }];
    this.times = [time];
    this.settled = null;
  }

  get active() {
    return this.length > 0 || this.reach > 0;
  }

  /** How many points from the start of the stroke no longer move (all of them, except with live smoothing). */
  get firm() {
    return this.reach > 0 ? this.firmCount : this.raw.length;
  }

  /** Add a sample (distance along the path, position relative to the start) to the running sums. */
  #add(t, x, y) {
    const s = this.sums[this.sums.length - 1];
    this.sums.push([s[0] + t, s[1] + x, s[2] + y, s[3] + t * t, s[4] + t * x, s[5] + t * y]);
  }

  /**
   * The live-smoothed point for sample i of a piece of the stroke (samples
   * a .. b): a line fitted to the samples within reach along the path on
   * each side, read at i. Where the piece ends before the reach on one
   * side, the other side reaches half as much further.
   */
  #fit(i, a, b) {
    const t = this.along;
    const r = this.reach;
    const ti = t[i];
    const ahead = Math.min(r, t[b] - ti);
    const behind = Math.min(r, ti - t[a]);
    const lo = firstAtLeast(t, ti - (r + (r - ahead) / 2) - 1e-9, a, i);
    const hi = firstAtLeast(t, ti + (r + (r - behind) / 2) + 1e-9, i, b) - 1;
    const n = hi - lo + 1;
    const o = this.raw[0];
    if (n < 2) return { x: this.raw[i].x, y: this.raw[i].y };
    const p = this.sums[lo];
    const q = this.sums[hi + 1];
    const mt = (q[0] - p[0]) / n;
    const mx = (q[1] - p[1]) / n;
    const my = (q[2] - p[2]) / n;
    const spread = q[3] - p[3] - (q[0] - p[0]) * mt;
    // Samples all at one spot along the path: their average.
    if (!(spread > 1e-9 * Math.max(1, r * r))) return { x: o.x + mx, y: o.y + my };
    const d = (ti - mt) / spread;
    return { x: o.x + mx + (q[4] - p[4] - (q[0] - p[0]) * mx) * d, y: o.y + my + (q[5] - p[5] - (q[0] - p[0]) * my) * d };
  }

  /** Live smoothing for the next pen sample: the points still within reach of the pen settle further. */
  #pushLive(p) {
    const n = this.raw.length - 1;
    const prev = this.raw[n - 1];
    const o = this.raw[0];
    this.along.push(this.along[n - 1] + Math.hypot(p.x - prev.x, p.y - prev.y));
    this.#add(this.along[n], p.x - o.x, p.y - o.y);
    this.out.push({ x: p.x, y: p.y });
    for (let i = this.firmCount; i <= n; i++) Object.assign(this.out[i], this.#fit(i, 0, n));
    while (this.firmCount < n && this.along[n] - this.along[this.firmCount] > this.reach) this.firmCount++;
    return this.out[n];
  }

  /** The drawn point for the next pen sample (taken at `time` ms, if known). */
  push(p, time) {
    this.pen = { x: p.x, y: p.y };
    this.raw.push(this.pen);
    this.times.push(time);
    if (this.reach > 0) return this.#pushLive(p);
    if (!this.active) return { x: p.x, y: p.y };
    const dx = p.x - this.cur.x;
    const dy = p.y - this.cur.y;
    const d = Math.hypot(dx, dy);
    if (d > this.length) {
      const k = (d - this.length) / d;
      this.cur = { x: this.cur.x + dx * k, y: this.cur.y + dy * k };
    }
    return { ...this.cur };
  }

  /**
   * The points to keep when the pen lifts. The stroke ends where the string
   * left it (so the flick of a lifting pen stays out); a stroke shorter than
   * the string, which smoothing would have kept from moving at all, keeps
   * the pen's own path instead.
   */
  finish(points) {
    if (!(this.length > 0) || points.length !== this.raw.length) return points;
    const first = points[0];
    const moved = points.some((p) => Math.hypot(p.x - first.x, p.y - first.y) > this.length * 0.05);
    return moved ? points : this.raw.map((p) => ({ ...p }));
  }

  /**
   * Live smoothing redone piece by piece between the corners (indices): each
   * corner stays where the pen drew it, and nothing is averaged across one.
   */
  #liveBetween(corners) {
    const last = this.raw.length - 1;
    const out = this.raw.map((p) => ({ x: p.x, y: p.y }));
    const stops = [0, ...corners, last];
    for (let j = 0; j + 1 < stops.length; j++) {
      const a = stops[j];
      const b = stops[j + 1];
      for (let i = a + 1; i < b; i++) out[i] = this.#fit(i, a, b);
      if (b === last && b > a) out[b] = this.#fit(b, a, b);
    }
    return out;
  }

  /**
   * The points to keep when the pen lifts and the corners among them
   * (indices), for a Corners amount 0 (off) .. 100. The points are finish()'s,
   * except that with corners found the smoothing is redone to keep them
   * sharp. Asking again gives the same answer.
   */
  settle(points, corners = 0) {
    if (this.settled) return this.settled;
    let pts = this.finish(points);
    let found = [];
    if (pts.length === this.raw.length && corners > 0) {
      found = detectCorners(this.raw, { amount: corners, zoom: this.zoom, times: this.times });
      if (found.length && this.reach > 0) pts = this.#liveBetween(found);
      else if (found.length && this.active && pts === points) pts = restoreCorners(this.raw, found, this.length);
    }
    this.settled = { points: pts, corners: found };
    return this.settled;
  }
}

/** Draw the string from the smoothed point to the pen (screen overlay); live smoothing has none. */
export function drawString(ctx, editor, stabilizer) {
  if (!(stabilizer?.length > 0)) return;
  const a = editor.view.toScreen(stabilizer.cur.x, stabilizer.cur.y);
  const b = editor.view.toScreen(stabilizer.pen.x, stabilizer.pen.y);
  ctx.save();
  ctx.strokeStyle = 'rgba(128,128,128,0.8)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
