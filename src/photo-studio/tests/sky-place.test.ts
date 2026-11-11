import { describe, expect, it } from 'vitest';
import { placeSky } from '../src/imaging/sky/sky';
import { rgba8 } from '../src/imaging/types';

describe('placeSky', () => {
  const at = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
  it('stretches one-pixel-wide, one-pixel-tall and 1x1 sky images', () => {
    const p = { scale: 1, flip: false, offsetX: 0, offsetY: 0 };
    // A vertical gradient strip, a horizontal one and a single color.
    const strip = rgba8(1, 4);
    for (let y = 0; y < 4; y++) strip.data.set([40 * y, 100, 200, 255], y * 4);
    const out = placeSky(strip, 30, 20, p);
    for (const [x, y] of [[0, 0], [29, 19], [15, 10]]) {
      const v = at(out, x, y);
      expect(v[1]).toBe(100);
      expect(v[2]).toBe(200);
    }
    expect(at(out, 15, 0)[0]).toBeLessThan(at(out, 15, 19)[0]);
    const row = rgba8(4, 1);
    for (let x = 0; x < 4; x++) row.data.set([10, 60 * x, 30, 255], x * 4);
    const out2 = placeSky(row, 30, 20, p);
    for (const [x, y] of [[0, 0], [29, 19], [15, 10]]) expect(at(out2, x, y)[0]).toBe(10), expect(at(out2, x, y)[2]).toBe(30);
    expect(at(out2, 0, 19)[1]).toBeLessThan(at(out2, 29, 19)[1]);
    const dot = rgba8(1, 1, [70, 140, 210, 255]);
    for (const flip of [false, true]) {
      const out3 = placeSky(dot, 7, 5, { ...p, flip });
      for (let j = 0; j < out3.data.length; j += 4) expect(at(out3, (j / 4) % 7, Math.floor(j / 4 / 7))).toEqual([70, 140, 210, 255]);
    }
  });
});
