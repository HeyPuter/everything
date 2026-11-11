// Animated and multi-page files keep a full canvas per frame or page, so a
// few hundred bytes of GIF can describe gigabytes of frames. Frames past the
// memory budget are left out (the budget is lowered here to keep tests small).
import { describe, expect, it, vi } from 'vitest';
import { decodeGif } from '../src/imaging/codecs/gif';
import { decodeApng, encodeApng } from '../src/imaging/codecs/apng';
import { decodeTiff } from '../src/imaging/codecs/tiff';
import { buildTiff, type RawTag } from './codecs-builders';
import { decodeFile } from '../src/features/files/open';

vi.mock('../src/imaging/codecs/bytes', async (importOriginal) => ({ ...(await importOriginal<object>()), frameBudgetBytes: 64 * 64 * 4 * 5 }));

// A GIF whose 64 × 64 screen is redrawn by `frames` one-pixel images: each
// frame costs 9 bytes of file and a full 16 KB canvas when decoded.
function frameBomb(frames: number) {
  const b = [...new TextEncoder().encode('GIF89a'), 64, 0, 64, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  for (let i = 0; i < frames; i++) b.push(0x2c, i & 63, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0);
  b.push(0x3b);
  return new Uint8Array(b);
}
const frame = (v: number) => ({ rgba: { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(v) }, delayMs: 50 });

describe('frame memory budget', () => {
  it('stops decoding GIF frames past the budget', () => {
    const all = decodeGif(frameBomb(40), { maxBytes: Infinity });
    expect(all.frames).toHaveLength(40);
    expect(all.truncated).toBeUndefined();
    const res = decodeGif(frameBomb(40));
    expect(res.frames).toHaveLength(5);
    expect(res.truncated).toBe(true);
    // A screen larger than the budget still opens its first frame.
    expect(decodeGif(frameBomb(3), { maxBytes: 10 }).frames).toHaveLength(1);
  });

  it('stops decoding APNG frames past the budget', () => {
    const png = encodeApng(Array.from({ length: 9 }, (_, i) => frame(i * 20)), { optimize: false });
    expect(decodeApng(png, { maxBytes: Infinity }).frames).toHaveLength(9);
    const res = decodeApng(png);
    expect(res.frames).toHaveLength(5);
    expect(res.truncated).toBe(true);
  });

  it('stops decoding TIFF pages past the budget with a note', () => {
    const tag = (tag: number, type: number, v: number): RawTag => ({ tag, type, values: [v] });
    const page = { tags: [tag(256, 4, 64), tag(257, 4, 64), tag(258, 3, 8), tag(259, 3, 1), tag(262, 3, 1), tag(277, 3, 1), tag(278, 4, 64)], chunks: [new Uint8Array(64 * 64)] };
    const tif = buildTiff(Array.from({ length: 8 }, () => page), { le: true });
    expect(decodeTiff(tif, { maxBytes: Infinity }).pages).toHaveLength(8);
    const res = decodeTiff(tif);
    expect(res.pages).toHaveLength(5);
    expect(res.warnings).toEqual(['Pages 6 and later were not opened: they need more memory than one file may use.']);
  });

  it('tells the user when an opened animation lost frames', async () => {
    const gif = await decodeFile(new Blob([frameBomb(40)]), 'bomb.gif', { pages: 'animation' });
    expect(gif.animation?.delays).toHaveLength(5);
    expect(gif.notice).toBe('Only the first 5 frames were opened: the rest need more memory than one file may use.');
    const first = await decodeFile(new Blob([frameBomb(40)]), 'bomb.gif', { pages: 'first' });
    expect(first.layers).toBeUndefined();
    expect(first.notice).toBeUndefined();
  });
});
