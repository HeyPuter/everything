// Portrait & Restore algorithms on small synthetic images.
import { describe, expect, it } from 'vitest';
import type { Mask8, RGBA8 } from '../src/imaging/types';
import { blockiness, estimateGrid, removeJpegArtifacts } from '../src/imaging/restore/deblock';
import { coverage, detectDefects, halftonePeriod, inpaint, repairFade, restorePhoto } from '../src/imaging/restore/defects';
import { colorize } from '../src/imaging/restore/colorize';
import { depthBlur, estimateDepth, sharpness } from '../src/imaging/restore/depth';
import { colorTransfer, transferStats } from '../src/imaging/restore/transfer';
import { roughness, skinLikelihood, skinMask, smoothSkin } from '../src/imaging/restore/skin';
import { stylize } from '../src/imaging/restore/stylize';
import { lumaOf, rgb8ToLab, rng } from '../src/imaging/restore/util';

function image(w: number, h: number, f: (x: number, y: number) => [number, number, number]): RGBA8 {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}
const px = (img: RGBA8, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
function meanLab(img: RGBA8, mask?: (x: number, y: number) => boolean) {
  const s = [0, 0, 0], lab = [0, 0, 0];
  let c = 0;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      if (mask && !mask(x, y)) continue;
      const [r, g, b] = px(img, x, y);
      rgb8ToLab(r, g, b, lab);
      for (let k = 0; k < 3; k++) s[k] += lab[k];
      c++;
    }
  return s.map((v) => v / c);
}

describe('JPEG artifact removal', () => {
  // A smooth diagonal gradient reduced to 8x8 block averages (strong blocking),
  // with the grid shifted by (3, 5) as in a cropped JPEG.
  const W = 96, H = 80, ox = 3, oy = 5;
  const smooth = (x: number, y: number) => 60 + x * 1.1 + y * 0.8;
  const blocky = image(W, H, (x, y) => {
    const bx = Math.floor((x - ox) / 8) * 8 + ox + 3.5, by = Math.floor((y - oy) / 8) * 8 + oy + 3.5;
    const v = smooth(bx, by);
    return [v, v * 0.9, v * 0.8];
  });
  it('finds the block grid and measures blockiness', () => {
    const g = estimateGrid(lumaOf(blocky), W, H);
    expect(g.px).toBe(ox);
    expect(g.py).toBe(oy);
    expect(g.blockiness).toBeGreaterThan(2);
    const clean = image(W, H, (x, y) => [smooth(x, y), smooth(x, y), smooth(x, y)]);
    expect(blockiness(clean)).toBeLessThan(1.2);
  });
  it('deblocking reduces blockiness and moves toward the smooth original', () => {
    const before = blockiness(blocky);
    const { image: out } = removeJpegArtifacts(blocky, { strength: 'high' });
    expect(blockiness(out)).toBeLessThan(before * 0.6);
    let errBefore = 0, errAfter = 0;
    for (let y = 8; y < H - 8; y++)
      for (let x = 8; x < W - 8; x++) {
        errBefore += Math.abs(px(blocky, x, y)[0] - smooth(x, y));
        errAfter += Math.abs(px(out, x, y)[0] - smooth(x, y));
      }
    expect(errAfter).toBeLessThan(errBefore * 0.75);
  });
  it('keeps a real edge sharp', () => {
    const edge = image(64, 64, (x) => (x < 32 ? [40, 40, 40] : [220, 220, 220]));
    const { image: out } = removeJpegArtifacts(edge, { strength: 'high' });
    expect(px(out, 30, 20)[0]).toBeLessThan(60);
    expect(px(out, 33, 20)[0]).toBeGreaterThan(200);
  });
});

describe('photo restoration', () => {
  const W = 128, H = 128;
  const r = rng(3);
  const noisy = () => 128 + (r() + r() + r() - 1.5) * 6;
  const base = image(W, H, () => {
    const v = noisy();
    return [v, v, v];
  });
  // A dark one-pixel scratch and three white dust specks.
  const damaged = { width: W, height: H, data: new Uint8ClampedArray(base.data) };
  for (let y = 10; y < 118; y++) damaged.data.set([60, 60, 60], (y * W + 40) * 4);
  const specks = [
    [90, 30],
    [100, 80],
    [70, 100],
  ];
  for (const [sx, sy] of specks) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) damaged.data.set([250, 250, 250], ((sy + dy) * W + sx + dx) * 4);
  it('detects a synthetic scratch and dust specks but not the grain', () => {
    const m = detectDefects(damaged, { dust: 60, scratches: 60, size: 4 });
    let onLine = 0;
    for (let y = 10; y < 118; y++) if (m.data[y * W + 40]) onLine++;
    expect(onLine / 108).toBeGreaterThan(0.9);
    for (const [sx, sy] of specks) expect(m.data[sy * W + sx]).toBe(255);
    // Outside the defects (and their one-pixel margin) almost nothing is flagged.
    let fp = 0, total = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const nearLine = Math.abs(x - 40) <= 2 && y >= 8 && y < 120;
        const nearSpeck = specks.some(([sx, sy]) => Math.abs(x - sx - 0.5) <= 3 && Math.abs(y - sy - 0.5) <= 3);
        if (nearLine || nearSpeck) continue;
        total++;
        if (m.data[y * W + x]) fp++;
      }
    expect(fp / total).toBeLessThan(0.005);
    expect(detectDefects(base, { dust: 60, scratches: 60, size: 4 }).data.filter((v) => v).length).toBeLessThan(W * H * 0.003);
  });
  it('inpaints defects to match their surroundings', () => {
    const m = detectDefects(damaged, { dust: 60, scratches: 60, size: 4 });
    const out = inpaint(damaged, m);
    let err = 0;
    for (let y = 12; y < 116; y++) err += Math.abs(px(out, 40, y)[0] - 128);
    expect(err / 104).toBeLessThan(12);
    const res = restorePhoto(damaged, { dust: 60, scratches: 60, size: 4, denoise: 0, fade: 0, halftone: 0 });
    expect(coverage(res.defects)).toBeGreaterThan(0);
    expect(Math.abs(px(res.image, 40, 60)[0] - 128)).toBeLessThan(25);
  });
  it('repairs a faded, color-cast photo by stretching channels', () => {
    const faded = image(64, 64, (x, y) => [120 + x * 0.8, 110 + y * 0.6, 100 + (x + y) * 0.3]);
    const out = repairFade(faded, 100);
    const range = (img: RGBA8, c: number) => {
      let lo = 255, hi = 0;
      for (let i = c; i < img.data.length; i += 4) (lo = Math.min(lo, img.data[i])), (hi = Math.max(hi, img.data[i]));
      return hi - lo;
    };
    for (let c = 0; c < 3; c++) expect(range(out, c)).toBeGreaterThan(range(faded, c) * 2);
  });
  it('finds the period of a print screen', () => {
    const dots = image(160, 96, (x, y) => {
      const v = (x % 6 < 3) !== (y % 6 < 3) ? 40 : 220;
      return [v, v, v];
    });
    expect(halftonePeriod(dots)).toBeGreaterThanOrEqual(5);
    expect(halftonePeriod(dots)).toBeLessThanOrEqual(7);
  });
});

describe('colorize', () => {
  // Two regions of different tone separated by a strong edge.
  const W = 120, H = 80;
  const gray = image(W, H, (x) => (x < 60 ? [70, 70, 70] : [190, 190, 190]));
  it('spreads a hint color within its region and stops at the strong edge', () => {
    const { image: out, confidence } = colorize(gray, { hints: [{ x: 0.2, y: 0.5, color: '#d02020', radius: 3 }], saturation: 100, spread: 60, scale: 1 });
    // Far corner of the left region is red; the right region stays neutral.
    const l = px(out, 4, 6), rgt = px(out, 110, 40);
    expect(l[0] - l[1]).toBeGreaterThan(15);
    expect(Math.abs(rgt[0] - rgt[1])).toBeLessThan(4);
    expect(confidence.data[40 * W + 10]).toBeGreaterThan(200);
    expect(confidence.data[40 * W + 100]).toBeLessThan(40);
    // Luminance (L*) is kept.
    const before = meanLab(gray, (x) => x < 55), after = meanLab(out, (x) => x < 55);
    expect(Math.abs(after[0] - before[0])).toBeLessThan(2);
  });
  it('gives each region the color of its own hint', () => {
    const { image: out } = colorize(gray, {
      hints: [
        { x: 0.25, y: 0.5, color: '#2040d0', radius: 3 },
        { x: 0.75, y: 0.5, color: '#e0c020', radius: 3 },
      ],
      saturation: 100,
      spread: 60,
      scale: 1,
    });
    const l = px(out, 10, 10), r = px(out, 110, 70);
    expect(l[2]).toBeGreaterThan(l[0] + 10);
    expect(r[0]).toBeGreaterThan(r[2] + 15);
  });
  it('returns the image unchanged without hints', () => {
    const { image: out } = colorize(gray, { hints: [], saturation: 100, spread: 50, scale: 1 });
    expect(out.data).toEqual(gray.data);
  });
});

describe('depth blur', () => {
  // A checkerboard (sharp texture) everywhere; the bottom half is near.
  const W = 96, H = 96;
  const checker = image(W, H, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? [220, 210, 200] : [40, 50, 60]);
  const depth = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) depth[y * W + x] = y < H / 2 ? 1 : 0;
  const opts = { focal: 0, range: 0.1, blur: 8, scale: 1, blades: 6, brightness: 0, haze: 0, warmth: 0, grain: 0 };
  it('keeps the focal plane sharp and blurs what is far from it', () => {
    const out = depthBlur(checker, depth, opts);
    const nearBefore = sharpness(checker, 8, 60, 88, 90), nearAfter = sharpness(out, 8, 60, 88, 90);
    const farBefore = sharpness(checker, 8, 6, 88, 36), farAfter = sharpness(out, 8, 6, 88, 36);
    expect(nearAfter).toBeGreaterThan(nearBefore * 0.9);
    expect(farAfter).toBeLessThan(farBefore * 0.35);
  });
  it('estimates a depth map with the ground near and the top far', () => {
    const scene = image(80, 60, (_x, y) => (y < 30 ? [170 + y, 190 + y, 215] : [90 - (y - 30), 110 - (y - 30), 70]));
    const d = estimateDepth(scene, { subject: false });
    expect(d.length).toBe(80 * 60);
    expect(d[5 * 80 + 40]).toBeGreaterThan(d[55 * 80 + 40]);
  });
});

describe('color transfer', () => {
  const r = rng(9);
  const src = image(64, 64, (x, y) => {
    const v = 60 + x * 2 + (r() - 0.5) * 20;
    return [v, v + (y % 7), v - 4];
  });
  const ref = image(64, 64, (x) => [150 + x, 120 + x * 0.6, 40 + x * 0.3]);
  it('moves the color statistics toward the reference and keeps luminance', () => {
    const out = colorTransfer(src, transferStats(ref), { strength: 100, preserveLuminance: true, shadows: 100, midtones: 100, highlights: 100 });
    const s = meanLab(src), t = meanLab(ref), o = meanLab(out);
    expect(Math.abs(o[2] - t[2])).toBeLessThan(Math.abs(s[2] - t[2]) * 0.4);
    expect(Math.abs(o[1] - t[1])).toBeLessThan(Math.abs(s[1] - t[1]) * 0.5 + 1);
    expect(Math.abs(o[0] - s[0])).toBeLessThan(1.5);
  });
  it('does nothing at zero strength and weights regions', () => {
    const none = colorTransfer(src, transferStats(ref), { strength: 0, preserveLuminance: true, shadows: 100, midtones: 100, highlights: 100 });
    for (let i = 0; i < src.data.length; i++) expect(Math.abs(none.data[i] - src.data[i])).toBeLessThanOrEqual(2);
    const shadowsOnly = colorTransfer(src, transferStats(ref), { strength: 100, preserveLuminance: true, shadows: 100, midtones: 0, highlights: 0 });
    const full = colorTransfer(src, transferStats(ref), { strength: 100, preserveLuminance: true, shadows: 100, midtones: 100, highlights: 100 });
    const shift = (img: RGBA8) => Math.abs(meanLab(img)[2] - meanLab(src)[2]);
    expect(shift(shadowsOnly)).toBeLessThan(shift(full));
  });
});

describe('skin smoothing', () => {
  // A skin-toned ellipse with blotches on a blue background.
  const W = 120, H = 100;
  const r = rng(5);
  const inside = (x: number, y: number) => ((x - 60) / 34) ** 2 + ((y - 50) / 40) ** 2 < 1;
  const img = image(W, H, (x, y) => {
    if (!inside(x, y)) return [60, 110, 180];
    const blotch = Math.sin(x * 0.35) * Math.cos(y * 0.3) * 10 + (r() - 0.5) * 8;
    return [222 + blotch, 172 + blotch, 142 + blotch];
  });
  it('detects skin tones and not the background', () => {
    const p = skinLikelihood(img);
    expect(p[50 * W + 60]).toBeGreaterThan(0.7);
    expect(p[5 * W + 5]).toBeLessThan(0.05);
    const m: Mask8 = skinMask(img, { tolerance: 50 });
    let inSum = 0, inN = 0, outSum = 0, outN = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const v = m.data[y * W + x];
        const deep = ((x - 60) / 30) ** 2 + ((y - 50) / 36) ** 2 < 1, far = ((x - 60) / 40) ** 2 + ((y - 50) / 46) ** 2 > 1;
        if (deep) (inSum += v), inN++;
        else if (far) (outSum += v), outN++;
      }
    expect(inSum / inN).toBeGreaterThan(180);
    expect(outSum / outN).toBeLessThan(25);
  });
  it('smooths blotches while the detail setting keeps fine texture', () => {
    const m = skinMask(img, { tolerance: 50 });
    const soft = smoothSkin(img, { smoothness: 100, detail: 0, tone: 50, scale: 60 });
    const textured = smoothSkin(img, { smoothness: 100, detail: 100, tone: 50, scale: 60 });
    const r0 = roughness(img, m), r1 = roughness(soft, m), r2 = roughness(textured, m);
    expect(r1).toBeLessThan(r0 * 0.6);
    expect(r2).toBeGreaterThan(r1);
    // The background edge stays where it was.
    expect(px(soft, 5, 50)[2]).toBeGreaterThan(160);
  });
});

describe('creative styles', () => {
  const img = image(48, 40, (x, y) => [x * 5, y * 6, 120 + ((x * y) % 50)]);
  for (const style of ['painterly', 'ink', 'pencil', 'watercolor', 'print'] as const)
    it(`${style} renders a same-size, different image deterministically`, () => {
      const a = stylize(img, { style, brush: 4, scale: 1 });
      const b = stylize(img, { style, brush: 4, scale: 1 });
      expect(a.width).toBe(48);
      expect(a.height).toBe(40);
      expect(a.data).toEqual(b.data);
      let diff = 0;
      for (let i = 0; i < a.data.length; i++) diff += Math.abs(a.data[i] - img.data[i]);
      expect(diff / a.data.length).toBeGreaterThan(3);
    });
});
