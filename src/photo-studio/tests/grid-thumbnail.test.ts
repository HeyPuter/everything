import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TileStore, gridFromImage } from '../src/model/tiles';
import { gridThumbnail } from '../src/features/panels/thumbnails';

// Layer thumbnails are drawn into a canvas and encoded; count the encodings.
let encoded = 0;
const saved = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
      toDataURL: () => `data:image/png;base64,${++encoded}`,
    }),
  };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = saved;
});

const image = (w: number, h: number, v: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(v) });

describe('layer thumbnails', () => {
  it('reuse the thumbnail of an unchanged grid in a new history state', () => {
    const store = new TileStore();
    const grid = gridFromImage(store, image(300, 200, 200), 10, 20);
    const first = gridThumbnail(store, grid, 1000, 800);
    const count = encoded;
    // Each history state is a structured clone of the document.
    const clone = structuredClone(grid);
    expect(gridThumbnail(store, clone, 1000, 800)).toBe(first);
    expect(gridThumbnail(store, structuredClone(clone), 1000, 800)).toBe(first);
    expect(encoded).toBe(count);
  });
  it('draw again when the content, position, size or store differs', () => {
    const store = new TileStore();
    const grid = gridFromImage(store, image(300, 200, 200));
    gridThumbnail(store, grid, 1000, 800);
    let count = encoded;
    const check = (url: string) => {
      expect(encoded).toBe(++count);
      return url;
    };
    // A live stroke writes into a tile and bumps its version.
    const touched = structuredClone(grid);
    store.touch(Object.values(touched.tiles)[0]);
    check(gridThumbnail(store, touched, 1000, 800));
    check(gridThumbnail(store, { ...structuredClone(grid), x: 40 }, 1000, 800));
    check(gridThumbnail(store, structuredClone(grid), 1000, 800, 28));
    check(gridThumbnail(store, structuredClone(grid), 1000, 800, 40, true));
    check(gridThumbnail(store, gridFromImage(store, image(300, 200, 90)), 1000, 800));
    // Another document's store with the same tile identifiers.
    const other = new TileStore();
    for (const id of Object.values(grid.tiles)) other.add(new Uint8ClampedArray(store.get(id)).fill(7), id);
    check(gridThumbnail(other, structuredClone(grid), 1000, 800));
  });
  it('keep a bounded number of thumbnails per document', () => {
    const store = new TileStore();
    const grid = gridFromImage(store, image(256, 256, 120));
    gridThumbnail(store, grid, 1000, 800);
    // Many other contents (as after many edits) push the first one out.
    for (let x = 1; x <= 1100; x++) gridThumbnail(store, { ...structuredClone(grid), x }, 1000, 800);
    const count = encoded;
    gridThumbnail(store, structuredClone(grid), 1000, 800);
    expect(encoded).toBe(count + 1);
  });
});
