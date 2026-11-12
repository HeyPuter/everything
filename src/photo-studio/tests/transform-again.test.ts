import { describe, expect, it } from 'vitest';
import type { Editor } from '../src/editor';
import { layer, newDocument, type PhotoDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { emptyGrid, gridFromImage, readMask, readRGBA, TileStore, writeRect } from '../src/model/tiles';
import { recordTransform } from '../src/features/transform/session-state';
import { transformAgain } from '../src/features/transform/layer-ops';
import { about, rotateM } from '../src/features/transform/math';
import type { RGBA8 } from '../src/imaging/types';

/** Just enough of the editor for Transform Again on one selected layer. */
function editor(doc: PhotoDocument, store: TileStore) {
  const e = {
    doc,
    assets: { tiles: store },
    settings: { transformInterpolation: 'nearest' },
    transform: { apply() {} },
    messages: [] as string[],
    message: (m: string) => e.messages.push(m),
    get selectedLayers() {
      return [e.doc.layers[0]];
    },
    command(_label: string, fn: (d: PhotoDocument) => void) {
      const d = structuredClone(e.doc);
      fn(d);
      e.doc = d;
    },
  };
  return e;
}

describe('Transform Again', () => {
  it('carries a linked layer mask of a pixel layer with its pixels', async () => {
    const store = new TileStore();
    const img: RGBA8 = { width: 40, height: 20, data: new Uint8ClampedArray(40 * 20 * 4) };
    for (let i = 0; i < 40 * 20; i++) img.data.set(i % 40 < 20 ? [0, 0, 255, 255] : [255, 0, 0, 255], i * 4);
    const doc = newDocument(40, 20, 'Again');
    const l = newPixelLayer('Layer', doc, gridFromImage(store, img));
    // The mask reveals the left (blue) half only.
    const m = { width: 40, height: 20, data: new Uint8Array(40 * 20) };
    for (let i = 0; i < m.data.length; i++) m.data[i] = i % 40 < 20 ? 255 : 0;
    l.maskGrid = writeRect(store, emptyGrid(1), 0, 0, m);
    doc.layers = [l];
    const e = editor(doc, store);
    recordTransform({ matrix: about(rotateM(180), 20, 10) });
    await transformAgain(e as unknown as Editor);
    const after = e.doc.layers[0];
    // Blue moved to the right half; the revealed half moved with it.
    expect([...readRGBA(store, after.pixels!, { x: 35, y: 10, width: 1, height: 1 }).data]).toEqual([0, 0, 255, 255]);
    expect(readMask(store, after.maskGrid!, { x: 35, y: 10, width: 1, height: 1 }).data[0]).toBe(255);
    expect(readMask(store, after.maskGrid!, { x: 5, y: 10, width: 1, height: 1 }).data[0]).toBe(0);
  });
  it('leaves an unlinked mask where it is', async () => {
    const store = new TileStore();
    const doc = newDocument(40, 20, 'Again');
    const l = newPixelLayer('Layer', doc, gridFromImage(store, { width: 40, height: 20, data: new Uint8ClampedArray(40 * 20 * 4).fill(200) }));
    const m = { width: 40, height: 20, data: new Uint8Array(40 * 20) };
    for (let i = 0; i < m.data.length; i++) m.data[i] = i % 40 < 20 ? 255 : 0;
    l.maskGrid = writeRect(store, emptyGrid(1), 0, 0, m);
    l.maskUnlinked = true;
    doc.layers = [l];
    const e = editor(doc, store);
    recordTransform({ matrix: about(rotateM(180), 20, 10) });
    await transformAgain(e as unknown as Editor);
    expect(readMask(store, e.doc.layers[0].maskGrid!, { x: 5, y: 10, width: 1, height: 1 }).data[0]).toBe(255);
  });
  it('carries the linked mask of a transformed group', async () => {
    const store = new TileStore();
    const doc = newDocument(40, 20, 'Again');
    const l = newPixelLayer('Layer', doc, gridFromImage(store, { width: 40, height: 20, data: new Uint8ClampedArray(40 * 20 * 4).fill(200) }));
    const g = layer('group', 'Group', 40, 20);
    g.children = [l];
    const m = { width: 40, height: 20, data: new Uint8Array(40 * 20) };
    for (let i = 0; i < m.data.length; i++) m.data[i] = i % 40 < 20 ? 255 : 0;
    g.maskGrid = writeRect(store, emptyGrid(1), 0, 0, m);
    doc.layers = [g];
    const e = editor(doc, store);
    recordTransform({ matrix: about(rotateM(180), 20, 10) });
    await transformAgain(e as unknown as Editor);
    const mask = e.doc.layers[0].maskGrid!;
    expect(readMask(store, mask, { x: 35, y: 10, width: 1, height: 1 }).data[0]).toBe(255);
    expect(readMask(store, mask, { x: 5, y: 10, width: 1, height: 1 }).data[0]).toBe(0);
  });
  it('keeps Live Filters and moves their source with the pixels', async () => {
    const store = new TileStore();
    const img: RGBA8 = { width: 40, height: 20, data: new Uint8ClampedArray(40 * 20 * 4) };
    for (let i = 0; i < 40 * 20; i++) img.data.set(i % 40 < 20 ? [0, 0, 255, 255] : [255, 0, 0, 255], i * 4);
    const doc = newDocument(40, 20, 'Again');
    const l = newPixelLayer('Layer', doc, gridFromImage(store, img));
    l.liveSource = gridFromImage(store, img);
    l.liveFilters = [{ id: 'gaussian-blur', params: { radius: 1 } }] as never;
    doc.layers = [l];
    const e = editor(doc, store);
    recordTransform({ matrix: about(rotateM(180), 20, 10) });
    await transformAgain(e as unknown as Editor);
    const after = e.doc.layers[0];
    expect(after.liveFilters).toHaveLength(1);
    expect([...readRGBA(store, after.liveSource!, { x: 35, y: 10, width: 1, height: 1 }).data]).toEqual([0, 0, 255, 255]);
  });
});
