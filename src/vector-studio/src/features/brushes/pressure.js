/**
 * Pen pressure for freehand strokes: sampling a stroke's pressure along its
 * length, the size a pressure stands for, the width profile of a pressure
 * stroke, and the outline and preview of a round brush whose size follows
 * the pressure.
 *
 * Pressure runs 0 (lightest) to 1 (hardest). Half pressure paints at the
 * set size, the lightest touch at a tenth of it and full pressure at twice
 * the size, so a pen that is not pressed hard still reaches the set size.
 */
import { buildSpine } from './spine.js';
import { sweepOutline, fitRing } from './outline.js';

/** Pressure samples [[t, p]] along a stroke's points (by length), thinned to at most `max`. */
export function pressureSamples(points, pressures, max = 24) {
  if (!pressures || pressures.length !== points.length || points.length < 2) return null;
  const lens = [0];
  for (let i = 1; i < points.length; i++) lens.push(lens[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const L = lens[lens.length - 1];
  if (!(L > 0)) return null;
  const out = [];
  for (let k = 0; k < max; k++) {
    const target = (L * k) / (max - 1);
    let i = 0;
    while (i < lens.length - 2 && lens[i + 1] < target) i++;
    const f = lens[i + 1] > lens[i] ? (target - lens[i]) / (lens[i + 1] - lens[i]) : 0;
    const p = pressures[i] + (pressures[i + 1] - pressures[i]) * Math.min(1, Math.max(0, f));
    out.push([Math.round((target / L) * 1000) / 1000, Math.round(p * 1000) / 1000]);
  }
  return out;
}

/** Size multiplier for a pressure: 1 at half pressure, from 0.1 (lightest) to 2 (hardest). */
export function pressureScale(p) {
  return Math.min(2, Math.max(0.1, 2 * (Number.isFinite(p) ? p : 0.5)));
}

/** Pressures averaged over their neighbors, so sensor jitter does not ripple the stroke's edge. */
export function smoothPressures(pressures, reach = 2) {
  const n = pressures.length;
  return pressures.map((_, i) => {
    let sum = 0;
    let c = 0;
    for (let k = Math.max(0, i - reach); k <= Math.min(n - 1, i + reach); k++) {
      sum += pressures[k];
      c++;
    }
    return sum / c;
  });
}

/** Whether a stroke's pressure really changes (a mouse, or a pen without pressure, reports one value). */
export function pressureVaries(pressures) {
  if (!Array.isArray(pressures) || pressures.length < 2) return false;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pressures) {
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  return hi - lo > 0.02;
}

/**
 * The width profile of a stroke drawn with these pressure samples [[t, p]]
 * (both sides alike), or null when the pressure never changes.
 */
export function pressureWidthProfile(samples) {
  if (!Array.isArray(samples) || samples.length < 2 || !pressureVaries(samples.map((s) => s[1]))) return null;
  return samples.map(([t, p]) => {
    const w = Math.round(pressureScale(p) * 1000) / 1000;
    return { t, l: w, r: w };
  });
}

/**
 * The outline of a round brush swept along `anchors` (an open path) whose
 * diameter at the fraction u of its length is diameterAt(u). Returns closed
 * subpaths for a nonzero fill; where the stroke crosses itself they overlap.
 */
export function roundBrushOutline(anchors, diameterAt, maxDiameter) {
  const spine = buildSpine(anchors, false);
  const L = spine.length;
  if (!(L > 1e-6)) return [];
  const offset = (side, s, nx, ny) => {
    const r = Math.max(0, diameterAt(Math.min(1, Math.max(0, s / L)))) / 2;
    return { x: nx * r, y: ny * r };
  };
  return sweepOutline(spine, { offset, cap: 'round', join: 'round', maxWidth: maxDiameter })
    .map((ring) => ({ anchors: fitRing(ring.pts, 0.04), closed: true }))
    .filter((sp) => sp.anchors.length > 2);
}

/**
 * Trace a round stroke of varying width through `pts` ([{ x, y }] in canvas
 * pixels) with the radius radii[i] at each point, as one path to fill: a
 * disc at every point and a band between neighbors, all wound the same way
 * so a nonzero fill has no holes where they overlap. With `joined`, the
 * first point's disc is left out (it was drawn with the points before).
 */
export function traceRoundStroke(ctx, pts, radii, joined = false) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const r = Math.max(0.5, radii[i]);
    if (i || !joined) {
      ctx.moveTo(p.x + r, p.y);
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    if (!i) continue;
    const q = pts[i - 1];
    const rq = Math.max(0.5, radii[i - 1]);
    const dx = p.x - q.x;
    const dy = p.y - q.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) continue;
    const nx = dy / len;
    const ny = -dx / len;
    ctx.moveTo(q.x + nx * rq, q.y + ny * rq);
    ctx.lineTo(p.x + nx * r, p.y + ny * r);
    ctx.lineTo(p.x - nx * r, p.y - ny * r);
    ctx.lineTo(q.x - nx * rq, q.y - ny * rq);
    ctx.closePath();
  }
}

/**
 * The preview of a round stroke of varying width that grows while it is
 * drawn. Filling the whole stroke as one path every frame takes longer the
 * longer the stroke gets, far more than in proportion (a pen sends hundreds
 * of points a second), so the part whose radii are settled is kept as
 * pixels and only the points added since are traced. The kept pixels are
 * dropped when the view, the canvas, the color or the size changes.
 *
 * `settled` is how many leading points keep their radius from now on (radii
 * smoothed over neighbors change near the end until more points come).
 */
const BATCH = 64;

export class GrowingStrokePreview {
  constructor() {
    this.kept = null;
    this.layers = null;
  }

  /** The stroke ended: let go of the kept pixels. */
  reset() {
    this.kept = null;
    this.layers = null;
  }

  /** Draw `pts` (canvas pixels, in ctx's transform) with `radii`, filled with `color` at `alpha`. */
  draw(ctx, pts, radii, { color, alpha = 1, settled = pts.length, key = '' }) {
    const canvas = ctx.canvas;
    const t = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    const w = canvas?.width || 0;
    const h = canvas?.height || 0;
    const keep = t && w > 0 && h > 0 && pts.length ? this.#layer('keep', w, h) : null;
    // See-through strokes are put together on a layer of their own, so where parts overlap they do not darken.
    const frame = keep && alpha < 1 ? this.#layer('frame', w, h) : null;
    if (!keep || (alpha < 1 && !frame)) {
      // Nothing to keep pixels in: trace it all.
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.fillStyle = color;
      traceRoundStroke(ctx, pts, radii);
      ctx.fill();
      ctx.restore();
      return;
    }
    const k = [w, h, t.a, t.b, t.c, t.d, t.e, t.f, color, key, pts[0].x, pts[0].y].join(',');
    let kept = this.kept;
    if (!kept || kept.key !== k || kept.count > pts.length) {
      kept = this.kept = { key: k, count: 0 };
      keep.ctx.setTransform(1, 0, 0, 1, 0, 0);
      keep.ctx.clearRect(0, 0, w, h);
    }
    const upto = Math.max(0, Math.min(settled, pts.length));
    // Points are kept in batches: each join between kept parts can differ from one fill by a
    // shade at the edge, and a short rest costs little to trace again.
    if (upto - kept.count >= BATCH) {
      // Settled points join the kept pixels (from the last kept point, so the band between them is included).
      const from = Math.max(0, kept.count - 1);
      fillRound(keep.ctx, t, color, pts.slice(from, upto), radii.slice(from, upto), from > 0);
      kept.count = upto;
    }
    const from = Math.max(0, kept.count - 1);
    const target = frame ? frame.ctx : ctx;
    target.save();
    if (frame) {
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.clearRect(0, 0, w, h);
    }
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.drawImage(keep.canvas, 0, 0);
    if (pts.length > from) fillRound(target, t, color, pts.slice(from), radii.slice(from), kept.count > 0);
    target.restore();
    if (frame) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha *= alpha;
      ctx.drawImage(frame.canvas, 0, 0);
      ctx.restore();
    }
  }

  #layer(name, w, h) {
    const layers = (this.layers ||= {});
    let l = layers[name];
    if (l && l.canvas.width === w && l.canvas.height === h) return l;
    try {
      let canvas;
      if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(w, h);
      else {
        canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
      }
      const c = canvas.getContext('2d');
      if (!c || typeof c.drawImage !== 'function' || typeof c.setTransform !== 'function') return null;
      l = layers[name] = { canvas, ctx: c };
      if (name === 'keep') this.kept = null;
      return l;
    } catch {
      return null;
    }
  }
}

function fillRound(ctx, t, color, pts, radii, joined) {
  ctx.setTransform(t);
  ctx.fillStyle = color;
  traceRoundStroke(ctx, pts, radii, joined);
  ctx.fill();
}
