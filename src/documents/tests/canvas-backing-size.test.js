import { it, expect } from 'vitest';
import { pageBackingSize, MAX_CANVAS_PIXELS } from '../src/engine/canvas-backing.js';

it('gives a page canvas the full device resolution while it is within the canvas pixel limit', () => {
  expect(pageBackingSize(816, 1056, 1)).toEqual({ width: 816, height: 1056 });
  expect(pageBackingSize(1632, 2112, 2)).toEqual({ width: 3264, height: 4224 });
  expect(pageBackingSize(1061, 1373, 1.25)).toEqual({ width: 1326, height: 1716 });
});

it('lowers the resolution of a page that would exceed the limit instead of leaving it blank', () => {
  // A Letter page at 200% on a 3x phone: 4896 × 6336 device pixels, about 31 million, while
  // Safari on iOS draws nothing in a canvas larger than 4096 × 4096 pixels.
  const size = pageBackingSize(1632, 2112, 3);
  expect(size.width * size.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
  expect(size.width * size.height).toBeGreaterThan(MAX_CANVAS_PIXELS * 0.99);
  // Both sides shrink by the same factor, so painting keeps one scale on both axes.
  expect(Math.abs(size.width / 1632 - size.height / 2112)).toBeLessThan(1 / 1632 + 1 / 2112);
  // The largest page at the highest zoom on a 3x display still fits.
  const largest = pageBackingSize(2112 * 2, 2112 * 2, 3);
  expect(largest.width * largest.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
  expect(largest.width).toBeGreaterThan(0);
});
