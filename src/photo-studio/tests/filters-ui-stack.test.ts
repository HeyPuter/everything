import { describe, expect, it } from 'vitest';
import { allFilters, GALLERY_ID } from '../src/features/filters/catalog';
import {
  cropRGBA, fadeMix, halveMask, halveRGBA, keepAlpha, lerpRGBA, maskToRGBA, mixByMask, rgbaToMask,
  runOperation, runStack,
} from '../src/features/filters/stack';
import { CancelledError, defaults, type Mask8, type RGBA8 } from '../src/imaging/types';
import { compositeRGBA8 } from '../src/imaging/blend';

const ctx = { foreground: [20, 30, 40] as [number, number, number], background: [250, 240, 230] as [number, number, number], seed: 11 };
function noise(w: number, h: number, seed = 1, alpha = false): RGBA8 {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    data[i] = i % 4 === 3 && !alpha ? 255 : (s >>> 16) & 255;
  }
  return { width: w, height: h, data };
}
const px = (img: RGBA8, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe('filter stacks', () => {
  it('limits every filter to the selection (unselected pixels never change)', async () => {
    const W = 40,
      H = 30;
    const src = noise(W, H, 5);
    const sel: Mask8 = { width: W, height: H, data: new Uint8Array(W * H) };
    for (let y = 8; y < 20; y++) for (let x = 10; x < 26; x++) sel.data[y * W + x] = 255;
    for (const op of allFilters) {
      const out = await runStack(src, [{ id: op.id, params: defaults(op), seed: 3 }], ctx, { selection: sel });
      expect(out.width, op.id).toBe(W);
      let bad = 0;
      for (let i = 0; i < W * H; i++) if (!sel.data[i]) for (let c = 0; c < 4; c++) if (out.data[i * 4 + c] !== src.data[i * 4 + c]) bad++;
      expect(bad, op.id).toBe(0);
      // The source buffer is never modified in place.
      expect(src.data).toEqual(noise(W, H, 5).data);
    }
  }, 120000);
  it('handles 1x1 and fully transparent images', async () => {
    const one: RGBA8 = { width: 1, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255]) };
    const clear: RGBA8 = { width: 5, height: 3, data: new Uint8ClampedArray(60) };
    for (const id of ['gaussian-blur', 'unsharp-mask', 'mosaic', 'twirl', 'clouds', 'develop', 'median']) {
      const op = allFilters.find((o) => o.id === id)!;
      expect((await runStack(one, [{ id, params: defaults(op) }], ctx)).data.length, id).toBe(4);
      const c = await runStack(clear, [{ id, params: defaults(op) }], ctx);
      expect(c.width * c.height, id).toBe(15);
    }
  });
  it('blends each entry by its opacity and mode and skips disabled entries', async () => {
    const src = noise(16, 16, 2);
    const invert = { id: 'solarize', params: {} };
    const solar = await runOperation('solarize', src, {}, ctx);
    const disabled = await runStack(src, [{ ...invert, enabled: false }], ctx);
    expect(disabled.data).toEqual(src.data);
    expect(disabled.data).not.toBe(src.data);
    const half = await runStack(src, [{ ...invert, opacity: 0.5 }], ctx);
    expect(half.data).toEqual(lerpRGBA(src, solar, 0.5).data);
    const mult = await runStack(src, [{ ...invert, blend: 'multiply' }], ctx);
    const expected = { ...src, data: new Uint8ClampedArray(src.data) };
    compositeRGBA8(expected, solar, 'multiply', 1);
    expect(mult.data).toEqual(expected.data);
  });
  it('mixes the stack result with the source through a Live Filter mask', async () => {
    const src = noise(8, 4, 9);
    const mask: Mask8 = { width: 8, height: 4, data: new Uint8Array(32) };
    mask.data.fill(255, 0, 16);
    const out = await runStack(src, [{ id: 'solarize', params: {} }], ctx, { mask });
    const solar = await runOperation('solarize', src, {}, ctx);
    expect(px(out, 1, 0)).toEqual(px(solar, 1, 0));
    expect(px(out, 1, 3)).toEqual(px(src, 1, 3));
  });
  it('runs gallery effects in order like separate filters and applies the selection once', async () => {
    const src = noise(24, 24, 4);
    const fx = [
      { id: 'mosaic', params: { cellSize: 4 }, enabled: true },
      { id: 'solarize', params: {}, enabled: true },
      { id: 'find-edges', params: {}, enabled: false },
    ];
    const g = await runOperation(GALLERY_ID, src, { effects: fx } as never, ctx);
    const seq = await runOperation('solarize', await runOperation('mosaic', src, { cellSize: 4 }, ctx), {}, ctx);
    expect(g.data).toEqual(seq.data);
    const sel: Mask8 = { width: 24, height: 24, data: new Uint8Array(576) };
    sel.data.fill(255, 0, 288);
    const gs = await runOperation(GALLERY_ID, src, { effects: fx } as never, { ...ctx, selection: sel });
    expect(px(gs, 3, 2)).toEqual(px(seq, 3, 2));
    expect(px(gs, 3, 20)).toEqual(px(src, 3, 20));
    await expect(runOperation('no-such-filter', src, {}, ctx)).rejects.toThrow(/Unknown filter/);
  });
  it('stops when cancelled', async () => {
    const src = noise(64, 64, 1);
    await expect(runStack(src, [{ id: 'gaussian-blur', params: { radius: 5 } }], ctx, {}, { cancelled: () => true })).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('fade and mixing', () => {
  it('fades between the original and the filtered result', () => {
    const a: RGBA8 = { width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 200, 100, 50, 255]) };
    const b: RGBA8 = { width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]) };
    expect(Array.from(fadeMix(a, b, 'normal', 0).data)).toEqual(Array.from(a.data));
    expect(Array.from(fadeMix(a, b, 'normal', 1).data)).toEqual(Array.from(b.data));
    // Fading toward a transparent result keeps the color and halves alpha.
    expect(px(fadeMix(a, b, 'normal', 0.5), 1, 0)).toEqual([200, 100, 50, 128]);
    expect(px(fadeMix(a, b, 'normal', 0.5), 0, 0)).toEqual([128, 128, 128, 255]);
    // Multiply of white over black stays black at any opacity.
    expect(px(fadeMix(a, b, 'multiply', 1), 0, 0)).toEqual([0, 0, 0, 255]);
    // Screen of white over the color pixel at full strength is white.
    const w: RGBA8 = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };
    const c: RGBA8 = { width: 1, height: 1, data: new Uint8ClampedArray([200, 100, 50, 255]) };
    expect(px(fadeMix(c, w, 'screen', 1), 0, 0)).toEqual([255, 255, 255, 255]);
  });
  it('weights colors by alpha when mixing by a mask', () => {
    const before: RGBA8 = { width: 3, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0]) };
    const after: RGBA8 = { width: 3, height: 1, data: new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]) };
    const out = mixByMask(before, { ...after, data: new Uint8ClampedArray(after.data) }, { width: 3, height: 1, data: new Uint8Array([0, 255, 128]) });
    expect(px(out, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(out, 1, 0)).toEqual([0, 0, 255, 255]);
    // A transparent "before" contributes no color.
    expect(px(out, 2, 0)).toEqual([0, 0, 255, 128]);
  });
  it('halves images with alpha weighting and odd sizes', () => {
    const img: RGBA8 = { width: 3, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255]) };
    const h = halveRGBA(img);
    expect([h.width, h.height]).toEqual([2, 1]);
    expect(px(h, 0, 0)).toEqual([255, 0, 0, 128]);
    expect(px(h, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(Array.from(halveMask({ width: 2, height: 2, data: new Uint8Array([0, 255, 255, 255]) }).data)).toEqual([191]);
    const one = halveRGBA({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 4]) });
    expect([one.width, one.height]).toEqual([1, 1]);
  });
  it('crops with transparent padding and converts masks to gray and back', () => {
    const img = noise(4, 4, 8);
    const c = cropRGBA(img, -1, 2, 3, 3);
    expect(px(c, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(c, 1, 0)).toEqual(px(img, 0, 2));
    expect(px(c, 1, 2)).toEqual([0, 0, 0, 0]);
    const m: Mask8 = { width: 3, height: 1, data: new Uint8Array([0, 77, 255]) };
    expect(Array.from(rgbaToMask(maskToRGBA(m)).data)).toEqual([0, 77, 255]);
  });
});

describe('keepAlpha (locked transparency)', () => {
  it('restores the source alpha and keeps colors the result cannot give', () => {
    const img = (v: number[]): RGBA8 => ({ width: 3, height: 1, data: new Uint8ClampedArray(v) });
    const before = img([10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0]);
    const after = img([100, 110, 120, 90, 1, 2, 3, 0, 4, 5, 6, 200]);
    expect(Array.from(keepAlpha(before, after).data)).toEqual([
      // Visible and filtered: the new color at the old alpha.
      100, 110, 120, 255,
      // The filter cleared it: no color to show, so the old one stays.
      40, 50, 60, 128,
      // Transparent before: unchanged.
      70, 80, 90, 0,
    ]);
  });
  it('keeps a blurred shape inside its own outline', async () => {
    const W = 16, H = 16;
    const src: RGBA8 = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
    for (let y = 4; y < 12; y++)
      for (let x = 4; x < 12; x++)
        src.data.set(x < 8 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * W + x) * 4);
    const blurred = await runStack(src, [{ id: 'gaussian-blur', params: { radius: 2 } }], ctx);
    const out = keepAlpha(src, blurred);
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(src.data[i]);
    // Red and blue mixed across the boundary inside the shape.
    expect(out.data[(8 * W + 7) * 4 + 2]).toBeGreaterThan(40);
  });
});
