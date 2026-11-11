import { describe, expect, it } from 'vitest';
import {
  TILE,
  TileStore,
  allMask,
  computeBounds,
  emptyGrid,
  gridFromImage,
  packGrid,
  readMask,
  readRGBA,
  unpackGrid,
  writeRect,
} from '../src/model/tiles';
import { StrokeSession } from '../src/engine/paint';
import { commitPixelResample, commitPixelTranslation, newPixelLayer, pixelTransformKind } from '../src/model/pixel-layer';

const solid = (w: number, h: number, rgba: number[]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data };
};

describe('tile grids', () => {
  it('reads back what was written across tile boundaries and negative coordinates', () => {
    const store = new TileStore();
    const img = solid(300, 20, [10, 20, 30, 255]);
    const grid = gridFromImage(store, img, -100, 250);
    expect(Object.keys(grid.tiles).sort()).toEqual(['-1,0', '-1,1', '0,0', '0,1']);
    expect(grid.bounds).toEqual({ x: -100, y: 250, width: 300, height: 20 });
    const back = readRGBA(store, grid, { x: -100, y: 250, width: 300, height: 20 });
    expect(back.data).toEqual(img.data);
    const outside = readRGBA(store, grid, { x: 500, y: 0, width: 2, height: 2 });
    expect([...outside.data].every((v) => v === 0)).toBe(true);
  });
  it('never mutates committed tiles and drops tiles that become empty', () => {
    const store = new TileStore();
    const a = gridFromImage(store, solid(10, 10, [255, 0, 0, 255]));
    const before = new Uint8ClampedArray(store.get(a.tiles['0,0']));
    const b = writeRect(store, a, 0, 0, solid(10, 10, [0, 0, 0, 0]));
    expect(store.get(a.tiles['0,0'])).toEqual(before);
    expect(b.tiles['0,0']).toBeUndefined();
    expect(b.bounds).toBeNull();
  });
  it('keeps tiles a write leaves unchanged shared with the old grid', () => {
    const store = new TileStore();
    const img = solid(600, 300, [10, 20, 30, 255]);
    const a = gridFromImage(store, img);
    const count = store.size;
    // Rewrite the whole area with one pixel changed: only its tile is copied.
    const copy = readRGBA(store, a, { x: 0, y: 0, width: 600, height: 300 });
    copy.data[(10 * 600 + 300) * 4] = 99;
    const b = writeRect(store, a, 0, 0, copy);
    expect(store.size).toBe(count + 1);
    for (const key of Object.keys(a.tiles)) expect(b.tiles[key] === a.tiles[key]).toBe(key !== '1,0');
    expect(readRGBA(store, b, { x: 300, y: 10, width: 1, height: 1 }).data[0]).toBe(99);
    // Transparent pixels over absent tiles and fill values over absent mask tiles add nothing.
    const c = writeRect(store, b, 700, 0, solid(300, 300, [0, 0, 0, 0]));
    expect(c.tiles).toEqual(b.tiles);
    const mask = writeRect(store, allMask(255), 0, 0, { width: 300, height: 10, data: new Uint8Array(3000).fill(255) });
    expect(mask.tiles).toEqual({});
    // Unaligned and non-byte sources compare value by value.
    const odd = new Uint8ClampedArray(600 * 300 * 4 + 1).subarray(1);
    odd.set(copy.data);
    expect(writeRect(store, b, 0, 0, { width: 600, height: 300, data: odd }).tiles).toEqual(b.tiles);
    expect(writeRect(store, b, 0, 0, { width: 600, height: 300, data: Float32Array.from(copy.data) }).tiles).toEqual(b.tiles);
    expect(store.size).toBe(count + 1);
  });
  it('treats absent mask tiles as the fill value', () => {
    const store = new TileStore();
    const all = allMask(255);
    expect(readMask(store, all, { x: 5000, y: -5, width: 2, height: 1 }).data).toEqual(new Uint8Array([255, 255]));
    const hole = writeRect(store, all, 0, 0, { width: 2, height: 1, data: new Uint8Array([0, 128]) });
    expect(readMask(store, hole, { x: 0, y: 0, width: 3, height: 1 }).data).toEqual(new Uint8Array([0, 128, 255]));
  });
  it('finds tight content bounds of sparse, opaque and mask tiles', () => {
    // Reference: every covered pixel, scanned the slow way.
    const brute = (d: Uint8ClampedArray, c: number) => {
      let x0 = TILE, y0 = TILE, x1 = -1, y1 = -1;
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++)
          if (d[(y * TILE + x) * c + c - 1]) {
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
          }
      return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    };
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (const c of [1, 4] as const)
      for (let n = 0; n < 40; n++) {
        const store = new TileStore();
        const d = new Uint8ClampedArray(TILE * TILE * c);
        // Mostly a few scattered pixels or rectangles; sometimes everything.
        if (n % 10 === 0) d.fill(255);
        else
          for (let k = Math.floor(rand() * 6); k > 0; k--) {
            const x = Math.floor(rand() * TILE), y = Math.floor(rand() * TILE);
            const w = 1 + Math.floor(rand() * (TILE - x) * (n % 3 ? 0.1 : 1)), h = 1 + Math.floor(rand() * (TILE - y) * 0.5);
            for (let yy = y; yy < Math.min(TILE, y + h); yy++) for (let xx = x; xx < x + w; xx++) d[(yy * TILE + xx) * c + c - 1] = 1 + (k % 255);
          }
        // Color without coverage never counts.
        if (c === 4) d[0] = 9;
        const grid = { ...emptyGrid(c), tiles: { '0,0': store.add(d) } };
        expect(computeBounds(store, grid)).toEqual(brute(d, c));
      }
  });
  it('round trips packed grids', async () => {
    const store = new TileStore();
    const grid = gridFromImage(store, solid(400, 3, [1, 2, 3, 4]), 7, -9);
    const copy = await unpackGrid(new TileStore(), await packGrid(store, grid));
    expect(copy.x).toBe(grid.x);
    expect(copy.bounds).toEqual(grid.bounds);
    expect(Object.keys(copy.tiles).sort()).toEqual(Object.keys(grid.tiles).sort());
  });
});

describe('brush strokes', () => {
  const tip = { size: 20, hardness: 1, spacing: 0.25, roundness: 1, angle: 0 };
  it('caps coverage at the stroke opacity however often dabs overlap', () => {
    const store = new TileStore();
    const s = new StrokeSession(store, emptyGrid(4), { tip, opacity: 0.5, flow: 1, target: { kind: 'color', rgb: [255, 0, 0], mode: 'normal' } });
    for (let i = 0; i < 20; i++) s.addPoint(50 + (i % 2), 50);
    const g = s.commit();
    const px = readRGBA(store, g, { x: 50, y: 50, width: 1, height: 1 }).data;
    expect([...px]).toEqual([255, 0, 0, 128]);
  });
  it('accumulates flow within a stroke towards the opacity', () => {
    const store = new TileStore();
    const s = new StrokeSession(store, emptyGrid(4), { tip, opacity: 1, flow: 0.2, target: { kind: 'color', rgb: [0, 0, 255], mode: 'normal' } });
    s.addPoint(30, 30);
    const once = readRGBA(store, s.grid, { x: 30, y: 30, width: 1, height: 1 }).data[3];
    for (let i = 0; i < 10; i++) s.addPoint(30 + (i % 2) * 0.1, 30);
    s.addPoint(40, 30);
    const g = s.commit();
    const many = readRGBA(store, g, { x: 30, y: 30, width: 1, height: 1 }).data[3];
    expect(once).toBe(51);
    expect(many).toBeGreaterThan(once);
  });
  it('erases, preserves transparency and respects the selection', () => {
    const store = new TileStore();
    const base = gridFromImage(store, solid(60, 60, [0, 255, 0, 255]));
    const erase = new StrokeSession(store, base, { tip, opacity: 1, flow: 1, target: { kind: 'color', rgb: [0, 0, 0], mode: 'normal', erase: true } });
    erase.addPoint(10, 10);
    expect(readRGBA(store, erase.commit(), { x: 10, y: 10, width: 1, height: 1 }).data[3]).toBe(0);
    const sel = writeRect(store, emptyGrid(1), 0, 0, { width: 30, height: 60, data: new Uint8Array(30 * 60).fill(255) });
    const paint = new StrokeSession(store, base, { tip: { ...tip, size: 200 }, opacity: 1, flow: 1, selection: sel, target: { kind: 'color', rgb: [255, 0, 255], mode: 'normal', preserveAlpha: true } });
    paint.addPoint(30, 30);
    const g = paint.commit();
    expect([...readRGBA(store, g, { x: 5, y: 5, width: 1, height: 1 }).data]).toEqual([255, 0, 255, 255]);
    expect([...readRGBA(store, g, { x: 45, y: 5, width: 1, height: 1 }).data]).toEqual([0, 255, 0, 255]);
    expect(readRGBA(store, g, { x: 70, y: 5, width: 1, height: 1 }).data[3]).toBe(0);
  });
  it('cancels without leaking working tiles', () => {
    const store = new TileStore();
    const base = gridFromImage(store, solid(10, 10, [1, 1, 1, 255]));
    const count = store.size;
    const s = new StrokeSession(store, base, { tip, opacity: 1, flow: 1, target: { kind: 'color', rgb: [9, 9, 9], mode: 'normal' } });
    s.addPoint(300, 300);
    s.addPoint(600, 300);
    expect(store.size).toBeGreaterThan(count);
    s.cancel();
    expect(store.size).toBe(count);
  });
  it('paints aliased tips with fully covered or untouched pixels only', () => {
    const store = new TileStore();
    const s = new StrokeSession(store, emptyGrid(4), { tip: { ...tip, size: 3, aliased: true }, opacity: 1, flow: 1, target: { kind: 'color', rgb: [0, 0, 0], mode: 'normal' } });
    s.addPoint(10.5, 10.5);
    s.addPoint(30.2, 17.9);
    const g = s.commit();
    const alpha = readRGBA(store, g, { x: 0, y: 0, width: 40, height: 30 }).data.filter((_, i) => i % 4 === 3);
    expect(alpha.every((a) => a === 0 || a === 255)).toBe(true);
    // A 3 px tip at a pixel center covers that pixel's 3x3 neighborhood.
    expect([g.bounds!.x, g.bounds!.y]).toEqual([9, 9]);
    expect(alpha[10 * 40 + 9]).toBe(255);
    expect(alpha[10 * 40 + 8]).toBe(0);
  });
  it('paints masks towards a value', () => {
    const store = new TileStore();
    const s = new StrokeSession(store, allMask(255), { tip, opacity: 1, flow: 1, target: { kind: 'mask', value: 0 } });
    s.addPoint(TILE + 5, 5);
    const g = s.commit();
    expect(readMask(store, g, { x: TILE + 5, y: 5, width: 1, height: 1 }).data[0]).toBe(0);
    expect(readMask(store, g, { x: 0, y: 200, width: 1, height: 1 }).data[0]).toBe(255);
  });
});

describe('pixel layers', () => {
  it('moves by changing the grid origin and resamples scaled transforms', () => {
    const store = new TileStore();
    const doc = { width: 100, height: 100 };
    const l = newPixelLayer('Layer 1', doc, gridFromImage(store, solid(10, 10, [200, 0, 0, 255]), 5, 5));
    expect(l.transform).toMatchObject({ x: 5, y: 5, width: 10, height: 10 });
    l.transform.x += 3;
    expect(pixelTransformKind(l)).toBe('translate');
    commitPixelTranslation(l);
    expect(l.pixels!.x).toBe(3);
    expect(readRGBA(store, l.pixels!, { x: 8, y: 5, width: 1, height: 1 }).data[3]).toBe(255);
    l.transform = { x: 8, y: 5, width: 20, height: 20, rotation: 0 };
    expect(pixelTransformKind(l)).toBe('resample');
    commitPixelResample(l, store, doc);
    expect(l.transform).toMatchObject({ x: 8, y: 5, width: 20, height: 20 });
    expect([...readRGBA(store, l.pixels!, { x: 18, y: 15, width: 1, height: 1 }).data]).toEqual([200, 0, 0, 255]);
  });
});
