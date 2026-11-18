import { describe, expect, it } from 'vitest';
import type { Editor } from '../src/editor';
import { wandMask } from '../src/features/selection';
import { newDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { TileStore, gridFromImage } from '../src/model/tiles';

// A 40 × 10 layer: opaque blue on the left, transparent on the right. The
// transparent part was partly erased from red paint, which keeps its color.
function editor(): Editor {
  const tiles = new TileStore();
  const doc = newDocument(40, 10, 'Wand');
  const data = new Uint8ClampedArray(40 * 10 * 4);
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 40; x++)
      data.set(x < 10 ? [0, 0, 255, 255] : x < 25 ? [255, 0, 0, 0] : [0, 0, 0, 0], (y * 40 + x) * 4);
  const layer = newPixelLayer('Paint', doc, gridFromImage(tiles, { width: 40, height: 10, data }));
  doc.layers = [layer];
  return { doc, layer, assets: { tiles }, settings: { antiAlias: false }, tolerance: 32 } as unknown as Editor;
}

describe('Magic Wand', () => {
  it('treats every fully transparent pixel alike, whatever color was erased there', async () => {
    const m = await wandMask(editor(), 35, 5);
    const row = Array.from(m.data.subarray(5 * 40, 6 * 40));
    expect(row.slice(0, 10).every((v) => v === 0)).toBe(true);
    expect(row.slice(10).every((v) => v === 255)).toBe(true);
  });
  it('still tells opaque colors apart by the tolerance', async () => {
    const m = await wandMask(editor(), 5, 5);
    const row = Array.from(m.data.subarray(5 * 40, 6 * 40));
    expect(row.slice(0, 10).every((v) => v === 255)).toBe(true);
    expect(row.slice(10).every((v) => v === 0)).toBe(true);
  });
});
