// Tile packs in .photo projects say how many tiles they hold; reading one
// inflates no more than that, so a small damaged or hostile pack cannot
// expand into gigabytes.
import { describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
// pako is wrapped to count every byte it inflates.
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
  const inflate = (...a: Parameters<typeof pako.inflate>) => {
    const r = pako.inflate(...a);
    inflated.total += r?.length ?? 0;
    return r;
  };
  return { ...pako, Inflate: Counting, inflate };
});
import { emptyGrid, gridFromImage, packGrid, readRGBA, TileStore, tilePackMimeType, unpackGrid } from '../src/model/tiles';

function pack(header: object, body: Uint8Array) {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const raw = new Uint8Array(4 + h.length + body.length);
  new DataView(raw.buffer).setUint32(0, h.length, true);
  raw.set(h, 4);
  raw.set(body, 4 + h.length);
  return new Blob([deflateSync(raw)], { type: tilePackMimeType });
}

describe('tile pack limits', () => {
  it('round-trips packed grids', async () => {
    const store = new TileStore();
    const data = new Uint8ClampedArray(300 * 260 * 4).map((_, i) => (i * 13) & 255);
    const grid = gridFromImage(store, { width: 300, height: 260, data }, 5, 7);
    const back = await unpackGrid(store, await packGrid(store, grid));
    expect(readRGBA(store, back, { x: 5, y: 7, width: 300, height: 260 }).data).toEqual(data);
    const empty = await unpackGrid(store, await packGrid(store, emptyGrid(1)));
    expect(Object.keys(empty.tiles)).toHaveLength(0);
  });

  it('stops inflating a pack that holds more than its tiles', async () => {
    // One tile announced, 256 MB of zeros stored after it.
    const blob = pack({ v: 1, channels: 1, x: 0, y: 0, fill: 0, keys: ['0,0'] }, new Uint8Array(256 * 2 ** 20));
    expect(blob.size).toBeLessThan(400_000);
    inflated.total = 0;
    await expect(unpackGrid(new TileStore(), blob)).rejects.toThrow('Invalid pixel tile pack length.');
    expect(inflated.total).toBeLessThan(2 ** 20);
  });

  it('refuses short, damaged and oversized headers', async () => {
    await expect(unpackGrid(new TileStore(), pack({ v: 1, channels: 4, x: 0, y: 0, fill: 0, keys: ['0,0'] }, new Uint8Array(10)))).rejects.toThrow('Invalid pixel tile pack length.');
    await expect(unpackGrid(new TileStore(), pack({ v: 1, channels: 3, x: 0, y: 0, keys: [] }, new Uint8Array()))).rejects.toThrow('Invalid pixel tile pack.');
    const huge = new Uint8Array(8);
    new DataView(huge.buffer).setUint32(0, 0xffffffff, true);
    await expect(unpackGrid(new TileStore(), new Blob([deflateSync(huge)]))).rejects.toThrow('Invalid pixel tile pack length.');
    await expect(unpackGrid(new TileStore(), new Blob([new Uint8Array([1, 2, 3])]))).rejects.toThrow('Invalid pixel tile pack.');
  });
});
