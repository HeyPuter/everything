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
 * so a nonzero fill has no holes where they overlap.
 */
export function traceRoundStroke(ctx, pts, radii) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const r = Math.max(0.5, radii[i]);
    ctx.moveTo(p.x + r, p.y);
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
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
