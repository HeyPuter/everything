// Files too large for a document are refused from their headers, before any
// pixel memory is allocated, and "first page only" decodes only that page.
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodeFile } from '../src/features/files/open';
import { decodeImage } from '../src/imaging/codecs/decode';
import { encodeBmp } from '../src/imaging/codecs/bmp';
import { encodeTga } from '../src/imaging/codecs/tga';
import { encodeGif } from '../src/imaging/codecs/gif';
import { buildTiff, type RawTag } from './codecs-builders';

const short = (tag: number, ...values: number[]): RawTag => ({ tag, type: 3, values });
const long = (tag: number, ...values: number[]): RawTag => ({ tag, type: 4, values });
const limits = { maxSide: 8192, maxPixels: 24_000_000 };
const tiny = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(200) };

// A 16-bit RGB TIFF page whose header claims w × h pixels; the strip holds a
// few compressed bytes (the decoder pads short strips with zeros).
const tiffPage = (w: number, h: number) => ({
  tags: [long(256, w), long(257, h), short(258, 16, 16, 16), short(259, 8), short(262, 2), short(277, 3), long(278, h)],
  chunks: [new Uint8Array(deflateSync(new Uint8Array(12)))],
});

describe('opening files beyond the document limits', () => {
  it('refuses a huge TIFF from its header instead of decoding gigabytes', async () => {
    // Decoding this page would need about 5 GB (samples, RGBA8 and RGBA16).
    const tiff = buildTiff([tiffPage(16000, 16000)], { le: true });
    expect(tiff.length).toBeLessThan(1000);
    await expect(decodeFile(new Blob([tiff.slice()]), 'huge.tif')).rejects.toThrow('This image is 16000 × 16000 pixels, beyond the 8192 pixel per side or 24 megapixel limit.');
  });

  it('checks the header of every codec format against the limits', () => {
    const bmp = encodeBmp(tiny);
    new DataView(bmp.buffer).setInt32(18, 9000, true);
    const tga = encodeTga(tiny);
    new DataView(tga.buffer).setUint16(12, 6000, true);
    new DataView(tga.buffer).setUint16(14, 6000, true);
    const gif = encodeGif(tiny);
    new DataView(gif.buffer).setUint16(6, 10000, true);
    const pgm = new Uint8Array([...new TextEncoder().encode('P5\n8193 1\n255\n'), ...new Uint8Array(8193)]);
    for (const [name, bytes] of [['bmp', bmp], ['tga', tga], ['gif', gif], ['pgm', pgm]] as const) {
      expect(() => decodeImage(bytes, { limits }), name).toThrow(/beyond the 8192 pixel per side or 24 megapixel limit/);
      // Without limits the codecs still read them (other callers set none).
      expect(() => decodeImage(bytes), name).not.toThrow(/limit/);
    }
  });

  it('skips later TIFF pages beyond the limits with a note', () => {
    const tiff = buildTiff([tiffPage(4, 4), tiffPage(9000, 9000)], { le: true });
    const d = decodeImage(tiff, { limits })!;
    expect(d.width).toBe(4);
    expect(d.tiffPages).toBeUndefined();
    expect(d.notes.join(' ')).toMatch(/Page 2: This image is 9000 × 9000 pixels/);
  });

  it('decodes only the first page or frame when asked to', async () => {
    const tiff = buildTiff([tiffPage(4, 4), tiffPage(5, 5), tiffPage(6, 6)], { le: true });
    expect(decodeImage(tiff)!.tiffPages).toHaveLength(3);
    expect(decodeImage(tiff, { firstOnly: true })!.tiffPages).toBeUndefined();
    const gif = encodeGif([{ rgba: tiny, delayMs: 100 }, { rgba: { ...tiny, data: new Uint8ClampedArray(16).fill(90) }, delayMs: 100 }]);
    expect(decodeImage(gif)!.gifFrames).toHaveLength(2);
    expect(decodeImage(gif, { firstOnly: true })!.gifFrames).toBeUndefined();
    const opened = await decodeFile(new Blob([tiff.slice()]), 'pages.tif', { pages: 'first' });
    expect(opened.image.width).toBe(4);
    expect(opened.layers).toBeUndefined();
    const all = await decodeFile(new Blob([tiff.slice()]), 'pages.tif', { pages: 'layers' });
    expect(all.layers?.map((l) => l.name)).toEqual(['Page 2', 'Page 3']);
  });
});
