import { describe, it, expect } from 'vitest';
import { BitReader, BitWriter, crc16, crc32, R2000, R2004, R2007, R2010 } from '../src/io/dwg/bits.js';
import { decompress2004, checksum2004, headerMask } from '../src/io/dwg/container.js';
import { decompress2007 } from '../src/io/dwg/r2007.js';

function roundTrip(ver, write, read) {
  const w = new BitWriter(ver, 4);
  write(w);
  return read(new BitReader(w.bytes(), ver));
}

describe('DWG bit streams', () => {
  it('round-trips bit-coded shorts, longs and doubles in every encoding', () => {
    for (const v of [0, 1, 7, 255, 256, 257, 4096, 65535]) expect(roundTrip(R2000, (w) => w.BS(v), (r) => r.BS())).toBe(v);
    for (const v of [0, 1, 200, 255, 256, 70000, -1, -123456]) expect(roundTrip(R2000, (w) => w.BL(v), (r) => r.BL())).toBe(v);
    for (const v of [0, 1, -0.5, 1e-10, 12345.678, -1e300]) expect(roundTrip(R2000, (w) => w.BD(v), (r) => r.BD())).toBe(v);
    for (const v of [0, 5, 300, 2 ** 40]) expect(roundTrip(R2010, (w) => w.BLL(v), (r) => r.BLL())).toBe(v);
  });

  it('keeps values aligned at odd bit positions', () => {
    const w = new BitWriter(R2000, 4);
    w.B(1);
    w.RC(0xa5);
    w.RS(0x1234);
    w.RL(0xdeadbeef);
    w.RD(Math.PI);
    w.BB(2);
    w.RD2([1.5, -2.25]);
    const r = new BitReader(w.bytes(), R2000);
    expect(r.B()).toBe(1);
    expect(r.RC()).toBe(0xa5);
    expect(r.RS()).toBe(0x1234);
    expect(r.RL()).toBe(0xdeadbeef);
    expect(r.RD()).toBe(Math.PI);
    expect(r.BB()).toBe(2);
    expect(r.RD2()).toEqual([1.5, -2.25]);
  });

  it('round-trips modular chars, modular shorts and handles', () => {
    for (const v of [0, 1, 63, 64, 127, 128, 5000, 2 ** 30]) {
      expect(roundTrip(R2000, (w) => w.UMC(v), (r) => r.UMC())).toBe(v);
      expect(roundTrip(R2000, (w) => w.MC(v), (r) => r.MC())).toBe(v);
      if (v) expect(roundTrip(R2000, (w) => w.MC(-v), (r) => r.MC())).toBe(-v);
      expect(roundTrip(R2000, (w) => w.MS(v), (r) => r.MS())).toBe(v);
    }
    expect(roundTrip(R2000, (w) => w.H(5, 0x1a2b), (r) => r.H())).toEqual({ code: 5, value: 0x1a2b });
    expect(roundTrip(R2000, (w) => w.H(4, 0), (r) => r.H())).toEqual({ code: 4, value: 0 });
  });

  it('resolves relative handle references', () => {
    const w = new BitWriter(R2000, 8);
    w.H(6, 0);
    w.H(8, 0);
    w.H(0xa, 5);
    w.H(0xc, 3);
    w.H(5, 0x99);
    const r = new BitReader(w.bytes(), R2000);
    expect([r.HR(100), r.HR(100), r.HR(100), r.HR(100), r.HR(100)]).toEqual([101, 99, 105, 97, 0x99]);
  });

  it('writes defaulted doubles and reads the patched forms', () => {
    expect(roundTrip(R2000, (w) => w.DD(4.5, 4.5), (r) => r.DD(4.5))).toBe(4.5);
    expect(roundTrip(R2000, (w) => w.DD(-7, 4.5), (r) => r.DD(4.5))).toBe(-7);
    // 01: four bytes replace the low four bytes of the default
    const target = new Uint8Array(new Float64Array([10.000001]).buffer);
    const w = new BitWriter(R2000, 8);
    w.BB(1);
    for (let i = 0; i < 4; i++) w.RC(target[i]);
    const patched = new Uint8Array(new Float64Array([10]).buffer);
    patched.set(target.subarray(0, 4));
    expect(new BitReader(w.bytes(), R2000).DD(10)).toBe(new Float64Array(patched.buffer)[0]);
  });

  it('round-trips text in the codepage and UTF-16 forms', () => {
    expect(roundTrip(R2000, (w) => w.TV('Layer 1'), (r) => r.TV())).toBe('Layer 1');
    expect(roundTrip(R2000, (w) => w.TV('Café'), (r) => r.TV())).toBe('Café');
    expect(roundTrip(R2000, (w) => w.TV('Ω'), (r) => r.TV())).toBe('\\U+03A9');
    expect(roundTrip(R2007, (w) => w.TU('Ω ∅ 😀'), (r) => r.TU())).toBe('Ω ∅ 😀');
    expect(roundTrip(R2000, (w) => w.TV(''), (r) => r.TV())).toBe('');
  });

  it('round-trips colors, extrusions, thickness and object types', () => {
    expect(roundTrip(R2000, (w) => w.CMC(5), (r) => r.CMC().index)).toBe(5);
    expect(roundTrip(R2004, (w) => w.CMC(0, 0x336699), (r) => r.CMC().rgb)).toBe(0x336699);
    expect(roundTrip(R2004, (w) => w.CMC(7), (r) => r.CMC().index)).toBe(7);
    expect(roundTrip(R2004, (w) => w.ENC(256), (r) => r.ENC().index)).toBe(256);
    expect(roundTrip(R2004, (w) => w.ENC(1, 0xff8800), (r) => r.ENC().rgb)).toBe(0xff8800);
    expect(roundTrip(R2000, (w) => w.BE([0, 0, 1]), (r) => r.BE())).toEqual([0, 0, 1]);
    expect(roundTrip(R2000, (w) => w.BE([0, 0.6, 0.8]), (r) => r.BE())).toEqual([0, 0.6, 0.8]);
    expect(roundTrip(R2000, (w) => w.BT(0), (r) => r.BT())).toBe(0);
    expect(roundTrip(R2000, (w) => w.BT(2.5), (r) => r.BT())).toBe(2.5);
    for (const t of [1, 77, 0x1f0 + 3, 500, 1000]) expect(roundTrip(R2010, (w) => w.OT(t), (r) => r.OT())).toBe(t);
  });

  it('computes the DWG CRCs', () => {
    const data = new TextEncoder().encode('123456789');
    // CRC-16/ARC check value
    expect(crc16(data, 0, data.length, 0)).toBe(0xbb3d);
    expect(crc32(data, 0, data.length)).toBe(0xcbf43926);
    // Adler-32 style sums: s1 = sum of bytes, s2 = sum of the running s1 values
    let s1 = 0;
    let s2 = 0;
    for (const x of data) {
      s1 += x;
      s2 += s1;
    }
    expect(checksum2004(0, data, 0, data.length)).toBe(((s2 % 0xfff1) << 16) | (s1 % 0xfff1));
  });

  it('decrypts the R2004 file header pattern', () => {
    expect([...headerMask(8)]).toEqual([0x29, 0x23, 0xbe, 0x84, 0xe1, 0x6c, 0xd6, 0xae]);
  });
});

describe('DWG decompression', () => {
  it('expands R2004 literal runs and back references', () => {
    // 0x01: a literal of 4 bytes; 0x24: copy 6 bytes from offset 3 (4 back);
    // the zero low bits mean a literal length follows, here none (0x11 ends)
    const src = new Uint8Array([0x01, 97, 98, 99, 100, 0x24, 3 << 2, 0, 0x11]);
    const out = decompress2004(src, 0, src.length, 10);
    expect(new TextDecoder().decode(out)).toBe('abcdabcdab');
  });

  it('expands R2007 literal runs in their reversed unit order', () => {
    // opcode 0x20: skip two bytes, low bits of the next byte give the literal length (2)
    const src = new Uint8Array([0x20, 0, 0, 0x02, 0x00, 0x70]);
    expect([...decompress2007(src, 0, src.length, 2)]).toEqual([0x70, 0x00]);
  });
});
