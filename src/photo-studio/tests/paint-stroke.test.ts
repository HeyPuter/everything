import { describe, it, expect } from 'vitest';
import { TileStore, emptyGrid, gridFromImage, readRGBA } from '../src/model/tiles';
import { StrokeSession } from '../src/engine/paint';
import { SmudgeFinger, smudgeSpacing } from '../src/engine/smudge';

const solid = (w: number, h: number, rgba: number[]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data };
};
const tip = { size: 20, hardness: 1, spacing: 0.25, roundness: 1, angle: 0 };

describe('stroke sessions on locked transparency', () => {
  it('Behind and Clear leave a layer with locked transparency unchanged', () => {
    for (const mode of ['behind', 'clear'] as const) {
      const store = new TileStore();
      const base = gridFromImage(store, solid(60, 60, [0, 255, 0, 255]));
      const s = new StrokeSession(store, base, { tip, opacity: 1, flow: 1, target: { kind: 'color', rgb: [255, 0, 0], mode, preserveAlpha: true } });
      s.addPoint(30, 30);
      expect([...readRGBA(store, s.commit(), { x: 30, y: 30, width: 1, height: 1 }).data], mode).toEqual([0, 255, 0, 255]);
    }
  });
});

describe('airbrush build-up', () => {
  it('adds paint where the stroke rests, at its last pressure', () => {
    const store = new TileStore();
    const s = new StrokeSession(store, emptyGrid(4), { tip, dynamics: { pressureSize: true }, opacity: 1, flow: 0.1, target: { kind: 'color', rgb: [0, 0, 0], mode: 'normal' } });
    s.addPoint(30, 30, 0.5);
    const alpha = (x: number) => readRGBA(store, s.grid, { x, y: 30, width: 1, height: 1 }).data[3];
    const once = alpha(30);
    for (let i = 0; i < 10; i++) s.hold();
    expect(alpha(30)).toBeGreaterThan(once * 5);
    // At half pressure the tip is 10 px wide: nothing reaches 7 px away.
    expect(alpha(37)).toBe(0);
  });
});

describe('smudge', () => {
  // Red on the left (x < 50), white on the right; smudge from x = 40 to 120.
  const smudge = (strength: number, spacing: number) => {
    const store = new TileStore();
    const data = new Uint8ClampedArray(160 * 40 * 4);
    for (let i = 0; i < data.length; i += 4) data.set((i / 4) % 160 < 50 ? [220, 30, 30, 255] : [255, 255, 255, 255], i);
    const finger = new SmudgeFinger(20, strength);
    const s = new StrokeSession(store, gridFromImage(store, { width: 160, height: 40, data }), {
      tip: { size: 20, hardness: 1, spacing, roundness: 1, angle: 0 },
      opacity: 1,
      flow: 1,
      target: { kind: 'custom', dab: (cx, cy, size) => finger.dab(cx, cy, size), pixel: (x, y, a, cur, out) => finger.pixel(x, y, a, cur, out) },
    });
    for (let x = 40; x <= 120; x += 4) s.addPoint(x, 20);
    const row = readRGBA(store, s.commit(), { x: 0, y: 20, width: 160, height: 1 }).data;
    return (x: number) => row[x * 4 + 1];
  };
  it('drags the starting color the whole stroke at full strength', () => {
    const g = smudge(1, smudgeSpacing);
    expect(g(70)).toBe(30);
    expect(g(115)).toBe(30);
    expect(g(140)).toBe(255);
  });
  it('fades the carried color with lower strength', () => {
    const half = smudge(0.5, smudgeSpacing);
    expect(half(55)).toBeLessThan(60);
    expect(half(80)).toBeGreaterThan(half(60));
    expect(half(115)).toBeGreaterThan(240);
  });
  it('drags paint into transparent pixels with its alpha', () => {
    const store = new TileStore();
    const data = new Uint8ClampedArray(160 * 40 * 4);
    for (let i = 0; i < data.length; i += 4) if ((i / 4) % 160 < 50) data.set([0, 0, 255, 255], i);
    const finger = new SmudgeFinger(20, 1);
    const s = new StrokeSession(store, gridFromImage(store, { width: 160, height: 40, data }), {
      tip,
      opacity: 1,
      flow: 1,
      target: { kind: 'custom', dab: (cx, cy, size) => finger.dab(cx, cy, size), pixel: (x, y, a, cur, out) => finger.pixel(x, y, a, cur, out) },
    });
    for (let x = 40; x <= 100; x += 2) s.addPoint(x, 20);
    expect([...readRGBA(store, s.commit(), { x: 90, y: 20, width: 1, height: 1 }).data]).toEqual([0, 0, 255, 255]);
  });
});

describe('live reads for custom targets', () => {
  it('see the paint earlier dabs of the stroke left', () => {
    const store = new TileStore();
    const seen: number[] = [];
    let n = 0;
    const s = new StrokeSession(store, emptyGrid(4), {
      tip: { size: 10, hardness: 1, spacing: 0.25, roundness: 1, angle: 0 },
      opacity: 1,
      flow: 1,
      target: {
        kind: 'custom',
        dab: (_cx, _cy, _size, read) => {
          // The second dab reads the pixel the first one painted, across a tile edge.
          if (n++ === 1) {
            const px = new Uint8ClampedArray(4);
            read(255, 20, px);
            seen.push(...px);
          }
        },
        pixel: (_x, _y, _a, _cur, out) => out.set([255, 0, 0, 255]),
      },
    });
    s.addPoint(255, 20);
    s.addPoint(262, 20);
    expect(seen).toEqual([255, 0, 0, 255]);
  });
});
