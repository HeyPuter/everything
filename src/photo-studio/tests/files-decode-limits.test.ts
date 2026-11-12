// Files too large for a document are refused from their headers, before any
// pixel memory is allocated, and "first page only" decodes only that page.
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { browserImageSize, decodeFile } from '../src/features/files/open';
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

describe('browser-decoded images beyond the document limits', () => {
  const png = (w: number, h: number) => {
    const b = new Uint8Array(33);
    b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    b[24] = 8;
    b[25] = 6;
    return b;
  };
  const jpeg = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
  const riff = (chunk: string, body: number[]) => new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBP' + chunk), 0, 0, 0, 0, ...body, ...new Array(16).fill(0)]);

  it('reads PNG, JPEG and WebP sizes from their headers', () => {
    expect(browserImageSize(png(16000, 300))).toEqual({ width: 16000, height: 300 });
    expect(browserImageSize(jpeg(9000, 20))).toEqual({ width: 9000, height: 20 });
    // VP8X canvas: 24-bit width - 1 and height - 1 after 4 flag bytes.
    expect(browserImageSize(riff('VP8X', [0, 0, 0, 0, 0x3f, 0x1f, 0, 0x2b, 0, 0]))).toEqual({ width: 8000, height: 44 });
    // VP8: frame tag, start code, then 14-bit width and height.
    expect(browserImageSize(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x1f, 0x20, 0x00]))).toEqual({ width: 8000, height: 32 });
    // VP8L: signature, then 14-bit width - 1 and height - 1.
    const wl = 9999, hl = 77;
    const bits = (wl - 1) | ((hl - 1) << 14);
    expect(browserImageSize(riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255]))).toEqual({ width: wl, height: hl });
    expect(browserImageSize(new Uint8Array([...new TextEncoder().encode('GIF89a'), 0x10, 0x27, 0x20, 0, 0, 0, 0]))).toEqual({ width: 10000, height: 32 });
    expect(browserImageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('refuses oversized PNG and WebP files before the browser decodes them', async () => {
    // Node has no createImageBitmap: reaching it would fail with another error.
    await expect(decodeFile(new Blob([png(16000, 16000)]), 'huge.png')).rejects.toThrow('This image is 16000 × 16000 pixels, beyond the 8192 pixel per side or 24 megapixel limit.');
    await expect(decodeFile(new Blob([jpeg(6000, 6000)]), 'huge.jpg')).rejects.toThrow('This image is 6000 × 6000 pixels');
    await expect(decodeFile(new Blob([riff('VP8X', [0, 0, 0, 0, 0xff, 0x3f, 0, 0xff, 0x3f, 0])]), 'huge.webp')).rejects.toThrow('This image is 16384 × 16384 pixels');
  });

  // ISO base media boxes: size, type, body.
  const box = (type: string, ...body: number[][]) => {
    const flat = body.flat();
    const n = flat.length + 8;
    return [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...new TextEncoder().encode(type), ...flat];
  };
  const u32 = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const ispe = (w: number, h: number) => box('ispe', [0, 0, 0, 0], u32(w), u32(h));
  // A thumbnail (item 2) listed before the primary image (item 1), as encoders write them.
  const heif = (brand: string, w: number, h: number, padding = 0) =>
    new Uint8Array([
      ...box('ftyp', [...new TextEncoder().encode(brand)], [0, 0, 0, 0], [...new TextEncoder().encode('mif1')]),
      ...box(
        'meta',
        [0, 0, 0, 0],
        box('hdlr', [0, 0, 0, 0], [0, 0, 0, 0], [...new TextEncoder().encode('pict')], new Array(13).fill(0)),
        box('pitm', [0, 0, 0, 0], [0, 1]),
        box('iinf', [0, 0, 0, 0], new Array(padding).fill(0)),
        box('iprp', box('ipco', ispe(256, 256), ispe(w, h)), box('ipma', [0, 0, 0, 0], u32(2), [0, 2, 1, 0x81], [0, 1, 1, 0x82])),
      ),
      ...box('mdat', new Array(32).fill(0)),
    ]);

  it('reads the size of the primary AVIF or HEIC image from its item properties', () => {
    expect(browserImageSize(heif('avif', 12000, 9000))).toEqual({ width: 12000, height: 9000 });
    expect(browserImageSize(heif('heic', 4032, 3024))).toEqual({ width: 4032, height: 3024 });
    // The thumbnail is not taken for the image.
    expect(browserImageSize(heif('avif', 100, 50))).toEqual({ width: 100, height: 50 });
    // Truncated before the properties: unknown, not an error.
    expect(browserImageSize(heif('avif', 12000, 9000).subarray(0, 60))).toBeUndefined();
  });

  it('refuses oversized AVIF and HEIC files before the browser decodes them', async () => {
    // Item tables of real files run past the first 4 KB.
    await expect(decodeFile(new Blob([heif('avif', 12000, 12000, 8000)]), 'huge.avif')).rejects.toThrow('This image is 12000 × 12000 pixels');
    await expect(decodeFile(new Blob([heif('heic', 9000, 9000, 8000)]), 'huge.heic')).rejects.toThrow('This image is 9000 × 9000 pixels');
  });

  it('finds the JPEG size after metadata segments larger than 4 KB', async () => {
    const app1 = [0xff, 0xe1, 0x40, 0x00, ...new Array(0x4000 - 2).fill(0)];
    const big = jpeg(6000, 6000);
    const file = new Uint8Array([0xff, 0xd8, ...app1, ...big.subarray(2)]);
    const { checkBrowserFile } = await import('../src/features/files/open');
    await expect(checkBrowserFile(new Blob([file]))).rejects.toThrow('This image is 6000 × 6000 pixels');
  });
});
