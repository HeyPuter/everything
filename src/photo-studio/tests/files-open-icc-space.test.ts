// Files read by the built-in codecs keep only an RGB profile: their gray and
// CMYK samples arrive as RGB, which a Gray or CMYK profile does not describe.
import { expect, it } from 'vitest';
import { builtinProfile } from '../src/color/builtin-profiles';
import { serializeIcc } from '../src/color/icc-write';
import { encodeTiff } from '../src/imaging/codecs/tiff';
import { decodeFile } from '../src/features/files/open';

const tiff = (channels: 1 | 3, icc: Uint8Array) =>
  new Blob([
    encodeTiff(
      { width: 4, height: 2, channels, data: new Uint8Array(8 * channels).fill(100) },
      { compression: 'none', icc },
    ) as Uint8Array<ArrayBuffer>,
  ]);

it('opens a gray TIFF with a Gray profile untagged and says so', async () => {
  const d = await decodeFile(tiff(1, serializeIcc(builtinProfile('gray-dot-gain-20'))), 'scan.tif');
  expect(d.icc).toBeUndefined();
  expect(d.notice).toBe(
    'The embedded Gray profile does not describe the opened RGB pixels and was not applied.',
  );
  expect([...d.image.data.slice(0, 4)]).toEqual([100, 100, 100, 255]);
});

it('keeps the RGB profile of an RGB TIFF', async () => {
  const icc = serializeIcc(builtinProfile('display-p3'));
  const d = await decodeFile(tiff(3, icc), 'p3.tif');
  expect(d.icc).toEqual(icc);
  expect(d.notice).toBeUndefined();
});
