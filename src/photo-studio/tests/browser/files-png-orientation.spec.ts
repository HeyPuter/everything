// A PNG's eXIf orientation is applied at open whatever its bit depth: 8-bit
// PNGs are decoded by the browser, 16-bit ones by Photo Studio itself.
import { expect, test } from '@playwright/test';
import { boot, idle } from './helpers';

test('8-bit and 16-bit PNGs with the same eXIf orientation open the same way up', async ({
  page,
}) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { encodePng } = await import('/src/features/files/png.ts');
    const { insertPngChunks } = await import('/src/imaging/codecs/png-chunks.ts');
    const { openFile } = await import('/src/features/files/open.ts');
    // 4 × 2 pixels: the left column red, the rest blue. Orientation 6 (rotate
    // 90° clockwise) shows it 2 wide and 4 high with red along the top.
    const w = 4,
      h = 2;
    const exif = new Uint8Array([
      0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0,
      0,
    ]);
    const make = (deep: boolean) => {
      const data = deep ? new Uint16Array(w * h * 4) : new Uint8ClampedArray(w * h * 4);
      const max = deep ? 65535 : 255;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          data.set(x === 0 ? [max, 0, 0, max] : [0, 0, max, max], (y * w + x) * 4);
      const png = encodePng({ width: w, height: h, data: data as Uint8ClampedArray, channels: 4 });
      return new Blob(
        [insertPngChunks(png, [{ type: 'eXIf', data: exif }]) as Uint8Array<ArrayBuffer>],
        { type: 'image/png' },
      );
    };
    const shape = async (blob: Blob, name: string) => {
      await openFile(e, blob, name);
      const doc = e.doc;
      const pixels = await e.renderer.documentPixels({ ...doc, selection: null }, e.assets);
      const k = pixels instanceof Float32Array ? 1 : 255;
      // Red at the top-right pixel?
      const i = (doc.width - 1) * 4;
      return { width: doc.width, height: doc.height, topRightRed: pixels[i] / k > 0.5 };
    };
    return {
      eight: await shape(make(false), 'eight.png'),
      sixteen: await shape(make(true), 'sixteen.png'),
    };
  });
  await idle(page);
  expect(result.eight).toEqual({ width: 2, height: 4, topRightRed: true });
  expect(result.sixteen).toEqual(result.eight);
});
