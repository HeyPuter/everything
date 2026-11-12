import { describe, expect, it } from 'vitest';
import { TileStore, allMask, emptyGrid, gridFromImage, readMask, readRGBA, readRect, writeRect, type TileGrid } from '../src/model/tiles';
import { gridHasTransparent, gridPayload, mergeTiles, readPayload, tileize } from '../src/features/filters/tilepack';
import type { IRect, Mask8, RGBA8 } from '../src/imaging/types';

function noise(w: number, h: number, seed: number, clearEvery = 0): RGBA8 {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    data[i] = (s >>> 16) & 255;
  }
  if (clearEvery) for (let p = 0; p < w * h; p += clearEvery) data[p * 4 + 3] = 0;
  return { width: w, height: h, data };
}
// Element-wise deep equality on large typed arrays is very slow in the
// matcher, so buffers are compared directly.
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Buffer.compare(Buffer.from(a as Uint8Array), Buffer.from(b as Uint8Array)) === 0;
const sameGrid = (store: TileStore, a: TileGrid, b: TileGrid, rect: IRect) => {
  expect(b.bounds).toEqual(a.bounds);
  expect(Object.keys(b.tiles).sort()).toEqual(Object.keys(a.tiles).sort());
  expect(same(readRect(store, b, rect).data, readRect(store, a, rect).data)).toBe(true);
};

describe('worker tile transfer', () => {
  it('reads payload regions exactly like the grid, including negative origins', () => {
    const store = new TileStore();
    const grid = gridFromImage(store, noise(600, 300, 1), -70, 40);
    for (const r of [
      { x: -70, y: 40, width: 600, height: 300 },
      { x: 0, y: 0, width: 300, height: 300 },
      { x: 250, y: 250, width: 20, height: 400 },
      { x: 900, y: 900, width: 3, height: 3 },
    ]) {
      const p = gridPayload(store, grid, r);
      expect(same(readPayload(p, r).data, readRGBA(store, grid, r).data)).toBe(true);
    }
  });
  it('matches writeRect for color grids: partial tiles, emptied tiles and untouched content', () => {
    const store = new TileStore();
    const grid = gridFromImage(store, noise(700, 520, 2), 10, -30);
    const cases: { rect: IRect; img: RGBA8 }[] = [
      { rect: { x: 100, y: 100, width: 300, height: 200 }, img: noise(300, 200, 3) },
      // Clearing a whole tile drops it and shrinks bounds.
      { rect: { x: -100, y: -100, width: 400, height: 400 }, img: { width: 400, height: 400, data: new Uint8ClampedArray(400 * 400 * 4) } },
      { rect: { x: 600, y: 400, width: 300, height: 300 }, img: noise(300, 300, 4, 3) },
    ];
    for (const { rect, img } of cases) {
      const expected = writeRect(store, grid, rect.x, rect.y, img);
      const result = tileize(gridPayload(store, grid, rect), rect, img);
      const merged = mergeTiles(store, grid, result);
      sameGrid(store, expected, merged, { x: -200, y: -200, width: 1200, height: 1000 });
    }
  });
  it('matches writeRect for masks, honoring the fill value', () => {
    const store = new TileStore();
    const mask = (w: number, h: number, v: number): Mask8 => ({ width: w, height: h, data: new Uint8Array(w * h).fill(v) });
    const reveal = allMask(255);
    const rect = { x: 0, y: 0, width: 512, height: 300 };
    const m = mask(512, 300, 255);
    for (let i = 0; i < 3000; i++) m.data[i * 7] = 0;
    const exp = writeRect(store, reveal, 0, 0, m);
    const got = mergeTiles(store, reveal, tileize(gridPayload(store, reveal, rect), rect, m));
    expect(Object.keys(got.tiles).sort()).toEqual(Object.keys(exp.tiles).sort());
    expect(same(readMask(store, got, { x: -10, y: -10, width: 600, height: 400 }).data, readMask(store, exp, { x: -10, y: -10, width: 600, height: 400 }).data)).toBe(true);
    // A plain mask written back to all zero becomes empty.
    const plain = gridFromImage(store, mask(300, 300, 9));
    const cleared = mergeTiles(store, plain, tileize(gridPayload(store, plain, { x: 0, y: 0, width: 300, height: 300 }), { x: 0, y: 0, width: 300, height: 300 }, mask(300, 300, 0)));
    expect(cleared.tiles).toEqual({});
    expect(cleared.bounds).toBeNull();
  });
  it('builds content on an empty grid and leaves the source grid untouched', () => {
    const store = new TileStore();
    const empty = emptyGrid(4);
    const rect = { x: 5, y: 7, width: 30, height: 20 };
    const img = noise(30, 20, 6);
    const merged = mergeTiles(store, empty, tileize(gridPayload(store, empty, rect), rect, img));
    expect(merged.bounds).toEqual(writeRect(store, empty, 5, 7, img).bounds);
    expect(empty.tiles).toEqual({});
    expect(mergeTiles(store, empty, { channels: 4, tiles: [] })).toBe(empty);
  });
});

describe('transparency check behind selection margins', () => {
  it('finds fully transparent pixels only inside the rectangle, across tiles and outside the content', () => {
    const store = new TileStore();
    const img: RGBA8 = { width: 600, height: 300, data: new Uint8ClampedArray(600 * 300 * 4).fill(200) };
    img.data[(150 * 600 + 520) * 4 + 3] = 0;
    const grid = gridFromImage(store, img, 10, 20);
    expect(gridHasTransparent(store, grid, { x: 20, y: 30, width: 400, height: 250 })).toBe(false);
    expect(gridHasTransparent(store, grid, { x: 300, y: 100, width: 300, height: 100 })).toBe(true);
    expect(gridHasTransparent(store, grid, { x: 529, y: 169, width: 2, height: 2 })).toBe(true);
    expect(gridHasTransparent(store, grid, { x: 528, y: 169, width: 2, height: 1 })).toBe(false);
    // Beyond the layer's content everything is transparent.
    expect(gridHasTransparent(store, grid, { x: 0, y: 30, width: 15, height: 5 })).toBe(true);
  });
});
