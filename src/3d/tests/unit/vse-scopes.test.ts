import { describe, it, expect } from 'vitest';
import { histogram, waveform, vectorscope, chroma, luma } from '../../src/sequencer/scopes';

function pixels(cols: [number, number, number][]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(cols.length * 4);
  cols.forEach(([r, g, b], i) => px.set([r, g, b, 255], i * 4));
  return px;
}

describe('scopes', () => {
  it('counts channel values', () => {
    const h = histogram(pixels([[255, 0, 0], [255, 128, 0]]));
    expect(h[0][255]).toBe(2);
    expect(h[1][0]).toBe(1);
    expect(h[1][128]).toBe(1);
    expect(h[3][Math.round(luma(255, 0, 0))]).toBe(1);
  });

  it('places luma per column', () => {
    const w = waveform(pixels([[0, 0, 0], [255, 255, 255]]), 2, 1);
    expect(w[0 * 256 + 0]).toBe(1);
    expect(w[1 * 256 + 255]).toBe(1);
  });

  it('grey has no chroma; primaries sit on opposite sides', () => {
    expect(chroma(128, 128, 128).map((v) => Math.abs(v) < 1e-9)).toEqual([true, true]);
    const [ru, rv] = chroma(255, 0, 0);
    const [cu, cv] = chroma(0, 255, 255);
    expect(ru).toBeCloseTo(-cu, 6);
    expect(rv).toBeCloseTo(-cv, 6);
    expect(rv).toBeCloseTo(0.5, 2);
    const vs = vectorscope(pixels([[128, 128, 128]]), 9);
    expect(vs[4 * 9 + 4]).toBe(1);
  });
});
