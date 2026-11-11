// Every project the app can make must reopen: the reader's limits only bound
// damaged or hostile files.
import { describe, expect, it } from 'vitest';
import { layer, newDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { Assets } from '../src/model/assets';
import { gridFromImage } from '../src/model/tiles';
import { deserialize, serialize } from '../src/model/serialization';

const image = (v: number) => ({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(v) });

describe('project limits', () => {
  it('reopens a project with more than a thousand layers', async () => {
    const doc = newDocument(64, 64, 'Many layers');
    doc.layers = Array.from({ length: 1200 }, (_, i) => layer('solid', `Layer ${i + 1}`, 64, 64));
    const back = await deserialize(await serialize(doc, new Assets()));
    expect(back.document.layers).toHaveLength(1200);
    expect(back.document.layers.at(-1)!.name).toBe('Layer 1200');
  });

  it('reopens layers that each carry pixels, a mask and Live Filter tiles', async () => {
    const assets = new Assets();
    const doc = newDocument(16, 16, 'Packed');
    doc.layers = Array.from({ length: 900 }, (_, i) => {
      const l = newPixelLayer(`Layer ${i + 1}`, doc, gridFromImage(assets.tiles, image(i % 256)));
      l.maskGrid = gridFromImage(assets.tiles, { width: 4, height: 4, data: new Uint8ClampedArray(16).fill(255) });
      l.liveSource = gridFromImage(assets.tiles, image(255 - (i % 256)));
      l.liveMask = gridFromImage(assets.tiles, { width: 4, height: 4, data: new Uint8ClampedArray(16).fill(128) });
      l.liveFilters = [];
      return l;
    });
    const back = await deserialize(await serialize(doc, assets));
    expect(back.document.layers).toHaveLength(900);
  }, 60000);

  it('still refuses an asset table far larger than the layers need', async () => {
    const doc = newDocument(16, 16, 'Small');
    doc.layers = [layer('solid', 'Fill', 16, 16)];
    const blob = await serialize(doc, new Assets());
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const length = new DataView(head.buffer).getUint32(8, true);
    const meta = JSON.parse(await blob.slice(12, 12 + length).text());
    meta.assets = Array.from({ length: 4000 }, () => ({ id: crypto.randomUUID(), size: 0, type: 'image/png' }));
    const json = new TextEncoder().encode(JSON.stringify(meta));
    new DataView(head.buffer).setUint32(8, json.length, true);
    await expect(deserialize(new Blob([head, json]))).rejects.toThrow('Invalid asset table.');
  });
});
