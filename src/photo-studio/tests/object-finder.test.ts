import { describe, expect, it } from 'vitest';
import { highlightRGBA, objectAt } from '../src/features/retouch/object-finder';

const square = (x: number, y: number, size: number, area: number) => ({
  rect: { x, y, width: size, height: size },
  mask: { width: size, height: size, data: new Uint8Array(size * size).fill(255) },
  area,
});

describe('object highlighting', () => {
  it('finds the most specific object under a point', () => {
    const big = square(0, 0, 100, 0.5),
      small = square(20, 20, 10, 0.01),
      apart = square(200, 0, 10, 0.01);
    const list = [big, small, apart];
    expect(objectAt(list, 25, 25)).toBe(1);
    expect(objectAt(list, 50, 50)).toBe(0);
    expect(objectAt(list, 205, 5)).toBe(2);
    expect(objectAt(list, 150, 50)).toBe(-1);
  });
  it('ignores the transparent parts of an object’s bounds', () => {
    const o = square(0, 0, 4, 0.1);
    o.mask.data.fill(0);
    o.mask.data[5] = 255;
    expect(objectAt([o], 0, 0)).toBe(-1);
    expect(objectAt([o], 1.5, 1.2)).toBe(0);
  });
  it('tints the inside lightly and draws a solid edge', () => {
    const m = { width: 5, height: 5, data: new Uint8Array(25) };
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) m.data[y * 5 + x] = 255;
    const px = highlightRGBA(m, [10, 20, 30], 0.4);
    const a = (x: number, y: number) => px[(y * 5 + x) * 4 + 3];
    expect(a(0, 0)).toBe(0);
    expect(a(1, 1)).toBe(255);
    expect(a(2, 2)).toBe(102);
    expect(Array.from(px.slice((2 * 5 + 2) * 4, (2 * 5 + 2) * 4 + 3))).toEqual([10, 20, 30]);
  });
});
