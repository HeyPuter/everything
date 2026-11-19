import { describe, expect, it } from 'vitest';
import { autoEdgeRadius, contourBand, enhanceEdge } from '../src/imaging/segment/enhance-edge';
import { refineEdge } from '../src/imaging/segment/refine';
import type { Mask8, RGBA8 } from '../src/imaging/types';

// A head of "hair": a disk with thin strands radiating out of it, in a
// foreground color composited over a background color with the true coverage
// (plus a little deterministic noise). The rough mask is the disk alone.
function hairScene(size = 160, fg = [225, 150, 70], bg = [40, 90, 170]) {
  const w = size,
    h = size,
    n = w * h;
  const alpha = new Float32Array(n);
  const cx = w / 2,
    cy = h / 2,
    R = size * 0.28;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      alpha[y * w + x] = Math.min(1, Math.max(0, R + 0.5 - d));
    }
  // Strands: 1.2 px wide lines from the rim outward, fading with length.
  for (let k = 0; k < 36; k++) {
    const ang = (k / 36) * Math.PI * 2 + 0.05 * Math.sin(k * 7);
    const len = 8 + (k % 5) * 3;
    for (let t = 0; t < len; t += 0.25) {
      const px = cx + Math.cos(ang) * (R + t),
        py = cy + Math.sin(ang) * (R + t);
      const strength = 0.85 * (1 - t / (len + 4));
      for (let y = Math.floor(py - 2); y <= Math.ceil(py + 2); y++)
        for (let x = Math.floor(px - 2); x <= Math.ceil(px + 2); x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const d = Math.hypot(x + 0.5 - px, y + 0.5 - py);
          const c = Math.max(0, 1 - Math.max(0, d - 0.1) / 0.7) * strength;
          const i = y * w + x;
          alpha[i] = Math.max(alpha[i], c);
        }
    }
  }
  const img: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(n * 4) };
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 6;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++)
      img.data[i * 4 + c] = Math.round(alpha[i] * fg[c] + (1 - alpha[i]) * bg[c] + noise());
  for (let i = 0; i < n; i++) img.data[i * 4 + 3] = 255;
  const rough: Mask8 = { width: w, height: h, data: new Uint8Array(n) };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      rough.data[y * w + x] = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= R ? 255 : 0;
  return { img, alpha, rough, w, h };
}
/** Mean absolute coverage error over the pixels within `band` of the rim. */
function error(m: Mask8, alpha: Float32Array, band: Float32Array) {
  let sum = 0,
    count = 0;
  for (let i = 0; i < alpha.length; i++)
    if (band[i] > 0) {
      sum += Math.abs(m.data[i] / 255 - alpha[i]);
      count++;
    }
  return sum / count;
}

describe('Enhance Edge', () => {
  it('recovers hair strands a rough mask left out', () => {
    const { img, alpha, rough } = hairScene();
    const band = contourBand(rough, 14)!;
    const res = enhanceEdge(img, rough, { radius: 12 });
    const before = error(rough, alpha, band);
    const after = error(res.mask, alpha, band);
    expect(after).toBeLessThan(before * 0.6);
    // Better than the plain color-line matting it starts from.
    expect(after).toBeLessThan(error(refineEdge(img, rough, { radius: 12 }).mask, alpha, band));
  });

  it('keeps a hard straight edge crisp and leaves pixels away from the edge alone', () => {
    const w = 80,
      h = 40;
    const img: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    const mask: Mask8 = { width: w, height: h, data: new Uint8Array(w * h) };
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          on = x < 40;
        img.data.set(on ? [230, 230, 230, 255] : [20, 20, 20, 255], i * 4);
        // The rough mask is a few pixels off the real edge.
        mask.data[i] = x < 37 ? 255 : 0;
      }
    const res = enhanceEdge(img, mask, { radius: 8 });
    const row = Array.from(res.mask.data.subarray(20 * w, 21 * w));
    // The edge moved to the image edge and stays one pixel wide.
    expect(row[38]).toBe(255);
    expect(row[39]).toBeGreaterThan(200);
    expect(row[40]).toBeLessThan(55);
    expect(row[42]).toBe(0);
    // Far from the contour nothing changes, exactly.
    expect(row[5]).toBe(255);
    expect(row[75]).toBe(0);
  });

  it('chooses the band from the canvas size and the softness of the edge', () => {
    const { rough } = hairScene(100);
    expect(autoEdgeRadius(rough)).toBe(4);
    expect(autoEdgeRadius(rough, { width: 1000, height: 1000 })).toBe(10);
    expect(autoEdgeRadius(rough, { width: 6000, height: 4000 })).toBe(20);
    // A mask with a 10 px soft edge gets a band at least that wide.
    const soft: Mask8 = { width: 100, height: 20, data: new Uint8Array(2000) };
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 100; x++)
        soft.data[y * 100 + x] = Math.max(0, Math.min(255, Math.round(((55 - x) / 10) * 255)));
    expect(autoEdgeRadius(soft)).toBeGreaterThanOrEqual(13);
  });

  it('returns a uniform mask unchanged', () => {
    const img: RGBA8 = { width: 10, height: 10, data: new Uint8ClampedArray(400).fill(128) };
    const m: Mask8 = { width: 10, height: 10, data: new Uint8Array(100).fill(255) };
    expect(Array.from(enhanceEdge(img, m).mask.data)).toEqual(Array.from(m.data));
  });
});
