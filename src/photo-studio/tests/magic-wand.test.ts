import { describe, expect, it } from 'vitest';
import type { Editor } from '../src/editor';
import { wandMask } from '../src/features/selection';
import { newDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { TileStore, gridFromImage } from '../src/model/tiles';
import { grow, similar } from '../src/imaging/segment/mask-ops';

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

describe('Grow and Similar', () => {
  // Transparent on the left, opaque black on the right; the left half is selected.
  const img = { width: 20, height: 4, data: new Uint8ClampedArray(20 * 4 * 4) };
  for (let i = 0; i < 80; i++) if (i % 20 >= 10) img.data.set([0, 0, 0, 255], i * 4);
  const sel = { width: 20, height: 4, data: new Uint8Array(80) };
  for (let i = 0; i < 80; i++) if (i % 20 < 10) sel.data[i] = 255;
  it('do not add opaque pixels whose color matches transparent ones', () => {
    for (const f of [grow, similar]) {
      const out = f(img, sel, 32);
      const row = [...new Array(10).fill(255), ...new Array(10).fill(0)];
      expect(Array.from(out.data.subarray(0, 20))).toEqual(row);
    }
  });
  it('still add similar opaque colors', () => {
    // Dark gray on the left now, with the black half selected.
    const gray = { width: 20, height: 4, data: new Uint8ClampedArray(img.data) };
    for (let i = 0; i < 80; i++) if (i % 20 < 10) gray.data.set([20, 20, 20, 255], i * 4);
    const right = { width: 20, height: 4, data: sel.data.map((v) => 255 - v) };
    for (const f of [grow, similar]) expect(f(gray, right, 32).data[0]).toBe(255);
  });
});
