// APNG frames in every color type, with tRNS transparency, decoded into RGBA.
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodeApng } from '../src/imaging/codecs/apng';

function chunk(type: string, data: number[] | Uint8Array) {
  const b = new Uint8Array(12 + data.length);
  new DataView(b.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  b.set(data, 8);
  return [...b];
}
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
// A 2 × 1 one-frame APNG whose rows use filter 0.
function apng(colorType: number, pixels: number[], extra: number[][] = []) {
  const idat = new Uint8Array(deflateSync(new Uint8Array([0, ...pixels])));
  const fctl = [...u32(0), ...u32(2), ...u32(1), ...u32(0), ...u32(0), 0, 1, 0, 10, 0, 0];
  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk('IHDR', [...u32(2), ...u32(1), 8, colorType, 0, 0, 0]),
    ...chunk('acTL', [...u32(1), ...u32(0)]),
    ...extra.flat(),
    ...chunk('fcTL', fctl),
    ...chunk('IDAT', idat),
    ...chunk('IEND', []),
  ]);
}
const pixels = (bytes: Uint8Array) => Array.from(decodeApng(bytes).frames[0].rgba.data);

describe('APNG color types', () => {
  it('reads RGBA, RGB and gray with their tRNS key colors', () => {
    expect(pixels(apng(6, [1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(pixels(apng(2, [10, 20, 30, 40, 50, 60], [chunk('tRNS', [0, 40, 0, 50, 0, 60])]))).toEqual([10, 20, 30, 255, 40, 50, 60, 0]);
    expect(pixels(apng(2, [10, 20, 30, 40, 50, 60]))).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(pixels(apng(0, [9, 77], [chunk('tRNS', [0, 77])]))).toEqual([9, 9, 9, 255, 77, 77, 77, 0]);
    expect(pixels(apng(4, [100, 50, 200, 255]))).toEqual([100, 100, 100, 50, 200, 200, 200, 255]);
  });

  it('reads palette images with per-entry alpha and out-of-range indices', () => {
    const plte = chunk('PLTE', [255, 0, 0, 0, 0, 255]);
    expect(pixels(apng(3, [1, 0], [plte, chunk('tRNS', [128])]))).toEqual([0, 0, 255, 255, 255, 0, 0, 128]);
    expect(pixels(apng(3, [5, 0], [plte]))).toEqual([0, 0, 0, 255, 255, 0, 0, 255]);
  });
});
