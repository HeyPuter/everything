import { describe, it, expect } from 'vitest';
import { GifWriter, quantize, indexPixels } from '../src/media/gif.js';

/** Minimal GIF reader: returns frames of palette indices and their palettes. */
function readGif(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => bytes[p++] | (bytes[p++] << 8);
  const sig = String.fromCharCode(...bytes.slice(0, 6));
  p = 6;
  const width = u16();
  const height = u16();
  const flags = u8();
  p += 2;
  if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
  const frames = [];
  let delay = 0;
  let loops = null;
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        p++;
        p++;
        delay = u16();
        p += 2;
        continue;
      }
      if (label === 0xff) {
        p += 12; // block size and application id
        p += 2; // sub-block size and id
        loops = u16();
        p++;
        continue;
      }
      for (let n = u8(); n; n = u8()) p += n;
      continue;
    }
    if (b !== 0x2c) throw new Error(`bad block ${b}`);
    p += 8;
    const f = u8();
    const size = 1 << ((f & 7) + 1);
    const palette = bytes.slice(p, p + size * 3);
    p += size * 3;
    const min = u8();
    const data = [];
    for (let n = u8(); n; n = u8()) {
      for (let i = 0; i < n; i++) data.push(u8());
    }
    frames.push({ palette, indices: decodeLzw(data, min, width * height), delay });
  }
  return { sig, width, height, frames, loops };
}

function decodeLzw(data, min, count) {
  const clear = 1 << min;
  const eoi = clear + 1;
  let size = min + 1;
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = null;
    size = min + 1;
  };
  reset();
  const out = [];
  let bitPos = 0;
  const read = () => {
    let v = 0;
    for (let i = 0; i < size; i++) {
      const bit = (data[(bitPos + i) >> 3] >> ((bitPos + i) & 7)) & 1;
      v |= bit << i;
    }
    bitPos += size;
    return v;
  };
  let prev = null;
  while (out.length < count) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else entry = [...prev, prev[0]];
    out.push(...entry);
    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length === 1 << size && size < 12) size++;
    }
    prev = entry;
  }
  return out;
}

function frame(w, h, fn) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y);
    const o = (y * w + x) * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  }
  return rgba;
}

describe('GIF encoder', () => {
  it('round-trips frames through LZW with the right size, delay and loop', () => {
    const w = 61;
    const h = 37;
    const gif = new GifWriter(w, h, { loop: 0, dither: false });
    const a = frame(w, h, (x, y) => [x * 4, y * 6, (x + y) * 2]);
    const b = frame(w, h, () => [255, 0, 0]);
    gif.addFrame(a, 100);
    gif.addFrame(b, 50);
    const out = readGif(gif.finish());
    expect(out.sig).toBe('GIF89a');
    expect([out.width, out.height]).toEqual([w, h]);
    expect(out.loops).toBe(0);
    expect(out.frames.length).toBe(2);
    expect(out.frames[0].delay).toBe(10);
    expect(out.frames[1].delay).toBe(5);
    for (const f of out.frames) expect(f.indices.length).toBe(w * h);
    // A flat red frame decodes to red everywhere.
    const red = out.frames[1];
    const i = red.indices[123];
    expect([red.palette[i * 3], red.palette[i * 3 + 1], red.palette[i * 3 + 2]]).toEqual([252, 4, 4]);
    // The gradient frame is close to its source.
    const g = out.frames[0];
    const px = (x, y) => g.indices[y * w + x];
    const c = px(30, 20);
    expect(Math.abs(g.palette[c * 3] - 120)).toBeLessThan(20);
  });

  it('keeps the length at frame rates that are not whole hundredths', () => {
    for (const [fps, n] of [[12, 36], [15, 45], [8, 24]]) {
      const gif = new GifWriter(4, 4, { dither: false });
      for (let i = 0; i < n; i++) gif.addFrame(frame(4, 4, () => [i * 7, 0, 0]), 1000 / fps);
      const delays = readGif(gif.finish()).frames.map((f) => f.delay);
      expect(delays.reduce((a, b) => a + b, 0), `${fps} fps`).toBe(300);
      // Each frame stays within a hundredth of its exact length.
      for (const d of delays) expect(Math.abs(d - 100 / fps)).toBeLessThan(1);
    }
  });

  it('builds a small palette for few colors and maps pixels to it', () => {
    const rgba = frame(8, 8, (x) => (x < 4 ? [0, 0, 0] : [255, 255, 255]));
    const q = quantize(rgba, 256);
    expect(q.palette.length / 3).toBe(2);
    const idx = indexPixels(rgba, 8, 8, q, false);
    expect(new Set(idx).size).toBe(2);
    expect(idx[0]).not.toBe(idx[7]);
  });

  it('encodes a large noisy frame (dictionary resets)', () => {
    const w = 200;
    const h = 120;
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
    const gif = new GifWriter(w, h, { dither: true });
    gif.addFrame(frame(w, h, () => [rnd(), rnd(), rnd()]), 40);
    const out = readGif(gif.finish());
    expect(out.frames[0].indices.length).toBe(w * h);
  });
});
