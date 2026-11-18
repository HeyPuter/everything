import { describe, it, expect } from 'vitest';
import {
  TileStore,
  emptyGrid,
  filledMask,
  gridFromImage,
  readRGBA,
  writeRect,
} from '../src/model/tiles';
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

describe('finger painting and square tips', () => {
  it('a smudge finger loaded with a color lays it down from the first dab', () => {
    const store = new TileStore();
    const finger = new SmudgeFinger(20, 1, [0, 255, 0]);
    const s = new StrokeSession(store, gridFromImage(store, solid(160, 40, [255, 255, 255, 255])), {
      tip,
      opacity: 1,
      flow: 1,
      target: { kind: 'custom', dab: (cx, cy, size) => finger.dab(cx, cy, size), pixel: (x, y, a, cur, out) => finger.pixel(x, y, a, cur, out) },
    });
    for (let x = 20; x <= 60; x += 1) s.addPoint(x, 20);
    const px = readRGBA(store, s.commit(), { x: 22, y: 20, width: 1, height: 1 }).data;
    expect(px[1]).toBe(255);
    expect(px[0]).toBeLessThan(40);
  });
  it('an aliased square tip covers its whole square and nothing beyond', () => {
    const store = new TileStore();
    const s = new StrokeSession(store, emptyGrid(4), { tip: { ...tip, aliased: true, square: true }, opacity: 1, flow: 1, target: { kind: 'color', rgb: [0, 0, 0], mode: 'normal' } });
    s.addPoint(30, 30);
    const grid = s.commit();
    const a = (x: number, y: number) => readRGBA(store, grid, { x, y, width: 1, height: 1 }).data[3];
    expect(a(20, 20)).toBe(255);
    expect(a(39, 39)).toBe(255);
    expect(a(19, 30)).toBe(0);
    expect(a(40, 30)).toBe(0);
  });
});

describe('stroke sessions limited by a moved selection', () => {
  it('paint follows a selection outline that was moved off the document origin', () => {
    const store = new TileStore();
    // A 40 px square at the origin, moved 50 px right and 300 px down (across a tile edge).
    const sel = { ...filledMask(store, { x: 0, y: 0, width: 40, height: 40 }), x: 50, y: 300 };
    const s = new StrokeSession(store, emptyGrid(4), {
      tip,
      opacity: 1,
      flow: 1,
      target: { kind: 'color', rgb: [255, 0, 0], mode: 'normal' },
      selection: sel,
    });
    s.addPoint(70, 320);
    s.lift();
    s.addPoint(20, 20);
    const g = s.commit();
    const alpha = (x: number, y: number) =>
      readRGBA(store, g, { x, y, width: 1, height: 1 }).data[3];
    expect(alpha(70, 320)).toBe(255);
    expect(alpha(20, 20)).toBe(0);
  });
});

describe('stroke sessions limited by a soft selection', () => {
  it('scale each pixel by its selection coverage across selection tile edges', () => {
    const store = new TileStore();
    // Coverage varies per pixel; the grid is offset so its tiles straddle the document's.
    const W = 300,
      H = 300;
    const cover = new Uint8Array(W * H);
    for (let i = 0; i < cover.length; i++) cover[i] = (i * 37) % 256;
    const mask = { width: W, height: H, data: cover };
    const sel = { ...writeRect(store, emptyGrid(1), 0, 0, mask), x: 120, y: 10 };
    const stroke = (selection: typeof sel | null) => {
      const s = new StrokeSession(store, emptyGrid(4), {
        tip: { size: 40, hardness: 0.3, spacing: 10, roundness: 1, angle: 0 },
        opacity: 1,
        flow: 1,
        target: { kind: 'color', rgb: [0, 0, 0], mode: 'normal' },
        selection,
      });
      // One dab across the document's tile edges (256) and the selection's (376, 266).
      s.addPoint(376, 261);
      return readRGBA(store, s.commit(), { x: 340, y: 225, width: 72, height: 72 }).data;
    };
    const full = stroke(null),
      limited = stroke(sel);
    for (let y = 0; y < 72; y++)
      for (let x = 0; x < 72; x++) {
        const dx = 340 + x - 120,
          dy = 225 + y - 10;
        const c = dx >= 0 && dy >= 0 && dx < W && dy < H ? cover[dy * W + dx] : 0;
        const expected = Math.round((full[(y * 72 + x) * 4 + 3] * c) / 255);
        expect(Math.abs(limited[(y * 72 + x) * 4 + 3] - expected)).toBeLessThanOrEqual(1);
      }
  });
});
