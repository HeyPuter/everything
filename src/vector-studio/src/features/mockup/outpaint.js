/**
 * Extending an image past its edges.
 *
 * localFill() works on this device. The new margins start as a mirror of
 * the image across its edges (continuous at the seam), then a patch search
 * replaces the mirrored content with patches of the image that fit their
 * surroundings (PatchMatch: random search and propagation of good matches
 * between neighbors, a few passes in alternating scan order), which breaks
 * up the obvious mirror symmetry and continues textures. The search runs
 * at a reduced working size; its result (where each new pixel copies from)
 * is then applied at full resolution, so the copied texture stays sharp.
 * The original pixels are never changed.
 *
 * composeExpansion() builds the padded canvas and mask an AI image editor
 * is given, and blendExpansion() keeps only the generated margins of its
 * answer (with a short blend into the margin edge).
 */
import { resample } from '../trace/trace-runner.js';

const WORK_MAX = 256;
const R = 2; // patch radius (5 x 5 patches)

/** Clamp margins { left, top, right, bottom } to whole non-negative pixels. */
export function cleanMargins(by) {
  const c = (v) => Math.max(0, Math.round(Number(v) || 0));
  return { left: c(by.left), top: c(by.top), right: c(by.right), bottom: c(by.bottom) };
}

/** Reflect coordinate v into [lo, hi) (mirror without repeating the edge pixel), for any distance. */
export function reflect(v, lo, hi) {
  const n = hi - lo;
  if (n <= 1) return lo;
  const period = 2 * (n - 1);
  let t = (v - lo) % period;
  if (t < 0) t += period;
  return lo + (t < n ? t : period - t);
}

/** The image on a larger canvas with every margin a mirror of the image. */
export function mirrorPad(px, by) {
  const m = cleanMargins(by);
  const W = px.width + m.left + m.right;
  const H = px.height + m.top + m.bottom;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = reflect(y - m.top, 0, px.height);
    for (let x = 0; x < W; x++) {
      const sx = reflect(x - m.left, 0, px.width);
      const s = (sy * px.width + sx) * 4;
      const o = (y * W + x) * 4;
      out[o] = px.data[s];
      out[o + 1] = px.data[s + 1];
      out[o + 2] = px.data[s + 2];
      out[o + 3] = px.data[s + 3];
    }
  }
  return { width: W, height: H, data: out };
}

/** Small deterministic random generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Patch search over a padded working image (RGBA bytes, changed in place):
 * for every pixel outside the known rectangle k = { x, y, w, h }, the
 * center of the known patch that best fits around it. Returns an
 * Int32Array of source indices (-1 inside), or null when the known area
 * is too small for patches or the search was cancelled.
 */
export function patchSearch(img, W, H, k, { iterations = 4, seed = 7, signal = null, onProgress = null } = {}) {
  const nnf = new Int32Array(W * H).fill(-1);
  // Valid source centers: the known rectangle inset by the patch radius.
  const x0 = k.x + R;
  const y0 = k.y + R;
  const x1 = k.x + k.w - R - 1;
  const y1 = k.y + k.h - R - 1;
  if (x1 < x0 || y1 < y0) return null;
  const known = (x, y) => x >= k.x && y >= k.y && x < k.x + k.w && y < k.y + k.h;
  const clampSrc = (x, y) => Math.max(y0, Math.min(y1, y)) * W + Math.max(x0, Math.min(x1, x));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (known(x, y)) continue;
      nnf[y * W + x] = clampSrc(reflect(x, k.x, k.x + k.w), reflect(y, k.y, k.y + k.h));
    }
  }
  const random = rng(seed);
  const cost = (px, py, q, best) => {
    const qx = q % W;
    const qy = (q - qx) / W;
    let s = 0;
    for (let dy = -R; dy <= R; dy++) {
      const yy = py + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -R; dx <= R; dx++) {
        const xx = px + dx;
        if (xx < 0 || xx >= W) continue;
        const a = (yy * W + xx) * 4;
        const b = ((qy + dy) * W + qx + dx) * 4;
        const d0 = img[a] - img[b];
        const d1 = img[a + 1] - img[b + 1];
        const d2 = img[a + 2] - img[b + 2];
        const d3 = img[a + 3] - img[b + 3];
        s += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
        if (s >= best) return s;
      }
    }
    return s;
  };
  const copy = (p, q) => {
    const a = p * 4;
    const b = q * 4;
    img[a] = img[b];
    img[a + 1] = img[b + 1];
    img[a + 2] = img[b + 2];
    img[a + 3] = img[b + 3];
  };
  const maxR = Math.max(k.w, k.h);
  for (let it = 0; it < iterations; it++) {
    if (signal?.aborted) return null;
    const fwd = it % 2 === 0;
    const step = fwd ? 1 : -1;
    for (let yy = 0; yy < H; yy++) {
      const y = fwd ? yy : H - 1 - yy;
      for (let xx = 0; xx < W; xx++) {
        const x = fwd ? xx : W - 1 - xx;
        const p = y * W + x;
        let q = nnf[p];
        if (q < 0) continue;
        let best = cost(x, y, q, Infinity);
        // Propagation: the neighbor's match, shifted by one.
        for (const [nx, ny] of [
          [x - step, y],
          [x, y - step],
        ]) {
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nq = nnf[ny * W + nx];
          if (nq < 0) continue;
          const cx = (nq % W) + (x - nx);
          const cy = Math.floor(nq / W) + (y - ny);
          if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
          const c = cy * W + cx;
          const s = cost(x, y, c, best);
          if (s < best) {
            best = s;
            q = c;
          }
        }
        // Random search around the current match, at shrinking radii.
        const qx = q % W;
        const qy = (q - qx) / W;
        for (let r = maxR; r >= 1; r = Math.floor(r / 2)) {
          const c = clampSrc(Math.round(qx + (random() * 2 - 1) * r), Math.round(qy + (random() * 2 - 1) * r));
          const s = cost(x, y, c, best);
          if (s < best) {
            best = s;
            q = c;
          }
        }
        nnf[p] = q;
        copy(p, q);
      }
    }
    onProgress?.((it + 1) / iterations);
  }
  return nnf;
}

/**
 * Extend RGBA pixels by margins (pixels) on this device. Resolves to the
 * larger image (the original pixels sit unchanged at left, top), or null
 * when cancelled.
 */
export async function localFill(px, by, { signal = null, onProgress = null, seed = 7 } = {}) {
  const m = cleanMargins(by);
  const W = px.width + m.left + m.right;
  const H = px.height + m.top + m.bottom;
  const out = mirrorPad(px, m);
  if (W === px.width && H === px.height) return out;
  // The patch search at a working size.
  const k = Math.min(1, WORK_MAX / Math.max(W, H));
  const lw = Math.max(1, Math.round(W * k));
  const lh = Math.max(1, Math.round(H * k));
  const known = { x: Math.round(m.left * k), y: Math.round(m.top * k), w: Math.max(1, Math.round(px.width * k)), h: Math.max(1, Math.round(px.height * k)) };
  known.w = Math.max(1, Math.min(known.w, lw - known.x));
  known.h = Math.max(1, Math.min(known.h, lh - known.y));
  const small = known.w !== px.width || known.h !== px.height ? resample(px, known.w, known.h) : px;
  const work = mirrorPad(small, { left: known.x, top: known.y, right: lw - known.x - known.w, bottom: lh - known.y - known.h });
  // Give the UI a turn before the search.
  await new Promise((r) => setTimeout(r, 0));
  const nnf = patchSearch(work.data, lw, lh, known, { signal, onProgress, seed });
  if (signal?.aborted) return null;
  if (!nnf) return out;
  // Apply the matches at full resolution: each new pixel copies the pixel
  // at the same offset from its match's center in the original.
  const inv = 1 / k;
  const fx = px.width / known.w;
  const fy = px.height / known.h;
  for (let y = 0; y < H; y++) {
    const inY = y >= m.top && y < m.top + px.height;
    const ly = Math.min(lh - 1, Math.floor(y * k));
    for (let x = 0; x < W; x++) {
      if (inY && x >= m.left && x < m.left + px.width) continue;
      const lx = Math.min(lw - 1, Math.floor(x * k));
      const q = nnf[ly * lw + lx];
      if (q < 0) continue;
      const qx = q % lw;
      const qy = (q - qx) / lw;
      const ox = x + 0.5 - (lx + 0.5) * inv;
      const oy = y + 0.5 - (ly + 0.5) * inv;
      const sx = Math.max(0, Math.min(px.width - 1, Math.floor((qx - known.x + 0.5) * fx + ox)));
      const sy = Math.max(0, Math.min(px.height - 1, Math.floor((qy - known.y + 0.5) * fy + oy)));
      const s = (sy * px.width + sx) * 4;
      const o = (y * W + x) * 4;
      out.data[o] = px.data[s];
      out.data[o + 1] = px.data[s + 1];
      out.data[o + 2] = px.data[s + 2];
      out.data[o + 3] = px.data[s + 3];
    }
  }
  return out;
}

/**
 * The padded canvas and its mask for an AI editor: { image, mask } (RGBA),
 * the margins neutral gray in the image and white in the mask.
 */
export function composeExpansion(px, by) {
  const m = cleanMargins(by);
  const W = px.width + m.left + m.right;
  const H = px.height + m.top + m.bottom;
  const image = new Uint8ClampedArray(W * H * 4);
  const mask = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const ix = x - m.left;
      const iy = y - m.top;
      if (ix >= 0 && iy >= 0 && ix < px.width && iy < px.height) {
        const s = (iy * px.width + ix) * 4;
        image.set(px.data.subarray(s, s + 4), o);
        mask.set([0, 0, 0, 255], o);
      } else {
        image.set([128, 128, 128, 255], o);
        mask.set([255, 255, 255, 255], o);
      }
    }
  }
  return { image: { width: W, height: H, data: image }, mask: { width: W, height: H, data: mask } };
}

/**
 * A generated picture (any size; resampled to the padded size) blended
 * into `base` (the padded image, e.g. a local fill): the margins take the
 * generated pixels, fading in over `band` pixels from the seam; the
 * original stays exactly as it was.
 */
export function blendExpansion(base, gen, px, by, { band = null } = {}) {
  const m = cleanMargins(by);
  const W = base.width;
  const H = base.height;
  const g = gen.width === W && gen.height === H ? gen : resample(gen, W, H);
  const out = new Uint8ClampedArray(base.data);
  const b = band ?? Math.max(2, Math.round(Math.min(px.width, px.height) * 0.02));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ix = x - m.left;
      const iy = y - m.top;
      if (ix >= 0 && iy >= 0 && ix < px.width && iy < px.height) continue;
      const dx = ix < 0 ? -ix : ix >= px.width ? ix - px.width + 1 : 0;
      const dy = iy < 0 ? -iy : iy >= px.height ? iy - px.height + 1 : 0;
      const t = Math.min(1, Math.max(dx, dy) / b);
      const o = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(base.data[o + c] * (1 - t) + g.data[o + c] * t);
    }
  }
  return { width: W, height: H, data: out };
}
