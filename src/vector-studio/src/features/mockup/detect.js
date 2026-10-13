/**
 * Surface detection for mockups: find the four corners of the flat,
 * evenly colored region of a photo around a point (a card, a sign, a
 * screen, a box side), so the art can snap onto it.
 *
 * The photo is reduced to a working size and converted to OKLab. A region
 * grows from the seed through pixels that are close in color both to their
 * neighbor (gradual shading is followed) and, more loosely, to the seed
 * (the region does not leak into the background), and stops at strong
 * edges. Holes (print already on the surface) are filled, and the region's
 * convex hull is reduced to the largest quadrilateral inscribed in it. The
 * result is rejected unless that quadrilateral covers the region well.
 */
import { rgbToOklab } from '../trace/color.js';
import { resample } from '../trace/trace-runner.js';
import { orderQuad, isConvexQuad } from './perspective.js';

const WORK_MAX = 320;

/** OKLab planes of RGBA pixels, lightly blurred. */
function labPlanes(px) {
  const { width: w, height: h, data } = px;
  const n = w * h;
  const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const lab = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    // Transparent pixels read as white.
    const r = Math.round(data[i * 4] * a + 255 * (1 - a));
    const g = Math.round(data[i * 4 + 1] * a + 255 * (1 - a));
    const b = Math.round(data[i * 4 + 2] * a + 255 * (1 - a));
    rgbToOklab(r, g, b, lab);
    planes[0][i] = lab[0];
    planes[1][i] = lab[1];
    planes[2][i] = lab[2];
  }
  return planes.map((p) => boxBlur(p, w, h));
}

function boxBlur(src, w, h) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += src[yy * w + xx];
          c++;
        }
      }
      out[y * w + x] = s / c;
    }
  }
  return out;
}

/** Sobel gradient magnitude of the lightness plane. */
function edges(L, w, h) {
  const out = new Float32Array(w * h);
  const at = (x, y) => L[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      out[y * w + x] = Math.hypot(gx, gy) / 4;
    }
  }
  return out;
}

/**
 * The region around (sx, sy) in working pixels: Uint8Array mask, or null.
 * tolerance (0..1) widens what counts as the same surface.
 */
export function growRegion(px, sx, sy, { tolerance = 0.5 } = {}) {
  const { width: w, height: h } = px;
  const [L, A, B] = labPlanes(px);
  const E = edges(L, w, h);
  const t = Math.max(0.05, Math.min(1, tolerance));
  const local = 0.012 + 0.03 * t;
  const global = 0.06 + 0.22 * t;
  const edgeStop = 0.05 + 0.12 * t;
  const x0 = Math.max(0, Math.min(w - 1, Math.round(sx)));
  const y0 = Math.max(0, Math.min(h - 1, Math.round(sy)));
  // The seed color: the average of a small window, which survives texture.
  let sl = 0;
  let sa = 0;
  let sb = 0;
  let sc = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      sl += L[i];
      sa += A[i];
      sb += B[i];
      sc++;
    }
  }
  sl /= sc;
  sa /= sc;
  sb /= sc;
  const d2 = (i, l, a, b) => (L[i] - l) ** 2 + (A[i] - a) ** 2 + (B[i] - b) ** 2;
  const mask = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const start = y0 * w + x0;
  mask[start] = 1;
  queue[tail++] = start;
  const g2 = global * global;
  const l2 = local * local;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i - x) / w;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (mask[j]) continue;
      if (E[j] > edgeStop) continue;
      if (d2(j, L[i], A[i], B[i]) > l2) continue;
      if (d2(j, sl, sa, sb) > g2) continue;
      mask[j] = 1;
      queue[tail++] = j;
    }
  }
  if (tail < 16) return null;
  return fillHoles(mask, w, h);
}

/** Pixels the outside cannot reach become part of the region. */
function fillHoles(mask, w, h) {
  const out = new Uint8Array(w * h).fill(1);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const seed = (i) => {
    if (!mask[i] && out[i]) {
      out[i] = 0;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }
  return out;
}

/** Convex hull (counter-clockwise in math terms) of the region's pixel corners. */
export function regionHull(mask, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (lo < 0) lo = x;
      hi = x;
    }
    if (lo < 0) continue;
    pts.push({ x: lo, y }, { x: lo, y: y + 1 }, { x: hi + 1, y }, { x: hi + 1, y: y + 1 });
  }
  return convexHull(pts);
}

export function convexHull(points) {
  const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function polyArea(q) {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i];
    const b = q[(i + 1) % q.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/**
 * The largest quadrilateral with corners on a convex polygon's vertices:
 * start from the extremes along the four diagonals, then move each corner
 * along the hull while the area grows.
 */
export function largestQuad(hull) {
  const n = hull.length;
  if (n < 4) return null;
  const pick = (fx, fy) => {
    let best = 0;
    for (let i = 1; i < n; i++) if (hull[i].x * fx + hull[i].y * fy > hull[best].x * fx + hull[best].y * fy) best = i;
    return best;
  };
  let idx = [pick(-1, -1), pick(1, -1), pick(1, 1), pick(-1, 1)];
  if (new Set(idx).size < 4) idx = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4)];
  idx.sort((a, b) => a - b);
  const area = (ids) => polyArea(ids.map((i) => hull[i]));
  let cur = area(idx);
  for (let round = 0; round < 50; round++) {
    let improved = false;
    for (let k = 0; k < 4; k++) {
      const prev = idx[(k + 3) % 4];
      const next = idx[(k + 1) % 4];
      // Candidates strictly between the neighbors (going forward around the hull).
      for (let i = (prev + 1) % n; i !== next; i = (i + 1) % n) {
        const trial = idx.slice();
        trial[k] = i;
        const a = area(trial);
        if (a > cur + 1e-9) {
          cur = a;
          idx = trial;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return idx.map((i) => ({ x: hull[i].x, y: hull[i].y }));
}

/**
 * Detect the surface around (sx, sy) (natural pixel coordinates) in RGBA
 * pixels: { quad: [TL, TR, BR, BL] in natural pixels, coverage } or null.
 */
export function detectSurface(px, sx, sy, { tolerance = 0.5 } = {}) {
  const k = Math.min(1, WORK_MAX / Math.max(px.width, px.height));
  const w = Math.max(1, Math.round(px.width * k));
  const h = Math.max(1, Math.round(px.height * k));
  const work = k < 1 ? resample(px, w, h) : px;
  const mask = growRegion(work, sx * k, sy * k, { tolerance });
  if (!mask) return null;
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  const total = w * h;
  if (count < total * 0.004 || count > total * 0.97) return null;
  const hull = regionHull(mask, w, h);
  const q = largestQuad(hull);
  if (!q) return null;
  const qa = polyArea(q);
  const coverage = Math.min(qa, count) / Math.max(qa, count);
  if (coverage < 0.8) return null;
  const quad = orderQuad(q.map((p) => ({ x: p.x / k, y: p.y / k })));
  if (!isConvexQuad(quad)) return null;
  return { quad, coverage };
}
