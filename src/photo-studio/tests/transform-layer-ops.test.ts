import { describe, expect, it } from 'vitest';
import type { Editor } from '../src/editor';
import { newDocument, type PhotoDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { emptyGrid, gridFromImage, readMask, TileStore, writeRect } from '../src/model/tiles';
import { turnLayers } from '../src/features/transform/layer-ops';

/** Just enough of the editor for Edit > Transform > Flip on one selected layer. */
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
function fixture(unlinked: boolean) {
  const store = new TileStore();
  const doc = newDocument(40, 20, 'Flip');
  const l = newPixelLayer('Layer', doc, gridFromImage(store, { width: 40, height: 20, data: new Uint8ClampedArray(40 * 20 * 4).fill(200) }));
  // The mask reveals the left half only.
  const m = { width: 40, height: 20, data: new Uint8Array(40 * 20) };
  for (let i = 0; i < m.data.length; i++) m.data[i] = i % 40 < 20 ? 255 : 0;
  l.maskGrid = writeRect(store, emptyGrid(1), 0, 0, m);
  if (unlinked) l.maskUnlinked = true;
  doc.layers = [l];
  return { store, e: editor(doc, store) };
}
const maskAt = (store: TileStore, e: { doc: PhotoDocument }, x: number) => readMask(store, e.doc.layers[0].maskGrid!, { x, y: 10, width: 1, height: 1 }).data[0];

describe('Edit > Transform flips', () => {
  it('flip a linked mask with the layer', async () => {
    const { store, e } = fixture(false);
    await turnLayers(e as unknown as Editor, 'flip-horizontal');
    expect(maskAt(store, e, 35)).toBe(255);
    expect(maskAt(store, e, 5)).toBe(0);
  });
  it('leave an unlinked mask where it is', async () => {
    const { store, e } = fixture(true);
    await turnLayers(e as unknown as Editor, 'flip-horizontal');
    expect(maskAt(store, e, 5)).toBe(255);
    expect(maskAt(store, e, 35)).toBe(0);
  });
});
