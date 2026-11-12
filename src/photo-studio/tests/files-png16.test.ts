// 16-bit PNG decoding against an independent reference: every row filter,
// every color type, Adam7 interlacing and tRNS color keys.
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng16 } from '../src/features/files/png';
import { buildPng } from '../src/imaging/codecs/png-chunks';

const channelsOf: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
const adam7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function random(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
}
// Filtered scanlines of random bytes: any bytes are a valid filtered stream.
function filteredPasses(w: number, h: number, channels: number, interlaced: boolean, next: () => number) {
  const passes = interlaced ? adam7 : [[0, 0, 1, 1]];
  const rows: { filter: number; bytes: Uint8Array; pass: number[] }[] = [];
  for (const p of passes) {
    const pw = Math.ceil((w - p[0]) / p[2]),
      ph = Math.ceil((h - p[1]) / p[3]);
    if (pw <= 0 || ph <= 0) continue;
    for (let y = 0; y < ph; y++) rows.push({ filter: next() % 5, bytes: Uint8Array.from({ length: pw * channels * 2 }, next), pass: p });
  }
  return rows;
}
// Straightforward reference: unfilter byte by byte, then place the pixels.
function reference(w: number, h: number, colorType: number, rows: ReturnType<typeof filteredPasses>, key?: number[]) {
  const channels = channelsOf[colorType],
    bpp = channels * 2;
  const out = new Uint16Array(w * h * 4);
  let prev: Uint8Array | null = null,
    pass: number[] | null = null,
    py = 0;
  for (const r of rows) {
    if (r.pass !== pass) {
      pass = r.pass;
      prev = null;
      py = 0;
    }
    const cur = new Uint8Array(r.bytes.length);
    for (let i = 0; i < cur.length; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0,
        b = prev ? prev[i] : 0,
        c = i >= bpp && prev ? prev[i - bpp] : 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const pred = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][r.filter];
      cur[i] = (r.bytes[i] + pred) & 255;
    }
    const y = pass[1] + py * pass[3];
    for (let px = 0; px * bpp < cur.length; px++) {
      const x = pass[0] + px * pass[2];
      const v = Array.from({ length: channels }, (_, k) => (cur[px * bpp + k * 2] << 8) | cur[px * bpp + k * 2 + 1]);
      const rgb = channels <= 2 ? [v[0], v[0], v[0]] : v.slice(0, 3);
      const keyed = key && key.every((k, i) => k === v[i]);
      const alpha = channels === 2 ? v[1] : channels === 4 ? v[3] : keyed ? 0 : 65535;
      out.set([...rgb, alpha], (y * w + x) * 4);
    }
    prev = cur;
    py++;
  }
  return out;
}
function png(w: number, h: number, colorType: number, interlaced: boolean, rows: ReturnType<typeof filteredPasses>, trns?: number[]) {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([16, colorType, 0, 0, interlaced ? 1 : 0], 8);
  const raw = new Uint8Array(rows.reduce((n, r) => n + 1 + r.bytes.length, 0));
  let o = 0;
  for (const r of rows) {
    raw[o++] = r.filter;
    raw.set(r.bytes, o);
    o += r.bytes.length;
  }
  const chunks = [{ type: 'IHDR', data: ihdr }];
  if (trns) chunks.push({ type: 'tRNS', data: new Uint8Array(trns.flatMap((v) => [v >> 8, v & 255])) });
  chunks.push({ type: 'IDAT', data: new Uint8Array(deflateSync(raw)) }, { type: 'IEND', data: new Uint8Array() });
  return buildPng(chunks);
}

describe('16-bit PNG decoding', () => {
  for (const colorType of [0, 2, 4, 6])
    for (const interlaced of [false, true])
      it(`color type ${colorType}${interlaced ? ', interlaced' : ''}`, () => {
        for (const [w, h] of [[1, 1], [3, 2], [13, 9], [33, 17]]) {
          const next = random(w * 31 + h + colorType * 7 + (interlaced ? 1 : 0));
          const rows = filteredPasses(w, h, channelsOf[colorType], interlaced, next);
          const decoded = decodePng16(png(w, h, colorType, interlaced, rows))!;
          expect([decoded.width, decoded.height]).toEqual([w, h]);
          expect(decoded.data16).toEqual(reference(w, h, colorType, rows));
        }
      });
  it('makes the tRNS color transparent in gray and RGB images', () => {
    for (const colorType of [0, 2]) {
      // Unfiltered rows so the key color is known to occur.
      const w = 4,
        h = 3,
        channels = channelsOf[colorType];
      const next = random(5 + colorType);
      const rows = filteredPasses(w, h, channels, false, next).map((r) => ({ ...r, filter: 0 }));
      rows[1].bytes.set(rows[0].bytes.subarray(0, channels * 2), channels * 2);
      const key = Array.from({ length: channels }, (_, k) => (rows[0].bytes[k * 2] << 8) | rows[0].bytes[k * 2 + 1]);
      const decoded = decodePng16(png(w, h, colorType, false, rows, key))!;
      expect(decoded.data16).toEqual(reference(w, h, colorType, rows, key));
      expect(decoded.data16[3]).toBe(0);
      expect(decoded.data16[(w + 1) * 4 + 3]).toBe(0);
    }
  });
});
