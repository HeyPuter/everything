import { describe, it, expect } from 'vitest';
import { grayscale, threshold, applyFilter, contrast } from '../src/engine/filters.js';

function solid(w, h, r, g, b) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  }
  return rgba;
}

describe('filters', () => {
  it('converts to grayscale luminance', () => {
    const out = grayscale(solid(2, 2, 255, 0, 0));
    expect(out[0]).toBe(out[1]);
    expect(out[1]).toBe(out[2]);
    expect(out[0]).toBeGreaterThan(50);
    expect(out[0]).toBeLessThan(120);
  });

  it('thresholds to pure black or white', () => {
    const dark = threshold(solid(1, 1, 20, 20, 20), 128);
    const light = threshold(solid(1, 1, 220, 220, 220), 128);
    expect(dark[0]).toBe(0);
    expect(light[0]).toBe(255);
  });

  it('routes named filters and keeps original as a copy', () => {
    const src = solid(1, 1, 10, 20, 30);
    const copy = applyFilter(src, 1, 1, 'original');
    expect(copy).not.toBe(src);
    expect([...copy.slice(0, 3)]).toEqual([10, 20, 30]);
    const bumped = contrast(src, 1.5);
    expect(bumped[0]).not.toBe(10);
  });
});
