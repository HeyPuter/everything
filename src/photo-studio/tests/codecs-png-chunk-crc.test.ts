// PNG chunks are read without checksumming the whole file; the checksum is
// computed when a caller asks for it and still catches damage.
import { describe, expect, it } from 'vitest';
import { buildPng, readPngChunks, verifyPngCrcs } from '../src/imaging/codecs/png-chunks';

const png = () =>
  buildPng([
    { type: 'IHDR', data: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]) },
    { type: 'pHYs', data: new Uint8Array([0, 0, 11, 19, 0, 0, 11, 19, 1]) },
    { type: 'IDAT', data: new Uint8Array(4096).fill(7) },
    { type: 'IEND', data: new Uint8Array() },
  ]);

describe('readPngChunks', () => {
  it('checks a chunk checksum only when asked, and still finds damage', () => {
    const file = png();
    expect(verifyPngCrcs(file)).toBe(true);
    const chunks = readPngChunks(file);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    const idat = chunks[2];
    // Damage made after reading is found: the checksum is computed when asked.
    file[idat.offset + 8 + 100] ^= 0xff;
    expect(idat.crcValid).toBe(false);
    expect(chunks[1].crcValid).toBe(true);
    expect(verifyPngCrcs(file)).toBe(false);
  });
});
