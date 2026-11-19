// What of an image file is not opened (metadata, CMYK colors, other pages) is
// noted, so Save asks before writing the document back over that file.
import { describe, expect, it } from 'vitest';
import { decodeFile, fileMetadata } from '../src/features/files/open';
import { buildPng } from '../src/imaging/codecs/png-chunks';
import { encodeTiff } from '../src/imaging/codecs/tiff';

const exifBlock = [...'Exif\0\0']
  .map((c) => c.charCodeAt(0))
  .concat([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const xmpBlock = [...'http://ns.adobe.com/xap/1.0/\0<x/>'].map((c) => c.charCodeAt(0));
const app1 = (body: number[]) => [
  0xff,
  0xe1,
  (body.length + 2) >> 8,
  (body.length + 2) & 255,
  ...body,
];
const jpeg = (...segments: number[][]) =>
  new Uint8Array([0xff, 0xd8, ...segments.flat(), 0xff, 0xda, 0, 2, 0xff, 0xd9]);

/** A little-endian TIFF of one 2×1 strip with the given extra tags (LONG values). */
function tiff(photometric: number, samples: number, extra: [number, number][] = []) {
  const tags = (
    [
      [256, 3, 2],
      [257, 3, 1],
      [258, 3, 8],
      [259, 3, 1],
      [262, 3, photometric],
      [273, 4, 0],
      [277, 3, samples],
      [278, 3, 1],
      [279, 4, 2 * samples],
      ...extra.map(([tag, v]) => [tag, 4, v]),
    ] as [number, number, number][]
  ).sort((a, b) => a[0] - b[0]);
  const ifdSize = 2 + tags.length * 12 + 4;
  const data = 8 + ifdSize;
  const out = new Uint8Array(data + 2 * samples).fill(200, data);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, tags.length, true);
  tags.forEach(([tag, type, v], i) => {
    const at = 10 + i * 12;
    dv.setUint16(at, tag, true);
    dv.setUint16(at + 2, type, true);
    dv.setUint32(at + 4, 1, true);
    if (type === 3) dv.setUint16(at + 8, v, true);
    else dv.setUint32(at + 8, tag === 273 ? data : v, true);
  });
  return out;
}

describe('fileMetadata', () => {
  it('names EXIF and XMP metadata of JPEG, PNG, WebP and TIFF files', () => {
    expect(fileMetadata(jpeg(app1(exifBlock)))).toBe('the EXIF metadata');
    expect(fileMetadata(jpeg(app1(exifBlock), app1(xmpBlock)))).toBe('the EXIF and XMP metadata');
    expect(fileMetadata(jpeg())).toBeUndefined();
    const ihdr = { type: 'IHDR', data: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]) };
    expect(
      fileMetadata(
        buildPng([
          ihdr,
          { type: 'eXIf', data: new Uint8Array(exifBlock.slice(6)) },
          { type: 'IEND', data: new Uint8Array() },
        ]),
      ),
    ).toBe('the EXIF metadata');
    expect(
      fileMetadata(buildPng([ihdr, { type: 'IEND', data: new Uint8Array() }])),
    ).toBeUndefined();
    const webp = new Uint8Array(30);
    webp.set([...'RIFF'].map((c) => c.charCodeAt(0)));
    webp.set(
      [...'WEBPVP8X'].map((c) => c.charCodeAt(0)),
      8,
    );
    webp[20] = 0x04;
    expect(fileMetadata(webp)).toBe('the XMP metadata');
    expect(fileMetadata(tiff(2, 3, [[34665, 0]]))).toBe('the EXIF metadata');
    expect(fileMetadata(tiff(2, 3))).toBeUndefined();
    // Damage is not metadata.
    expect(fileMetadata(jpeg(app1(exifBlock)).subarray(0, 8))).toBeUndefined();
  });
});

describe('decodeFile', () => {
  it('notes what of a TIFF it leaves out: EXIF metadata and CMYK colors', async () => {
    const plain = await decodeFile(
      new Blob([
        encodeTiff(
          { width: 2, height: 1, data: new Uint8ClampedArray(8).fill(9), channels: 4 },
          { compression: 'none' },
        ) as Uint8Array<ArrayBuffer>,
      ]),
      'a.tif',
    );
    expect(plain.leftOut).toBeUndefined();
    const withExif = await decodeFile(new Blob([tiff(2, 3, [[34665, 0]])]), 'b.tif');
    expect(withExif.leftOut).toEqual(['the EXIF metadata']);
    const cmyk = await decodeFile(new Blob([tiff(5, 4)]), 'c.tif');
    expect(cmyk.leftOut).toEqual(['the CMYK colors']);
  });
});
