import { describe, expect, it } from 'vitest';
import { histograms } from '../src/imaging/adjust/histogram';
import { luma8 } from '../src/imaging/adjust/color-math';

// Byte-by-byte reference: counted pixels have alpha > 0 and, with a
// selection, coverage >= 128.
function reference(data: Uint8ClampedArray, n: number, sel?: Uint8Array) {
  const h = { r: new Array(256).fill(0), g: new Array(256).fill(0), b: new Array(256).fill(0), luminosity: new Array(256).fill(0), rgb: new Array(256).fill(0) };
  for (let p = 0; p < n; p++) {
    const [R, G, B, A] = [data[p * 4], data[p * 4 + 1], data[p * 4 + 2], data[p * 4 + 3]];
    if (!A || (sel && sel[p] < 128)) continue;
    h.r[R]++;
    h.g[G]++;
    h.b[B]++;
    h.luminosity[luma8(R, G, B)]++;
  }
  for (let v = 0; v < 256; v++) h.rgb[v] = h.r[v] + h.g[v] + h.b[v];
  return h;
}
const plain = (h: ReturnType<typeof histograms>) => ({ r: [...h.r], g: [...h.g], b: [...h.b], luminosity: [...h.luminosity], rgb: [...h.rgb] });

describe('histograms', () => {
  const w = 37,
    h = 23,
    n = w * h;
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
  const bytes = new Uint8ClampedArray(n * 4 + 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = random();
  // Some fully transparent pixels with color, some barely visible ones.
  for (let p = 0; p < n; p += 5) bytes[p * 4 + 3] = 0;
  for (let p = 2; p < n; p += 11) bytes[p * 4 + 3] = 1;
  const selection = new Uint8Array(n).map((_, p) => (p % 3 ? 128 : 127));

  it('count the same as a byte-by-byte pass, with and without a selection', () => {
    const data = bytes.slice(0, n * 4);
    expect(plain(histograms({ width: w, height: h, data }))).toEqual(reference(data, n));
    expect(plain(histograms({ width: w, height: h, data }, { width: w, height: h, data: selection }))).toEqual(reference(data, n, selection));
  });
  it('read pixels that do not start on a 4-byte boundary', () => {
    const data = bytes.subarray(1);
    expect(data.byteOffset % 4).not.toBe(0);
    expect(plain(histograms({ width: w, height: h, data }))).toEqual(reference(data, n));
    expect(plain(histograms({ width: w, height: h, data }, { width: w, height: h, data: selection }))).toEqual(reference(data, n, selection));
  });
});
