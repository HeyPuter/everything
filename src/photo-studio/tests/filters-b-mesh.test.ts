import { describe, expect, it } from 'vitest';
import { rgba8, type RGBA8 } from '../src/imaging/types';
import { evalMesh, identityGrid, meshWarp, warpPreset, WARP_STYLES, type MeshGrid } from '../src/imaging/filters/mesh';

function img(w: number, h: number): RGBA8 {
  const out = rgba8(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      out.data.set([(x * 9) & 255, (y * 17) & 255, ((x + y) * 5) & 255, 255], (y * w + x) * 4);
  return out;
}
const rect = { x: 0, y: 0, width: 30, height: 20 };

describe('mesh warp', () => {
  it('identity grids reproduce the image in place for every mode', () => {
    const src = img(30, 20);
    for (const [c, r, mode] of [
      [4, 4, 'bezier'],
      [7, 4, 'bezier'],
      [5, 3, 'smooth'],
      [3, 3, 'bilinear'],
    ] as const) {
      const { image, rect: placed } = meshWarp(src, identityGrid(rect, c, r, mode), 'bilinear');
      expect(placed).toEqual(rect);
      let m = 0;
      for (let i = 0; i < src.data.length; i++) m = Math.max(m, Math.abs(image.data[i] - src.data[i]));
      expect(m, `${c}x${r} ${mode}`).toBeLessThanOrEqual(1);
    }
  });
  it('a translated and scaled grid places the result accordingly', () => {
    const src = img(30, 20);
    const { image, rect: placed } = meshWarp(src, identityGrid({ x: 10, y: 5, width: 60, height: 40 }), 'bilinear');
    expect(placed).toEqual({ x: 10, y: 5, width: 60, height: 40 });
    // Output pixel (2x+1, 2y+1) center maps to source (x + 0.75, y + 0.75).
    expect(image.data[(21 * 60 + 21) * 4 + 3]).toBe(255);
    expect(Math.abs(image.data[(21 * 60 + 41) * 4] - src.data[(10 * 30 + 20) * 4])).toBeLessThan(12);
  });
  it('every preset with bend 0 is the identity grid', () => {
    const id = identityGrid(rect);
    for (const { value } of WARP_STYLES) {
      const g = warpPreset(value, 0, 0, 0, rect);
      for (let i = 0; i < 32; i++) expect(g.points[i], value).toBeCloseTo(id.points[i], 9);
    }
  });
  it('presets interpolate their shape at the fitting points and deform the image', () => {
    const src = img(30, 20);
    for (const { value } of WARP_STYLES) {
      const g = warpPreset(value, 0.5, 0, 0, rect);
      const { image } = meshWarp(src, g, 'bilinear');
      expect(image.width * image.height, value).toBeGreaterThan(0);
      const id = identityGrid(rect);
      let moved = 0;
      for (let i = 0; i < 32; i++) moved = Math.max(moved, Math.abs(g.points[i] - id.points[i]));
      expect(moved, value).toBeGreaterThan(0.5);
    }
    // Bulge at the top-middle moves up by bend * H / 4 at u = 1/3.
    const bulge = warpPreset('bulge', 1, 0, 0, rect);
    const p = evalMesh(bulge, 1 / 3, 0);
    expect(p[1]).toBeCloseTo(-(20 / 4) * (1 - (2 / 3 - 1) ** 2), 6);
  });
  it('arc keeps the central column and length', () => {
    const g = warpPreset('arc', 0.5, 0, 0, rect);
    // Exact at the fitting points (thirds), close in between.
    const top = evalMesh(g, 1 / 3, 0),
      bottom = evalMesh(g, 1 / 3, 1);
    expect(Math.hypot(bottom[0] - top[0], bottom[1] - top[1])).toBeCloseTo(20, 6);
    const mt = evalMesh(g, 0.5, 0),
      mb = evalMesh(g, 0.5, 1);
    expect(mt[0]).toBeCloseTo(15, 6);
    expect(mb[1] - mt[1]).toBeCloseTo(20, 1);
  });
  it('horizontal distortion tapers the sides', () => {
    const g = warpPreset('arc', 0, 0.5, 0, rect);
    const lt = evalMesh(g, 0, 0),
      lb = evalMesh(g, 0, 1),
      rt = evalMesh(g, 1, 0),
      rb = evalMesh(g, 1, 1);
    expect(lb[1] - lt[1]).toBeLessThan(rb[1] - rt[1]);
  });
  it('prefilters a warp that reduces the image instead of aliasing (except drafts)', () => {
    const src = rgba8(256, 256);
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++)
        src.data.set((x + y) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 256 + x) * 4);
    const worst = (draft: boolean) => {
      const r = meshWarp(src, identityGrid({ x: 0, y: 0, width: 70, height: 70 }), 'bicubic', {
        draft,
      });
      let w = 0;
      for (let y = 2; y < 68; y++)
        for (let x = 2; x < 68; x++) w = Math.max(w, Math.abs(r.image.data[(y * 70 + x) * 4] - 128));
      return w;
    };
    expect(worst(false)).toBeLessThanOrEqual(12);
    expect(worst(true)).toBeGreaterThan(60);
  });
  it('produces transparent antialiased edges for a rotated quad', () => {
    const src = rgba8(20, 20, [255, 0, 0, 255]);
    const P = new Float64Array(8);
    const c = Math.cos(0.4),
      s = Math.sin(0.4);
    [
      [0, 0],
      [20, 0],
      [0, 20],
      [20, 20],
    ].forEach(([x, y], k) => {
      P[k * 2] = 30 + (x - 10) * c - (y - 10) * s;
      P[k * 2 + 1] = 30 + (x - 10) * s + (y - 10) * c;
    });
    const g: MeshGrid = { cols: 2, rows: 2, points: P, mode: 'bilinear' };
    const { image } = meshWarp(src, g, 'bilinear');
    let partial = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i + 3] > 0) expect(image.data[i]).toBe(255);
      if (image.data[i + 3] > 0 && image.data[i + 3] < 255) partial++;
    }
    expect(partial).toBeGreaterThan(20);
  });
});
