import { describe, it, expect } from 'vitest';
import { Channel } from '../src/audio/channel.js';
import { chooseHop, planTiles, readTileSamples, rangeSignature, TileCache, TILE_COLS } from '../src/spectral/tiles.js';

const ramp = (n, from = 0) => Float32Array.from({ length: n }, (_, i) => from + i);

describe('tile planning', () => {
  it('chooses power-of-two hops, stable within 2x zoom', () => {
    expect(chooseHop(100, 2048)).toBe(64);
    expect(chooseHop(127, 2048)).toBe(64);
    expect(chooseHop(128, 2048)).toBe(128);
    expect(chooseHop(1, 2048)).toBe(64);
    expect(chooseHop(1, 256)).toBe(8);
  });
  it('covers the view with tiles whose columns sit on the block grid', () => {
    const ch = Channel.fromSamples(ramp(200000));
    const tiles = planTiles(ch, 10000, 150000, 64, 1024);
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles[0].x0).toBeLessThanOrEqual(10000);
    expect(tiles[tiles.length - 1].x1).toBeGreaterThanOrEqual(150000);
    for (const t of tiles) {
      expect(t.cols).toBeLessThanOrEqual(TILE_COLS);
      expect(t.centre0 % 64).toBe(0);
    }
  });
  it('keeps interior tile keys when an edit before them shifts the audio', () => {
    const ch = Channel.fromSamples(ramp(300000));
    const before = planTiles(ch, 0, 300000, 64, 1024);
    // Delete 1000 frames near the start: later tiles move but keep their content.
    const edited = ch.splice(500, 1500);
    const after = planTiles(edited, 0, 300000, 64, 1024);
    const keysBefore = new Set(before.map((t) => t.key));
    const shared = after.filter((t) => keysBefore.has(t.key));
    expect(shared.length).toBeGreaterThan(after.length / 2);
    for (const t of shared) {
      const old = before.find((b) => b.key === t.key);
      // Same samples analysed: the shifted read returns identical data.
      expect(Array.from(readTileSamples(edited, t, 1024).slice(0, 50))).toEqual(Array.from(readTileSamples(ch, old, 1024).slice(0, 50)));
    }
    // Tiles touching the edit point get new keys.
    const near = after.filter((t) => t.x0 < 3000);
    expect(near.some((t) => !keysBefore.has(t.key))).toBe(true);
  });
  it('names neighbouring content in edge tile keys', () => {
    const a = Channel.fromSamples(ramp(5000));
    const b = Channel.fromSamples(ramp(5000, 10000));
    const c = Channel.fromSamples(ramp(5000, 20000));
    const ab = a.concat(b);
    const ac = a.concat(c);
    const at = (ch) => planTiles(ch, 0, 10000, 16, 1024).find((t) => t.x0 < 4990 && t.x1 > 4990).key;
    // The last tile of `a` reads into the neighbour, so keys differ...
    expect(at(ab)).not.toBe(at(ac));
    // ...while the first one only reads `a` (and the zero padding).
    expect(planTiles(ab, 0, 10000, 16, 1024)[0].key).toBe(planTiles(ac, 0, 10000, 16, 1024)[0].key);
    expect(rangeSignature(ab, -10, 5)).toMatch(/^z10,/);
  });
  it('uses full tiles on a document grid when zoomed out', () => {
    const ch = Channel.fromSamples(ramp(1 << 22));
    const tiles = planTiles(ch, 0, 1 << 22, 4096, 1024);
    expect(tiles.length).toBe(Math.ceil((1 << 22) / 4096 / TILE_COLS));
    expect(tiles[0].cols).toBe(TILE_COLS);
    // Same content, same keys; an edit inside one tile changes only that key.
    expect(planTiles(ch, 0, 1 << 22, 4096, 1024).map((t) => t.key)).toEqual(tiles.map((t) => t.key));
    // Frame 4096 is the centre of the second analysis window (frames between windows are not read).
    const edited = ch.splice(4096, 4097, Channel.fromSamples(Float32Array.of(7)));
    const after = planTiles(edited, 0, 1 << 22, 4096, 1024);
    expect(after[0].key).not.toBe(tiles[0].key);
    expect(after.slice(1).map((t) => t.key)).toEqual(tiles.slice(1).map((t) => t.key));
  });
  it('gathers individual windows when the hop exceeds the window', () => {
    const ch = Channel.fromSamples(ramp(1 << 20));
    const tiles = planTiles(ch, 0, 1 << 20, 4096, 1024);
    const t = tiles[0];
    expect(t.read.gather.length).toBe(t.cols);
    const s = readTileSamples(ch, t, 1024);
    expect(s.length).toBe(t.cols * 1024);
    expect(s[1024 + 512]).toBe(t.centre0 + 4096);
  });
});

describe('tile cache', () => {
  it('evicts least recently used entries over budget', () => {
    const evicted = [];
    const c = new TileCache(300, (v, k) => evicted.push(k));
    c.set('a', 1, 100);
    c.set('b', 2, 100);
    c.set('c', 3, 100);
    c.get('a');
    c.set('d', 4, 100);
    expect(evicted).toEqual(['b']);
    expect(c.has('a')).toBe(true);
    expect(c.bytes).toBe(300);
    c.trim();
    c.budget = 100;
    c.trim(new Set(['c']));
    expect(c.has('c')).toBe(true);
    expect(c.size).toBe(1);
    c.clear();
    expect(c.bytes).toBe(0);
  });
});

describe('spectrogram shader', () => {
  it('shows the loudest bin a pixel spans, so narrow high tones stay visible', async () => {
    // On a log axis one pixel near the top covers many bins; sampling only the
    // pixel centre dropped tones between centres (a 6 kHz sine vanished).
    const { FS } = await import('../src/spectral/renderer.js');
    expect(FS).toMatch(/dFdy\(vUv\.y\)/);
    expect(FS).toMatch(/v = max\(v, texture\(uTex/);
  });
});

describe('tile textures wider than the GPU allows', () => {
  it('combines neighbouring bins, keeping the loudest', async () => {
    const { fitBins } = await import('../src/spectral/renderer.js');
    // Two columns of 4097 bins (an 8192-point FFT) for a 4096-texel GPU.
    const bins = 4097;
    const bytes = new Uint8Array(bins * 2);
    bytes[256] = 200; // column 0, bin 256
    bytes[bins + 4096] = 99; // column 1, the Nyquist bin
    bytes[bins + 1001] = 7;
    const { bytes: out, width } = fitBins(bytes, bins, 2, 4096);
    expect(width).toBe(2049);
    expect(out.length).toBe(2049 * 2);
    expect(out[128]).toBe(200);
    expect(out[2049 + 2048]).toBe(99);
    expect(out[2049 + 500]).toBe(7);
    // Within the limit, the bytes pass through untouched.
    expect(fitBins(bytes, bins, 2, 8192)).toEqual({ bytes, width: bins });
  });
});
