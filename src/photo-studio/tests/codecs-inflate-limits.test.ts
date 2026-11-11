// A few hundred kilobytes of Deflate can expand to hundreds of megabytes.
// Readers inflate only what the image needs; pako is wrapped here to count
// every byte it produces.
import { describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { inflateLimited } from '../src/imaging/codecs/inflate';
import { decodePng16 } from '../src/features/files/png';
import { decodeApng } from '../src/imaging/codecs/apng';
import { decodeTiff } from '../src/imaging/codecs/tiff';
import { readPngIcc } from '../src/imaging/codecs/png-chunks';
import { buildTiff, type RawTag } from './codecs-builders';

const inflated = vi.hoisted(() => ({ total: 0 }));
vi.mock('pako', async (importOriginal) => {
  const pako = await importOriginal<typeof import('pako')>();
  class Counting extends pako.Inflate {
    push(data: Uint8Array | ArrayBuffer, mode?: boolean | number) {
      try {
        return super.push(data, mode);
      } finally {
        inflated.total += (this as unknown as { strm: { total_out: number } }).strm.total_out;
      }
    }
  }
  const counted = <F extends (...a: never[]) => unknown>(f: F) =>
    ((...a: Parameters<F>) => {
      const r = f(...a) as Uint8Array | undefined;
      inflated.total += r?.length ?? 0;
      return r;
    }) as F;
  return { ...pako, Inflate: Counting, inflate: counted(pako.inflate), inflateRaw: counted(pako.inflateRaw) };
});

const MB = 2 ** 20;
const bomb = (bytes = 64 * MB) => new Uint8Array(deflateSync(new Uint8Array(bytes), { level: 9 }));
function chunk(type: string, data: Uint8Array) {
  const b = new Uint8Array(12 + data.length);
  new DataView(b.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  b.set(data, 8);
  return b;
}
const png = (...chunks: Uint8Array[]) => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunks.flatMap((c) => [...c])]);
function ihdr(w: number, h: number, depth: number, color: number) {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, w);
  new DataView(d.buffer).setUint32(4, h);
  d[8] = depth;
  d[9] = color;
  return chunk('IHDR', d);
}
const counting = (f: () => unknown) => {
  inflated.total = 0;
  f();
  return inflated.total;
};

describe('bounded inflate', () => {
  it('stops at the limit and reports damaged or short streams', () => {
    const data = new Uint8Array(300_000).map((_, i) => (i * 7) & 255);
    const z = new Uint8Array(deflateSync(data));
    expect(inflateLimited(z, data.length)).toEqual(data);
    expect(inflateLimited(z, data.length + 10)).toEqual(data);
    expect(inflateLimited(z, 1000)).toEqual(data.subarray(0, 1000));
    expect(inflateLimited(new Uint8Array(deflateSync(data, { level: 1 })).subarray(2), data.length, { raw: true })?.length).toBe(data.length);
    expect(inflateLimited(z.subarray(0, z.length >> 1), data.length)).toBeUndefined();
    expect(inflateLimited(new Uint8Array([1, 2, 3, 4]), 10)).toBeUndefined();
  });

  it('inflates only the rows a 16-bit PNG needs', () => {
    const file = png(ihdr(1, 1, 16, 6), chunk('IDAT', bomb()), chunk('IEND', new Uint8Array()));
    let res: ReturnType<typeof decodePng16> = null;
    expect(counting(() => (res = decodePng16(file)))).toBeLessThan(MB);
    expect(res!.width).toBe(1);
  });

  it('inflates only the rows of each APNG frame', () => {
    const fctl = new Uint8Array(26);
    const dv = new DataView(fctl.buffer);
    dv.setUint32(4, 1);
    dv.setUint32(8, 1);
    dv.setUint16(20, 1);
    dv.setUint16(22, 10);
    const actl = new Uint8Array(8);
    new DataView(actl.buffer).setUint32(0, 1);
    const file = png(ihdr(1, 1, 8, 6), chunk('acTL', actl), chunk('fcTL', fctl), chunk('IDAT', bomb()), chunk('IEND', new Uint8Array()));
    expect(counting(() => expect(decodeApng(file).frames).toHaveLength(1))).toBeLessThan(MB);
  });

  it('inflates only the bytes of each TIFF strip', () => {
    const tag = (tag: number, type: number, v: number): RawTag => ({ tag, type, values: [v] });
    const tiff = buildTiff([{ tags: [tag(256, 4, 4), tag(257, 4, 4), tag(258, 3, 8), tag(259, 3, 8), tag(262, 3, 1), tag(277, 3, 1), tag(278, 4, 4)], chunks: [bomb()] }], { le: true });
    expect(counting(() => expect(decodeTiff(tiff).pages[0].width).toBe(4))).toBeLessThan(MB);
  });

  it('refuses a compressed ICC profile that expands past 16 MB', () => {
    const iccp = chunk('iCCP', new Uint8Array([...new TextEncoder().encode('icc'), 0, 0, ...bomb()]));
    const file = png(ihdr(1, 1, 8, 6), iccp, chunk('IEND', new Uint8Array()));
    let icc: ReturnType<typeof readPngIcc>;
    expect(counting(() => (icc = readPngIcc(file)))).toBeLessThan(17 * MB);
    expect(icc!).toBeUndefined();
  });
});
