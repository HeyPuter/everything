import { describe, it, expect } from 'vitest';
import { removeBackground, applyMask, ARTISTIC_EFFECTS, adjustSaturation, adjustTemperature, sharpenSoften, downsample, cropPixels } from '../src/engine/picture-processing.js';

/** A picture from a function of (x, y) → [r, g, b, a?]. */
function picture(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b, a = 255] = fn(x, y), i = (y * width + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return { data, width, height };
}
/** Deterministic noise for a near-white background. */
const noise = (x, y) => ((x * 73856093) ^ (y * 19349663)) % 9 - 4;
// A red disc (radius 25) on a noisy off-white background, 120 × 100.
const disc = picture(120, 100, (x, y) => Math.hypot(x - 60, y - 50) < 25 ? [210, 30, 40] : [246 + noise(x, y), 244 + noise(y, x), 240 + noise(x, x + y)]);
const alphaAt = (mask, width, x, y) => mask[y * width + x];

describe('background removal', () => {
  it('removes a plain background and keeps the subject', () => {
    const { mask, region } = removeBackground(disc);
    expect(region).toEqual({ left: 0.08, top: 0.08, right: 0.92, bottom: 0.92 });
    expect(mask).toHaveLength(120 * 100);
    expect(alphaAt(mask, 120, 60, 50)).toBe(255);
    expect(alphaAt(mask, 120, 70, 45)).toBe(255);
    for (const [x, y] of [[2, 2], [110, 90], [60, 15], [20, 50]]) expect(alphaAt(mask, 120, x, y)).toBe(0);
    // The boundary is feathered: some intermediate alpha exists.
    expect([...mask].some(v => v > 0 && v < 255)).toBe(true);
    const cut = applyMask(disc, mask);
    expect(cut.data[(50 * 120 + 60) * 4 + 3]).toBe(255);
    expect(cut.data[3]).toBe(0);
    expect(disc.data[3]).toBe(255); // input unchanged
  });

  it('follows keep and remove marks', () => {
    // A light-gray square that resembles the background: removed until marked to keep.
    const scene = picture(120, 100, (x, y) => x > 70 && x < 95 && y > 30 && y < 70 ? [232, 232, 230] : Math.hypot(x - 40, y - 50) < 18 ? [20, 60, 200] : [246 + noise(x, y), 245, 242]);
    const plain = removeBackground(scene, { sensitivity: 0.7 }).mask;
    expect(alphaAt(plain, 120, 82, 50)).toBe(0);
    const kept = removeBackground(scene, { sensitivity: 0.7, keep: [{ points: [[0.68, 0.5]], radius: 0.03 }] }).mask;
    expect(alphaAt(kept, 120, 82, 50)).toBe(255);
    expect(alphaAt(kept, 120, 90, 35)).toBe(255); // grown through similar colour
    const removed = removeBackground(scene, { remove: [{ points: [[0.3, 0.5], [0.36, 0.5]], radius: 0.03 }] }).mask;
    expect(alphaAt(plain, 120, 40, 50)).toBe(255);
    expect(alphaAt(removed, 120, 40, 50)).toBe(0);
  });

  it('honours a moved subject area and is deterministic', () => {
    const a = removeBackground(disc, { region: { left: 0, top: 0, right: 1, bottom: 1 } }).mask;
    const b = removeBackground(disc, { region: { left: 0, top: 0, right: 1, bottom: 1 } }).mask;
    expect(a).toEqual(b);
    expect(alphaAt(a, 120, 60, 50)).toBe(255);
    expect(alphaAt(a, 120, 5, 5)).toBe(0);
  });

  it('handles a large picture in reasonable time', () => {
    const big = picture(1200, 1000, (x, y) => Math.hypot(x - 600, y - 500) < 300 ? [30, 120, 60] : [250, 250, 250]);
    const start = performance.now();
    const { mask } = removeBackground(big);
    expect(performance.now() - start).toBeLessThan(15000);
    expect(alphaAt(mask, 1200, 600, 500)).toBe(255);
    expect(alphaAt(mask, 1200, 10, 10)).toBe(0);
  });
});

describe('artistic effects', () => {
  const photo = picture(64, 48, (x, y) => [x * 4 % 256, y * 5 % 256, (x * y) % 256]);
  it('every effect keeps the size, changes pixels and is deterministic', () => {
    expect(ARTISTIC_EFFECTS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ARTISTIC_EFFECTS.map(e => e.id)).size).toBe(ARTISTIC_EFFECTS.length);
    for (const effect of ARTISTIC_EFFECTS) {
      const a = effect.apply(photo, 0.5), b = effect.apply(photo, 0.5);
      expect([a.width, a.height], effect.id).toEqual([64, 48]);
      expect(a.data, effect.id).toEqual(b.data);
      expect(a.data, effect.id).not.toEqual(photo.data);
      expect(effect.a14, effect.id).toMatch(/^artistic[A-Z]/);
      // Alpha is untouched.
      expect(a.data.filter((_, i) => i % 4 === 3).every(v => v === 255), effect.id).toBe(true);
    }
  });
  it('grayscale effects produce gray pixels', () => {
    for (const id of ['pencilGray', 'lineDrawing', 'photocopy']) {
      const out = ARTISTIC_EFFECTS.find(e => e.id === id).apply(photo, 0.5).data;
      for (let i = 0; i < out.length; i += 4) expect(out[i] === out[i + 1] && out[i + 1] === out[i + 2], id).toBe(true);
    }
  });
});

describe('colour adjustments', () => {
  const swatch = picture(4, 4, () => [200, 120, 60]);
  it('saturation 0 is gray and 1 is unchanged', () => {
    const gray = adjustSaturation(swatch, 0).data;
    expect(gray[0]).toBe(gray[1]); expect(gray[1]).toBe(gray[2]);
    expect(adjustSaturation(swatch, 1).data).toEqual(swatch.data);
    const vivid = adjustSaturation(swatch, 2).data;
    expect(vivid[0] - vivid[2]).toBeGreaterThan(200 - 60);
  });
  it('lower temperatures warm the picture', () => {
    const neutral = picture(2, 2, () => [128, 128, 128]);
    const warm = adjustTemperature(neutral, 3500).data, cool = adjustTemperature(neutral, 9500).data;
    expect(warm[0] / warm[2]).toBeGreaterThan(1.1);
    expect(cool[0] / cool[2]).toBeLessThan(0.9);
    expect(adjustTemperature(neutral, 6500).data).toEqual(neutral.data);
  });
  it('sharpens and softens', () => {
    const edge = picture(20, 4, x => x < 10 ? [60, 60, 60] : [180, 180, 180]);
    expect(sharpenSoften(edge, 0).data).toEqual(edge.data);
    const sharp = sharpenSoften(edge, 1).data, soft = sharpenSoften(edge, -1).data;
    expect(sharp[9 * 4]).toBeLessThan(60); expect(sharp[10 * 4]).toBeGreaterThan(180);
    expect(soft[9 * 4]).toBeGreaterThan(60); expect(soft[10 * 4]).toBeLessThan(180);
  });
});

describe('resampling', () => {
  it('downsamples by averaging areas', () => {
    const checker = picture(4, 4, (x, y) => (x + y) % 2 ? [255, 255, 255] : [0, 0, 0]);
    const half = downsample(checker, 0.5);
    expect([half.width, half.height]).toEqual([2, 2]);
    for (let i = 0; i < half.data.length; i += 4) expect(half.data[i]).toBeCloseTo(128, -1);
    expect(downsample(checker, 1).data).toEqual(checker.data);
    // Transparent pixels do not darken their neighbours.
    const edge = picture(2, 1, x => x ? [255, 0, 0, 255] : [0, 0, 0, 0]);
    const one = downsample(edge, 0.5).data;
    expect([one[0], one[3]]).toEqual([255, 128]);
  });
  it('crops to the visible part', () => {
    const image = picture(100, 50, x => [x, 0, 0]);
    const cropped = cropPixels(image, { left: 0.1, right: 0.2, top: 0.2, bottom: -0.1 });
    expect([cropped.width, cropped.height]).toEqual([70, 40]);
    expect(cropped.data[0]).toBe(10);
    expect(() => cropPixels(image, { left: 0.6, right: 0.5 })).toThrow();
  });
});
