// AI Recompose, Remove Reflections and Rotate Object: prompts, object
// transforms, seam masks, blending, placement and the Puter request (mocked).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mask8, rgba8, type RGBA8 } from '../src/imaging/types';
import { aiCodec, instructedEdits } from '../src/imaging/ai/puter-ai';
import {
  IDENTITY,
  alignToOriginal,
  blendAmount,
  compositeMasked,
  cutObject,
  detailTransfer,
  footprint,
  genaiUnsupported,
  isIdentity,
  keepAlpha,
  normAngle,
  objectAt,
  objectMatrix,
  onBackdrop,
  overObject,
  recomposePrompt,
  reflectionPrompt,
  renderTransformed,
  rotatePrompt,
  seamMask,
  transformedBounds,
  turnLabel,
  turnWords,
  vacatedGrow,
  vacatedMask,
} from '../src/features/genai/math';

/** A W x H gray image with a red w x h block at (x, y), and its mask. */
function scene(W: number, H: number, x: number, y: number, w: number, h: number) {
  const img = rgba8(W, H, [100, 100, 100, 255]);
  const m = mask8(W, H);
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) {
      img.data.set([220, 20, 20, 255], (j * W + i) * 4);
      m.data[j * W + i] = 255;
    }
  return { img, m };
}
const px = (img: RGBA8, x: number, y: number) =>
  Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe('support check', () => {
  it('accepts 8- and 16-bit RGB and explains how to convert anything else', () => {
    expect(genaiUnsupported({}, 'X')).toBeNull();
    expect(genaiUnsupported({ mode: 'rgb', bitsPerChannel: 16 }, 'X')).toBeNull();
    expect(genaiUnsupported({ mode: 'cmyk' }, 'Rotate Object')).toMatch(/RGB Color/);
    expect(genaiUnsupported({ mode: 'rgb', bitsPerChannel: 32 }, 'X')).toMatch(/16 Bits\/Channel/);
  });
});

describe('prompts', () => {
  it('describe the recompose blend, with or without the object', () => {
    expect(recomposePrompt({ removed: false })).toMatch(/contact shadow/);
    expect(recomposePrompt({ removed: true })).not.toMatch(/new place/);
    expect(recomposePrompt({ removed: true, extra: '  warm light. ' })).toMatch(
      /Also: warm light$/,
    );
  });
  it('ask for reflections (and glare when strong) to go, nothing else to change', () => {
    const p = reflectionPrompt();
    expect(p).toMatch(/reflection/i);
    expect(p).toMatch(/Do not change anything else/);
    expect(p).not.toMatch(/glare/);
    expect(reflectionPrompt({ strength: 'strong', extra: 'lamp at top left' })).toMatch(
      /glare.*Also: lamp at top left\./s,
    );
  });
  it('put the turn and tilt into words', () => {
    expect(turnWords(45, 0)).toBe('turned 45° to the right around its vertical axis');
    expect(turnWords(-30, 20)).toMatch(/30° to the left.*20° from above/);
    expect(turnWords(180, 0)).toMatch(/back faces the viewer/);
    expect(turnWords(-180, 0)).toMatch(/back faces the viewer/);
    expect(turnWords(0, -15)).toMatch(/from below.*underside/);
    expect(turnWords(0, 0)).toBe('shown from the same angle');
    expect(rotatePrompt(90, 0)).toMatch(/turned 90° to the right/);
    expect(rotatePrompt(90, 0, 'has a handle')).toMatch(/Also: has a handle\./);
    expect(turnLabel(45, 15)).toBe('Rotated 45° right, 15° from above');
    expect(turnLabel(0, 0)).toBe('Rotated');
  });
  it('normalizes angles to -180..180', () => {
    expect(normAngle(190)).toBe(-170);
    expect(normAngle(-190)).toBe(170);
    expect(normAngle(180)).toBe(180);
    expect(normAngle(540)).toBe(180);
    expect(normAngle(NaN)).toBe(0);
  });
});

describe('objects', () => {
  it('cuts the covered pixels out with coverage in alpha', () => {
    const { img, m } = scene(20, 10, 4, 2, 5, 3);
    m.data[2 * 20 + 4] = 128;
    const o = cutObject(img, m)!;
    expect(o.rect).toEqual({ x: 4, y: 2, width: 5, height: 3 });
    expect(px(o.img, 0, 0)).toEqual([220, 20, 20, 128]);
    expect(px(o.img, 1, 1)).toEqual([220, 20, 20, 255]);
    expect(cutObject(img, mask8(20, 10))).toBeNull();
  });
  it('moves, flips, scales and rotates about the object center', () => {
    const r = { x: 10, y: 10, width: 10, height: 6 };
    expect(isIdentity(IDENTITY)).toBe(true);
    expect(transformedBounds(r, { ...IDENTITY, dx: 5, dy: -3 })).toEqual({
      x: 15,
      y: 7,
      width: 10,
      height: 6,
    });
    expect(transformedBounds(r, { ...IDENTITY, scale: 2 })).toEqual({
      x: 5,
      y: 7,
      width: 20,
      height: 12,
    });
    // A quarter turn swaps width and height around the same center (15, 13).
    expect(transformedBounds(r, { ...IDENTITY, rotate: 90 })).toEqual({
      x: 12,
      y: 8,
      width: 6,
      height: 10,
    });
    const m = objectMatrix(r, { ...IDENTITY, flipH: true });
    // The left edge lands on the right edge.
    expect(m[0] * 10 + m[4]).toBeCloseTo(20);
  });
  it('renders the object at its new place, flipped, clipped to the canvas', () => {
    const img = rgba8(40, 20, [0, 0, 0, 0]);
    const m = mask8(40, 20);
    // Left half red, right half blue.
    for (let y = 5; y < 10; y++)
      for (let x = 5; x < 15; x++) {
        img.data.set(x < 10 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 40 + x) * 4);
        m.data[y * 40 + x] = 255;
      }
    const o = cutObject(img, m)!;
    const moved = renderTransformed(o, { ...IDENTITY, dx: 20 }, 40, 20)!;
    expect(moved.rect).toEqual({ x: 25, y: 5, width: 10, height: 5 });
    expect(px(moved.img, 1, 2)).toEqual([255, 0, 0, 255]);
    const flipped = renderTransformed(o, { ...IDENTITY, flipH: true }, 40, 20)!;
    expect(px(flipped.img, 1, 2)).toEqual([0, 0, 255, 255]);
    expect(px(flipped.img, 8, 2)).toEqual([255, 0, 0, 255]);
    const half = renderTransformed(o, { ...IDENTITY, dx: 30 }, 40, 20)!;
    expect(half.rect).toEqual({ x: 35, y: 5, width: 5, height: 5 });
    expect(renderTransformed(o, { ...IDENTITY, dx: 100 }, 40, 20)).toBeNull();
    const fp = footprint(moved, 40, 20);
    expect(fp.data[7 * 40 + 30]).toBe(255);
    expect(fp.data[7 * 40 + 10]).toBe(0);
  });
  it('picks the smallest object under a point', () => {
    const big = { rect: { x: 0, y: 0, width: 10, height: 10 }, mask: mask8(10, 10, 255) };
    const small = { rect: { x: 2, y: 2, width: 3, height: 3 }, mask: mask8(3, 3, 255) };
    expect(objectAt([big, small], 3, 3)).toBe(1);
    expect(objectAt([big, small], 8, 8)).toBe(0);
    expect(objectAt([big, small], 20, 3)).toBe(-1);
    small.mask.data[4] = 0;
    expect(objectAt([big, small], 3, 3)).toBe(0);
  });
});

describe('fill and seam masks', () => {
  it('grow the vacated area a little and keep the moved object out of the seam', () => {
    const { m } = scene(60, 40, 10, 10, 10, 10);
    expect(vacatedGrow({ x: 0, y: 0, width: 50, height: 20 })).toBe(2);
    expect(vacatedGrow({ x: 0, y: 0, width: 5000, height: 20 })).toBe(12);
    const hole = vacatedMask(m, 2);
    expect(hole.data[10 * 60 + 8]).toBe(255);
    expect(hole.data[10 * 60 + 5]).toBe(0);
    const placed = mask8(60, 40);
    for (let y = 10; y < 20; y++) placed.data.fill(255, y * 60 + 40, y * 60 + 50);
    const seam = seamMask(hole, placed, 4);
    // The hole and a ring around the new place change; the object itself does not.
    expect(seam.data[15 * 60 + 15]).toBe(255);
    expect(seam.data[15 * 60 + 38]).toBe(255);
    expect(seam.data[15 * 60 + 45]).toBe(0);
    expect(seam.data[15 * 60 + 30]).toBe(0);
    // Removed object: only the hole.
    expect(seamMask(hole, mask8(60, 40), 4).data[15 * 60 + 38]).toBe(0);
  });
});

describe('blending', () => {
  it('mixes by amount, restores detail and keeps transparency', () => {
    const a = rgba8(2, 1, [0, 0, 0, 255]),
      b = rgba8(2, 1, [200, 100, 50, 255]);
    expect(px(blendAmount(a, b, 0), 0, 0)).toEqual([0, 0, 0, 255]);
    expect(px(blendAmount(a, b, 0.5), 0, 0)).toEqual([100, 50, 25, 255]);
    expect(px(blendAmount(a, b, 2), 0, 0)).toEqual([200, 100, 50, 255]);
    const orig = rgba8(1, 1, [120, 120, 120, 255]),
      low = rgba8(1, 1, [100, 100, 100, 255]),
      gen = rgba8(1, 1, [50, 60, 70, 255]);
    expect(px(detailTransfer(gen, orig, low), 0, 0)).toEqual([70, 80, 90, 255]);
    expect(px(detailTransfer(gen, orig, low, 0.5), 0, 0)).toEqual([60, 70, 80, 255]);
    const src = rgba8(1, 1, [0, 0, 0, 40]);
    expect(keepAlpha(rgba8(1, 1, [9, 9, 9, 255]), src).data[3]).toBe(40);
  });
  it('composites a patch through a soft mask and an object over a picture', () => {
    const dst = rgba8(2, 1, [0, 0, 0, 255]),
      patch = rgba8(2, 1, [255, 255, 255, 255]);
    const m = { width: 2, height: 1, data: new Uint8Array([255, 51]) };
    const out = compositeMasked(dst, patch, m);
    expect(px(out, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(px(out, 1, 0)).toEqual([51, 51, 51, 255]);
    const base = rgba8(4, 4, [0, 0, 200, 255]);
    const obj = {
      rect: { x: 1, y: 1, width: 2, height: 1 },
      img: { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 0]) },
    };
    const over = overObject(base, obj);
    expect(px(over, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(px(over, 2, 1)).toEqual([0, 0, 200, 255]);
    expect(px(base, 1, 1)).toEqual([0, 0, 200, 255]);
  });
});

describe('Rotate Object placement', () => {
  it('puts the object on a light backdrop with a margin', () => {
    const o = { rect: { x: 0, y: 0, width: 10, height: 10 }, img: rgba8(10, 10, [255, 0, 0, 255]) };
    o.img.data[3] = 0;
    const b = onBackdrop(o, 0.2, 230);
    expect([b.width, b.height]).toEqual([14, 14]);
    expect(px(b, 0, 0)).toEqual([230, 230, 230, 255]);
    expect(px(b, 2, 2)).toEqual([230, 230, 230, 255]);
    expect(px(b, 3, 3)).toEqual([255, 0, 0, 255]);
  });
  it('keeps the height, stands on the original bottom edge and centers', () => {
    const orig = { x: 100, y: 50, width: 80, height: 120 };
    expect(alignToOriginal(orig, { width: 300, height: 300 })).toEqual({
      x: 80,
      y: 50,
      width: 120,
      height: 120,
    });
    // A much wider result is capped at twice the original's larger side.
    const wide = alignToOriginal(orig, { width: 1000, height: 100 });
    expect(wide.width).toBe(240);
    expect(wide.y + wide.height).toBe(170);
    expect(wide.x + wide.width / 2).toBe(140);
    // A strong tilt matches the area instead.
    const tilted = alignToOriginal(orig, { width: 200, height: 100 }, 45);
    expect(tilted.width * tilted.height).toBeGreaterThan(80 * 120 * 0.95);
    expect(tilted.width * tilted.height).toBeLessThan(80 * 120 * 1.05);
  });
});

describe('instructed edits through Puter', () => {
  const g = globalThis as unknown as { puter?: unknown };
  const codec = { ...aiCodec };
  let encoded: { width: number; height: number }[] = [];
  beforeEach(() => {
    encoded = [];
    aiCodec.toDataUri = async (img: RGBA8) => {
      encoded.push({ width: img.width, height: img.height });
      return `data:image/png;base64,${img.width}x${img.height}`;
    };
    aiCodec.decode = async (res, w, h) => {
      const tag = Number(String((res as { src: string }).src).split('#')[1] ?? 0);
      return rgba8(w ?? 900, h ?? 700, [tag, 0, 0, 255]);
    };
  });
  afterEach(() => {
    delete g.puter;
    Object.assign(aiCodec, codec);
  });
  function mockPuter(fail: (k: number) => unknown = () => undefined) {
    let k = 0;
    const txt2img = vi.fn(async () => {
      const n = ++k,
        err = fail(n);
      if (err) throw err;
      return { src: `https://example.invalid/img#${n}` };
    });
    g.puter = { ai: { txt2img, chat: vi.fn() } };
    return txt2img;
  }
  it('encodes the image once, reduced, and returns one result per variation at the input size', async () => {
    const txt2img = mockPuter();
    const out = await instructedEdits(rgba8(3000, 1500), reflectionPrompt(), { count: 3 });
    expect(encoded).toEqual([{ width: 1024, height: 512 }]);
    expect(txt2img).toHaveBeenCalledTimes(3);
    const [prompt, opts] = txt2img.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(prompt).toMatch(/Remove every reflection/);
    expect(opts).toMatchObject({
      input_image: 'data:image/png;base64,1024x512',
      ratio: { w: 1024, h: 512 },
    });
    expect(out.map((i) => [i.width, i.height])).toEqual([
      [3000, 1500],
      [3000, 1500],
      [3000, 1500],
    ]);
    expect(new Set(out.map((i) => i.data[0])).size).toBe(3);
  });
  it('returns provider-size results for Rotate Object and keeps those that arrived', async () => {
    mockPuter((k) => (k === 1 ? { code: 'upstream_failed' } : undefined));
    const out = await instructedEdits(rgba8(200, 100), rotatePrompt(45, 0), {
      count: 2,
      native: true,
    });
    expect(out).toHaveLength(1);
    expect([out[0].width, out[0].height]).toEqual([900, 700]);
  });
  it('reports sign-in, credit and cancel problems without sending', async () => {
    await expect(instructedEdits(rgba8(8, 8), 'x')).rejects.toMatchObject({ code: 'unavailable' });
    mockPuter(() => ({ code: 'insufficient_funds' }));
    await expect(instructedEdits(rgba8(8, 8), 'x', { count: 2 })).rejects.toMatchObject({
      code: 'funds',
    });
    const txt2img = mockPuter();
    const ac = new AbortController();
    ac.abort();
    await expect(instructedEdits(rgba8(8, 8), 'x', { signal: ac.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    await expect(instructedEdits(rgba8(8, 8), '  ')).rejects.toMatchObject({ code: 'bad-request' });
    expect(txt2img).not.toHaveBeenCalled();
  });
});
