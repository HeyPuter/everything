import { describe, expect, it } from 'vitest';
import { defaults, mask8, rgba8, type OperationContext, type RGBA8 } from '../src/imaging/types';
import { developOp } from '../src/imaging/filters/develop';
import { lensCorrection } from '../src/imaging/filters/lens';
import { filtersB } from '../src/imaging/filters/index-b';

const ctx: OperationContext = { foreground: [0, 0, 0], background: [255, 255, 255], seed: 3 };
function photo(w: number, h: number): RGBA8 {
  const out = rgba8(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      out.data.set(
        [(x * 255) / (w - 1), (y * 255) / (h - 1), 128 + 100 * Math.sin((x + y) / 5), x === 3 ? 0 : 255],
        (y * w + x) * 4,
      );
  return out;
}
const dev = (src: RGBA8, p: Record<string, number>, c = ctx) =>
  developOp.apply(src, { ...defaults(developOp), ...p }, c) as RGBA8;
const lens = (src: RGBA8, p: Record<string, number | string>, c = ctx) =>
  lensCorrection.apply(src, { ...defaults(lensCorrection), ...p }, c) as RGBA8;
function maxDiff(a: RGBA8, b: RGBA8) {
  let m = 0;
  for (let i = 0; i < a.data.length; i++) {
    if ((i & 3) < 3 && a.data[i | 3] === 0 && b.data[i | 3] === 0) continue;
    m = Math.max(m, Math.abs(a.data[i] - b.data[i]));
  }
  return m;
}
const mean = (img: RGBA8, c = 0) => {
  let s = 0;
  for (let i = c; i < img.data.length; i += 4) s += img.data[i];
  return s / (img.data.length / 4);
};

describe('develop', () => {
  const src = photo(48, 32);
  it('neutral settings and near-zero settings are the identity', () => {
    expect(maxDiff(dev(src, {}), src)).toBe(0);
    // Tiny values force the full pipeline (decode, tone LUTs, encode).
    for (const k of [
      'exposure',
      'contrast',
      'highlights',
      'shadows',
      'whites',
      'blacks',
      'vibrance',
      'saturation',
      'temperature',
      'clarity',
      'texture',
    ])
      expect(maxDiff(dev(src, { [k]: 1e-4 }), src), k).toBeLessThanOrEqual(1);
  });
  it('exposure +1 doubles linear light without clipping into flat white', () => {
    const gray = rgba8(8, 8, [100, 100, 100, 255]);
    const out = dev(gray, { exposure: 1 });
    // sRGB 100 is 0.127 linear; doubled 0.254 encodes to about 137.
    expect(Math.abs(out.data[0] - 137)).toBeLessThanOrEqual(2);
    const white = dev(photo(32, 32), { exposure: 2 });
    let flat = 0;
    for (let i = 0; i < white.data.length; i += 4)
      if (white.data[i] === 255 && white.data[i + 1] === 255 && white.data[i + 2] === 255) flat++;
    expect(flat).toBeLessThan(32 * 32 * 0.2);
  });
  it('tone controls move the expected ends of the range monotonically', () => {
    const ramp = rgba8(256, 1);
    for (let x = 0; x < 256; x++) ramp.data.set([x, x, x, 255], x * 4);
    for (const [k, val] of [
      ['contrast', 80],
      ['contrast', -80],
      ['shadows', 100],
      ['shadows', -100],
      ['highlights', -100],
      ['whites', 100],
      ['blacks', -100],
    ] as const) {
      const out = dev(ramp, { [k]: val });
      for (let x = 1; x < 256; x++)
        expect(out.data[x * 4], `${k} ${val} at ${x}`).toBeGreaterThanOrEqual(out.data[(x - 1) * 4]);
    }
    expect(dev(ramp, { shadows: 100 }).data[50 * 4]).toBeGreaterThan(60);
    expect(dev(ramp, { highlights: -100 }).data[210 * 4]).toBeLessThan(205);
    expect(dev(ramp, { contrast: 80 }).data[40 * 4]).toBeLessThan(40);
    expect(dev(ramp, { contrast: 80 }).data[220 * 4]).toBeGreaterThan(220);
    expect(dev(ramp, { shadows: 100 }).data[0]).toBe(0);
    expect(dev(ramp, { shadows: 100 }).data[255 * 4]).toBe(255);
  });
  it('temperature warms, saturation -100 is gray, vibrance boosts muted colors more', () => {
    const warm = dev(src, { temperature: 60 });
    expect(mean(warm, 0) - mean(warm, 2)).toBeGreaterThan(mean(src, 0) - mean(src, 2) + 5);
    const gray = dev(src, { saturation: -100 });
    for (let i = 0; i < gray.data.length; i += 4) {
      if (!gray.data[i + 3]) continue;
      expect(Math.abs(gray.data[i] - gray.data[i + 1])).toBeLessThanOrEqual(1);
      expect(Math.abs(gray.data[i] - gray.data[i + 2])).toBeLessThanOrEqual(1);
    }
    const muted = rgba8(2, 1);
    muted.data.set([140, 120, 120, 255, 250, 20, 20, 255]);
    const v = dev(muted, { vibrance: 100 });
    const chroma = (d: Uint8ClampedArray, o: number) => d[o] - d[o + 1];
    expect(chroma(v.data, 0) / chroma(muted.data, 0)).toBeGreaterThan(chroma(v.data, 4) / chroma(muted.data, 4));
  });
  it('clarity raises local contrast, dehaze deepens a hazy image, vignette darkens corners', () => {
    const soft = rgba8(64, 64);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) soft.data.set([110 + 30 * ((x >> 3) & 1), 120, 130, 255], (y * 64 + x) * 4);
    const c = dev(soft, { clarity: 100 });
    const span = (img: RGBA8) => img.data[(32 * 64 + 12) * 4] - img.data[(32 * 64 + 4) * 4];
    expect(Math.abs(span(c))).toBeGreaterThan(Math.abs(span(soft)));
    const hazy = rgba8(64, 64);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) hazy.data.set([170 + (x & 15), 175 + (y & 15), 180, 255], (y * 64 + x) * 4);
    expect(mean(dev(hazy, { dehaze: 80 }))).toBeLessThan(mean(hazy) - 10);
    expect(mean(dev(hazy, { dehaze: -80 }))).toBeGreaterThan(mean(hazy) - 1);
    const flat = rgba8(40, 40, [150, 150, 150, 255]);
    const vg = dev(flat, { vignette: -100 });
    expect(vg.data[0]).toBeLessThan(110);
    expect(vg.data[(20 * 40 + 20) * 4]).toBe(150);
  });
  it('grain is deterministic per seed and keeps the mean', () => {
    const flat = rgba8(64, 64, [128, 128, 128, 255]);
    const a = dev(flat, { grain: 50 }),
      b = dev(flat, { grain: 50 }),
      c = dev(flat, { grain: 50 }, { ...ctx, seed: 4 });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(Array.from(a.data)).not.toEqual(Array.from(c.data));
    expect(Math.abs(mean(a) - 128)).toBeLessThan(4);
  });
  it('spatial settings work on 1-pixel-wide images', () => {
    for (const [w, h] of [
      [1, 1],
      [1, 9],
      [7, 1],
    ]) {
      const out = dev(rgba8(w, h, [120, 130, 140, 255]), { dehaze: 50, clarity: 50, texture: 50, vignette: -20 });
      for (let i = 0; i < out.data.length; i += 4) expect(out.data[i + 1], `${w}x${h}`).toBeGreaterThan(40);
    }
  });
  it('respects selection and keeps alpha', () => {
    const sel = mask8(48, 32);
    for (let i = 0; i < 48 * 16; i++) sel.data[i] = 255;
    const out = dev(src, { exposure: 1 }, { ...ctx, selection: sel });
    expect(out.data[(20 * 48 + 10) * 4]).toBe(src.data[(20 * 48 + 10) * 4]);
    expect(out.data[(5 * 48 + 10) * 4]).toBeGreaterThan(src.data[(5 * 48 + 10) * 4]);
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(src.data[i]);
  });
});

describe('lens correction', () => {
  const src = photo(40, 30);
  it('neutral settings are the identity', () => {
    expect(maxDiff(lens(src, {}), src)).toBe(0);
    expect(maxDiff(lens(src, { vignetteMidpoint: 10, edge: 'background' }), src)).toBe(0);
    expect(maxDiff(lens(src, { distortion: 1e-6 }), src)).toBeLessThanOrEqual(1);
  });
  it('removing barrel distortion pulls from closer to the center', () => {
    // A radial ramp: barrel correction samples smaller radii, so corners get darker.
    const radial = rgba8(41, 41);
    for (let y = 0; y < 41; y++)
      for (let x = 0; x < 41; x++)
        (radial.data.fill(Math.min(255, Math.hypot(x - 20, y - 20) * 8), (y * 41 + x) * 4, (y * 41 + x) * 4 + 3),
          (radial.data[(y * 41 + x) * 4 + 3] = 255));
    const out = lens(radial, { distortion: 100 });
    expect(out.data[(2 * 41 + 2) * 4]).toBeLessThan(radial.data[(2 * 41 + 2) * 4] - 20);
    expect(out.data[(20 * 41 + 20) * 4]).toBe(radial.data[(20 * 41 + 20) * 4]);
  });
  it('chromatic aberration moves red but not green', () => {
    const out = lens(src, { caRedCyan: 100 });
    let dr = 0,
      dg = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      if (!out.data[i + 3] || !src.data[i + 3]) continue;
      dr += Math.abs(out.data[i] - src.data[i]);
      dg += Math.abs(out.data[i + 1] - src.data[i + 1]);
    }
    expect(dr).toBeGreaterThan(dg * 3);
    expect(dg).toBeLessThan(80);
  });
  it('vignette lightens corners, perspective and edge modes fill as asked', () => {
    const flat = rgba8(40, 40, [100, 100, 100, 255]);
    expect(lens(flat, { vignetteAmount: 100 }).data[0]).toBeGreaterThan(120);
    const t = lens(flat, { scale: 70, edge: 'transparent' });
    expect(t.data[3]).toBe(0);
    const b = lens(flat, { scale: 70, edge: 'background' });
    expect(Array.from(b.data.slice(0, 4))).toEqual([255, 255, 255, 255]);
    const e = lens(flat, { scale: 70, edge: 'edge-extension' });
    expect(Array.from(e.data.slice(0, 4))).toEqual([100, 100, 100, 255]);
    const v = lens(flat, { vertical: 50, edge: 'transparent' });
    expect(v.width).toBe(40);
    expect(v.data[(20 * 40 + 20) * 4 + 3]).toBe(255);
  });
});

describe('filtersB registry', () => {
  it('has unique ids, valid defaults and no third-party product names in labels', () => {
    const ids = filtersB.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of filtersB) {
      expect(op.label).not.toMatch(/smart/i);
      for (const p of op.params)
        if (p.type === 'number') {
          expect(p.default).toBeGreaterThanOrEqual(p.min);
          expect(p.default).toBeLessThanOrEqual(p.max);
        } else if (p.type === 'select') expect(p.options.map((o) => o.value)).toContain(p.default);
    }
  });
  it('every operation runs on odd sizes, 1x1 and transparent input, keeping dimensions', async () => {
    for (const op of filtersB)
      for (const img of [photo(13, 7), rgba8(1, 1, [50, 60, 70, 255]), rgba8(9, 5)]) {
        const p = { ...defaults(op) };
        if (op.id === 'develop') Object.assign(p, { exposure: 0.5, clarity: 30, dehaze: 20, grain: 10 });
        if (op.id === 'lens-correction') Object.assign(p, { distortion: 30, vertical: 10 });
        const out = await op.apply(img, p, ctx);
        expect([out.width, out.height], op.id).toEqual([img.width, img.height]);
        expect(out.data.length).toBe(img.data.length);
        expect(out.data).not.toBe(img.data);
      }
  });
  it('a selection with zero coverage leaves the image untouched for every operation', async () => {
    const img = photo(16, 12);
    for (const op of filtersB) {
      const p = { ...defaults(op) };
      if (op.id === 'develop') p.exposure = 1;
      if (op.id === 'lens-correction') p.distortion = 50;
      const out = await op.apply(img, p, { ...ctx, selection: mask8(16, 12) });
      expect(Array.from(out.data), op.id).toEqual(Array.from(img.data));
    }
  });
});
