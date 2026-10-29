import { describe, expect, it } from 'vitest';
import {
  createHistory,
  floodFillAt,
  linePoints,
  parseHex,
  sameColor,
  TOOLS,
} from '../src/engine/drawing.js';

describe('paint drawing engine', () => {
  it('parses hex colors', () => {
    expect(parseHex('#ff0000')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseHex('#0f0')).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it('lists tools', () => {
    expect(TOOLS).toContain('pencil');
    expect(TOOLS).toContain('fill');
  });

  it('bresenham includes endpoints', () => {
    const pts = linePoints(0, 0, 3, 0);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([3, 0]);
    expect(pts.length).toBe(4);
  });

  it('flood fills a region', () => {
    const w = 8;
    const h = 8;
    const data = new Uint8ClampedArray(w * h * 4);
    // white background
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
    const image = { width: w, height: h, data };
    const painted = floodFillAt(image, 2, 2, { r: 0, g: 0, b: 255, a: 255 });
    expect(painted).toBe(64);
    expect(sameColor({ r: data[0], g: data[1], b: data[2] }, { r: 0, g: 0, b: 255 })).toBe(true);
  });

  it('undo history pops snapshots', () => {
    const h = createHistory(2);
    const snap = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    h.push(snap);
    h.push(snap);
    h.push(snap);
    expect(h.size).toBe(2);
    expect(h.pop()).toBeTruthy();
  });
});
