// A 32-bit float file without a profile holds linear sRGB. Its 8-bit image,
// which Place Embedded, the Image Processor and other importers read as sRGB,
// is encoded from the floats, so it is not darker than the opened document.
import { expect, it } from 'vitest';
import { encodeTiff } from '../src/imaging/codecs/tiff';
import { decodeFile } from '../src/features/files/open';

const floatTiff = (rgba: number[]) => {
  const data = new Float32Array(4 * 2 * 4);
  for (let i = 0; i < 8; i++) data.set(rgba, i * 4);
  return new Blob([
    encodeTiff(
      { width: 4, height: 2, channels: 4, data },
      { compression: 'none' },
    ) as Uint8Array<ArrayBuffer>,
  ]);
};

it('encodes the 8-bit image of an untagged float TIFF as sRGB', async () => {
  // Linear 0.2140 is sRGB 50%; values past white clip; alpha stays linear.
  const d = await decodeFile(floatTiff([0.214, 0, 2.5, 0.5]), 'merge.tif');
  expect([...d.image.data.slice(0, 4)]).toEqual([127, 0, 255, 128]);
  // The document itself opens from the unchanged floats.
  expect(d.deep?.depth).toBe(32);
  expect(d.deep?.data[0]).toBeCloseTo(0.214, 5);
});
