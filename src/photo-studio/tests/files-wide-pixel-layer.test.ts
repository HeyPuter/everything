// A pixel layer transformed past the document size limits (its content is
// kept off the canvas) saves into a project that reopens, and into a PSD
// whose layers open.
import { expect, it } from 'vitest';
import { Assets } from '../src/model/assets';
import { newDocument } from '../src/model/document';
import { commitPixelResample, newPixelLayer } from '../src/model/pixel-layer';
import { savePsd } from '../src/model/psd';
import { readPsdWithPatternResources } from '../src/model/psd-patterns';
import { deserialize, serialize } from '../src/model/serialization';
import { gridDocBounds, gridFromImage, readRGBA } from '../src/model/tiles';

function stretched() {
  const assets = new Assets();
  const doc = newDocument(1000, 100, 'Wide');
  const img = { width: 100, height: 10, data: new Uint8ClampedArray(100 * 10 * 4).fill(200) };
  const l = newPixelLayer('Strip', doc, gridFromImage(assets.tiles, img));
  // Free Transform to 90 times the width, as the editor bakes it.
  l.transform = { ...l.transform, width: 9000 };
  commitPixelResample(l, assets.tiles, doc, 'nearest');
  doc.layers.push(l);
  return { assets, doc, l };
}

it('reopens a project with a pixel layer wider than 8192 pixels', async () => {
  const { assets, doc, l } = stretched();
  expect([l.sourceWidth, l.sourceHeight]).toEqual([9000, 10]);
  const loaded = await deserialize(await serialize(doc, assets));
  const back = loaded.document.layers[0];
  expect([back.sourceWidth, back.sourceHeight]).toEqual([9000, 10]);
  expect(gridDocBounds(back.pixels!)).toEqual(gridDocBounds(l.pixels!));
});

it('writes such a layer to a PSD as it shows on the canvas', async () => {
  const { assets, doc } = stretched();
  const canvas = new Uint8Array(1000 * 100 * 4).fill(255);
  const blob = await savePsd(
    doc,
    async () => canvas,
    async (x) => {
      const b = gridDocBounds(x.pixels!)!;
      const data = readRGBA(assets.tiles, x.pixels!, b).data;
      return { width: b.width, height: b.height, data: new Uint8Array(data.buffer) };
    },
  );
  const psd = readPsdWithPatternResources(new Uint8Array(await blob.arrayBuffer()), {
    skipCompositeImageData: true,
    skipLayerImageData: true,
  });
  const [layer] = psd.children!;
  expect([layer.left, layer.top, layer.right, layer.bottom]).toEqual([0, 0, 1000, 100]);
});
