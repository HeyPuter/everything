// RGB PSD files with saved selections (alpha channels) and spot channels: the
// extra channels are split off for import, and the rest reads as before.
import { describe, expect, it } from 'vitest';
import { initializeCanvas, readPsd, writePsd } from 'ag-psd';
import { appendPsdChannels, splitPsdChannels } from '../src/model/psd-extra-channels';
import { validatePsdHeader } from '../src/model/psd-header';
import { readPsdImageResource } from '../src/model/psd-resources';
import { addChannels, channelResources, flatPsd } from './psd-channel-builders';

// Node has no canvas; the codec only needs image data buffers here.
initializeCanvas(() => { throw new Error('No canvas in tests.'); }, (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData);
const W = 7, H = 5, N = W * H;
const plane = (f: (i: number) => number) => Uint8Array.from({ length: N }, (_, i) => f(i) & 255);
const plane16 = (f: (i: number) => number) => {
  const out = new Uint8Array(N * 2);
  for (let i = 0; i < N; i++) {
    const s = f(i) & 0xffff;
    out[i * 2] = s >> 8;
    out[i * 2 + 1] = s & 255;
  }
  return out;
};
const rgb = [plane((i) => i * 7), plane((i) => 200 - i), plane((i) => (i % 3) * 90)];
const selection = plane((i) => (i % W < 3 ? 255 : 0));
const soft = plane((i) => i * 5);

describe('PSD alpha and spot channels', () => {
  it('opens a flat 8-bit file with two alpha channels (RLE)', () => {
    const psd = flatPsd({ width: W, height: H, depth: 8, compression: 1, planes: [...rgb, selection, soft], resources: channelResources([{ name: 'Sky' }, { name: 'Soft edge' }]) });
    expect(() => validatePsdHeader(psd)).not.toThrow();
    const split = splitPsdChannels(psd)!;
    expect(split.extras.map((c) => c.name)).toEqual(['Sky', 'Soft edge']);
    expect(split.extras[0].data).toEqual(selection);
    expect(split.extras[1].data).toEqual(soft);
    const read = readPsd(split.bytes, { useImageData: true, skipThumbnail: true });
    expect(read.channels).toBe(3);
    const data = read.imageData!.data;
    for (let i = 0; i < N; i++) expect([data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]]).toEqual([rgb[0][i], rgb[1][i], rgb[2][i], 255]);
  });

  it('keeps transparency apart from a 16-bit alpha channel (raw, Pascal names)', () => {
    const alpha16 = plane16((i) => (i % 2 ? 65535 : 0));
    const sel16 = plane16((i) => i * 1800);
    const psd = flatPsd({ width: W, height: H, depth: 16, compression: 0, planes: [plane16((i) => i * 1000), plane16((i) => 60000 - i * 900), plane16(() => 32768), alpha16, sel16], resources: channelResources([{ name: 'Mask' }], 'pascal') });
    const split = splitPsdChannels(psd)!;
    expect(split.extras).toHaveLength(1);
    expect(split.extras[0].name).toBe('Mask');
    expect(Array.from(split.extras[0].data)).toEqual(Array.from({ length: N }, (_, i) => Math.round((i * 1800) / 257)));
    const read = readPsd(split.bytes, { useImageData: true, useRawData: true, skipThumbnail: true });
    expect(read.channels).toBe(4);
  });

  it('reads spot channel names, ink colors and solidity, and PSB row counts', () => {
    const psd = flatPsd({
      psb: true, width: W, height: H, depth: 8, compression: 1, planes: [...rgb, soft],
      resources: channelResources([{ name: 'PANTONE 185 C', display: { rgb: [228, 0, 43], opacity: 100, mode: 2 } }]),
    });
    const split = splitPsdChannels(psd)!;
    expect(split.extras).toEqual([{ name: 'PANTONE 185 C', data: soft, color: '#e4002b', opacity: 1, spot: true }]);
    expect(readPsd(split.bytes, { useImageData: true, skipThumbnail: true }).imageData!.data[4]).toBe(rgb[0][1]);
  });

  it('leaves files without extra channels alone, and reads a lone fourth channel as transparency', () => {
    expect(splitPsdChannels(flatPsd({ width: W, height: H, depth: 8, compression: 1, planes: rgb }))).toBeUndefined();
    expect(splitPsdChannels(flatPsd({ width: W, height: H, depth: 8, compression: 1, planes: [...rgb, soft] }))).toBeUndefined();
    // Names of channels another writer dropped do not turn transparency into one.
    expect(splitPsdChannels(flatPsd({ width: W, height: H, depth: 8, compression: 1, planes: [...rgb, soft], resources: channelResources([{ name: 'Gone' }, { name: 'Gone too' }]) }))).toBeUndefined();
    // Named, a fourth channel is a saved selection.
    const named = splitPsdChannels(flatPsd({ width: W, height: H, depth: 8, compression: 0, planes: [...rgb, soft], resources: channelResources([{ name: 'Alpha 1' }]) }))!;
    expect(named.extras.map((c) => c.name)).toEqual(['Alpha 1']);
  });

  it('keeps the layers of a layered file and the transparency of its composite', () => {
    const pixels = (fill: number[]) => ({ width: W, height: H, data: new Uint8ClampedArray(N * 4).map((_, i) => fill[i % 4]) });
    const base = new Uint8Array(writePsd({
      width: W, height: H,
      imageData: pixels([10, 20, 30, 128]),
      children: [{ name: 'Red', imageData: pixels([255, 0, 0, 255]), left: 0, top: 0 }, { name: 'Half', imageData: pixels([0, 0, 255, 128]), left: 0, top: 0 }],
    }));
    const psd = addChannels(base, [selection, soft], channelResources([{ name: 'Sky' }, { name: 'Soft edge' }]));
    const split = splitPsdChannels(psd)!;
    expect(split.extras.map((c) => [c.name, Array.from(c.data)])).toEqual([['Sky', Array.from(selection)], ['Soft edge', Array.from(soft)]]);
    const read = readPsd(split.bytes, { useImageData: true, skipThumbnail: true });
    expect(read.children!.map((l) => l.name)).toEqual(['Red', 'Half']);
    expect(read.channels).toBe(4);
    expect(Array.from(read.imageData!.data.subarray(0, 4))).toEqual(Array.from(readPsd(base, { useImageData: true, skipThumbnail: true }).imageData!.data.subarray(0, 4)));
    // Without names, the negative layer count still marks transparency.
    const unnamed = splitPsdChannels(addChannels(base, [soft], []))!;
    expect(unnamed.extras.map((c) => c.name)).toEqual(['Alpha 1']);
  });

  it('writes channels that read back, replacing stale channel resources', () => {
    const channels = [{ name: 'Sky', data: selection }, { name: 'Ink', data: soft, color: '#e4002b', opacity: 1, spot: true }];
    for (const [depth, compression, psb] of [[8, 1, false], [8, 0, false], [16, 0, false], [8, 1, true], [32, 0, false]] as const) {
      const sample = depth === 8 ? plane : depth === 16 ? plane16 : (f: (i: number) => number) => { const o = new Uint8Array(N * 4); const v = new DataView(o.buffer); for (let i = 0; i < N; i++) v.setFloat32(i * 4, (f(i) & 255) / 255); return o; };
      const stale = channelResources([{ name: 'Stale' }, { name: 'Stale 2' }]);
      const base = flatPsd({ psb, width: W, height: H, depth, compression, planes: [sample((i) => i), sample((i) => i * 2), sample((i) => i * 3), sample(() => 255)], resources: stale });
      const imageData = base.subarray(26 + 8 + stale.length + (psb ? 8 : 4));
      const split = splitPsdChannels(appendPsdChannels(base, channels))!;
      expect(split.extras, `${depth} ${compression} ${psb}`).toEqual([{ name: 'Sky', data: selection, color: '#ff0000', opacity: 0.5 }, { name: 'Ink', data: soft, color: '#e4002b', opacity: 1, spot: true }]);
      // The merged image comes back as written.
      expect(Array.from(split.bytes.subarray(split.bytes.length - imageData.length))).toEqual(Array.from(imageData));
      expect(new DataView(split.bytes.buffer).getUint16(12)).toBe(4);
    }
  });

  it('marks the transparency channel with alpha identifiers, and reads them', () => {
    const ids = (psd: Uint8Array) => {
      const r = readPsdImageResource(psd, 1053)!;
      return Array.from({ length: r.length / 4 }, (_, i) => new DataView(r.buffer, r.byteOffset).getUint32(i * 4));
    };
    const channels = [{ name: 'Sky', data: selection }, { name: 'Soft', data: soft }];
    // Readers that follow these take channel 3 for transparency only when listed as 0.
    expect(ids(appendPsdChannels(flatPsd({ width: W, height: H, depth: 8, compression: 1, planes: [...rgb, plane(() => 255)] }), channels))).toEqual([0, 1, 2]);
    expect(ids(appendPsdChannels(flatPsd({ width: W, height: H, depth: 8, compression: 1, planes: rgb }), channels))).toEqual([1, 2]);
    // Unnamed, a lone fourth channel listed with a nonzero identifier is a saved selection.
    const id = (n: number[]) => [...'8BIM'].map((c) => c.charCodeAt(0)).concat([0x04, 0x1d, 0, 0, 0, 0, 0, n.length * 4], n.flatMap((x) => [0, 0, 0, x]));
    expect(splitPsdChannels(flatPsd({ width: W, height: H, depth: 8, compression: 0, planes: [...rgb, soft], resources: id([7]) }))!.extras.map((c) => c.name)).toEqual(['Alpha 1']);
    expect(splitPsdChannels(flatPsd({ width: W, height: H, depth: 8, compression: 0, planes: [...rgb, soft], resources: id([0]) }))).toBeUndefined();
  });
});
