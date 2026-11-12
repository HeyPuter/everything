import { describe, expect, it } from 'vitest';
import { newDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { gridDocBounds, gridFromImage, readRGBA, TileStore, writeRect, emptyGrid } from '../src/model/tiles';
import { applySelection } from '../src/model/selection';
import { dropFloat, liftSelection } from '../src/features/transform/float';
import type { RGBA8 } from '../src/imaging/types';

const solid = (w: number, h: number, c: [number, number, number, number]): RGBA8 => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(c, i * 4);
  return { width: w, height: h, data };
};
function setup(selection: Uint8Array, rect = { x: 2, y: 2, width: 4, height: 4 }) {
  const store = new TileStore();
  const doc = newDocument(10, 10);
  const layer = newPixelLayer('L', doc, gridFromImage(store, solid(8, 8, [200, 100, 50, 255]), 1, 1));
  doc.layers = [layer];
  applySelection(doc, writeRect(store, emptyGrid(1), rect.x, rect.y, { ...rect, data: selection }));
  return { store, doc, layer };
}
const px = (store: TileStore, grid: Parameters<typeof readRGBA>[1], x: number, y: number) => [...readRGBA(store, grid, { x, y, width: 1, height: 1 }).data];

describe('floating selections', () => {
  it('lifts the selected pixels to their tight bounds and leaves a hole', () => {
    const { store, doc, layer } = setup(new Uint8Array(16).fill(255));
    const f = liftSelection(doc, store, layer, { preserveAlpha: false, background: [255, 255, 255] })!;
    expect(f.rect).toEqual({ x: 2, y: 2, width: 4, height: 4 });
    expect([...f.image.data.subarray(0, 4)]).toEqual([200, 100, 50, 255]);
    expect(px(store, f.remaining, 3, 3)[3]).toBe(0);
    expect(px(store, f.remaining, 1, 1)).toEqual([200, 100, 50, 255]);
    // Putting the pixels back where they were restores the layer.
    const back = dropFloat(store, f, f.image, f.rect.x, f.rect.y);
    expect(readRGBA(store, back, { x: 0, y: 0, width: 10, height: 10 }).data).toEqual(readRGBA(store, layer.pixels!, { x: 0, y: 0, width: 10, height: 10 }).data);
    expect(gridDocBounds(back)).toEqual({ x: 1, y: 1, width: 8, height: 8 });
  });
  it('weights soft selections and fills locked-transparency holes with the background color', () => {
    const half = new Uint8Array(16).fill(128);
    const { store, doc, layer } = setup(half);
    const soft = liftSelection(doc, store, layer, { preserveAlpha: false, background: [0, 0, 0] })!;
    expect(soft.image.data[3]).toBe(128);
    expect(px(store, soft.remaining, 3, 3)[3]).toBe(127);
    const locked = liftSelection(doc, store, layer, { preserveAlpha: true, background: [0, 0, 0] })!;
    // Half of the color is replaced; the pixel stays opaque.
    expect(px(store, locked.remaining, 3, 3)).toEqual([100, 50, 25, 255]);
    // Dropped pixels paint inside the layer's alpha only.
    const moved = dropFloat(store, locked, solid(4, 4, [0, 0, 255, 255]), 7, 7);
    expect(px(store, moved, 8, 8)).toEqual([0, 0, 255, 255]);
    expect(px(store, moved, 9, 9)[3]).toBe(0);
  });
  it('reports selections that cover no pixels and the absence of a selection', () => {
    const { store, doc, layer } = setup(new Uint8Array(16).fill(255));
    const empty = { ...doc };
    applySelection(empty, writeRect(store, emptyGrid(1), 0, 0, { width: 1, height: 1, data: new Uint8Array([255]) }));
    expect(liftSelection(empty, store, layer, { preserveAlpha: false, background: [0, 0, 0] })).toBeNull();
    const none = { ...doc };
    applySelection(none, null);
    expect(liftSelection(none, store, layer, { preserveAlpha: false, background: [0, 0, 0] })).toBeUndefined();
  });
  it('leaves a selection holding all of the content to a whole-layer transform', () => {
    const { store, doc, layer } = setup(new Uint8Array(16).fill(255));
    const all = { ...doc };
    applySelection(all, writeRect(store, emptyGrid(1), 0, 0, { width: 10, height: 10, data: new Uint8Array(100).fill(255) }));
    expect(liftSelection(all, store, layer, { preserveAlpha: false, background: [0, 0, 0] })).toBeUndefined();
    // A soft edge, or locked transparency (the hole shows the background color), still lifts.
    const soft = { ...doc };
    applySelection(soft, writeRect(store, emptyGrid(1), 0, 0, { width: 10, height: 10, data: new Uint8Array(100).fill(254) }));
    expect(liftSelection(soft, store, layer, { preserveAlpha: false, background: [0, 0, 0] })).toBeTruthy();
    expect(liftSelection(all, store, layer, { preserveAlpha: true, background: [0, 0, 0] })).toBeTruthy();
  });
});
