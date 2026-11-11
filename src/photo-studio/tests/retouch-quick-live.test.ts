import { describe, expect, it } from 'vitest';
import { rgba8 } from '../src/imaging/types';
import { QuickSelector, quickSelect } from '../src/imaging/segment/quick-select';
import { LiveWire } from '../src/imaging/segment/live-wire';
import { rasterizeRect } from '../src/imaging/segment/mask-ops';
import { disk, diskTruth, iou } from './retouch-fixtures';

describe('quick selection', () => {
  it('grows within a region and stops at a contrasting boundary', () => {
    const w = 300, h = 200, img = disk(w, h, 150, 100, 60, [220, 190, 60], [40, 80, 130], 12);
    const m = quickSelect(img, [{ points: [[140, 95], [160, 105]], positive: true }], undefined, 10);
    expect(iou(m, diskTruth(w, h, 150, 100, 60))).toBeGreaterThan(0.95);
    expect(m.data[100 * w + 150]).toBe(255);
    expect(m.data[100 * w + 220]).toBe(0);
  });
  it('a stroke on the background selects the background but not the disk', () => {
    const w = 240, h = 160, img = disk(w, h, 120, 80, 40, [230, 230, 230], [30, 30, 30], 8);
    const m = quickSelect(img, [{ points: [[20, 20], [60, 30]], positive: true }], undefined, 12);
    expect(m.data[80 * w + 120]).toBe(0);
    expect(m.data[150 * w + 230]).toBe(255);
  });
  it('a negative stroke removes only the touched region; a positive stroke never removes', () => {
    const w = 200, h = 100, img = rgba8(w, h, [200, 40, 40, 255]);
    for (let y = 0; y < h; y++) for (let x = 100; x < w; x++) img.data.set([40, 40, 200, 255], (y * w + x) * 4);
    const all = rasterizeRect(0, 0, w, h, w, h);
    const qs = new QuickSelector(img);
    const removed = qs.update([{ points: [[150, 50]], positive: false }], all, 10);
    expect(removed.data[50 * w + 150]).toBe(0);
    expect(removed.data[50 * w + 190]).toBe(0);
    expect(removed.data[50 * w + 50]).toBe(255);
    const added = qs.update([{ points: [[150, 50]], positive: true }], removed, 10);
    expect(added.data[50 * w + 50]).toBe(255);
    expect(added.data[50 * w + 150]).toBe(255);
    // No strokes: unchanged copy.
    expect([...qs.update([], removed, 10).data]).toEqual([...removed.data]);
  });
  it('a stroke that misses the image leaves the selection as it was', () => {
    const w = 64, h = 48, img = rgba8(w, h, [100, 100, 100, 255]);
    for (let y = 0; y < h; y++) for (let x = 32; x < w; x++) img.data.set([200, 50, 50, 255], (y * w + x) * 4);
    const qs = new QuickSelector(img);
    const top = rasterizeRect(0, 0, w, 10, w, h);
    for (const positive of [true, false]) {
      const out = qs.update([{ points: [[-100, -100], [-90, -95]], positive }], top, 10);
      expect([...out.data]).toEqual([...top.data]);
      expect(qs.update([{ points: [[w + 50, 20]], positive }], undefined, 10).data.some((v) => v > 0)).toBe(false);
    }
  });
  it('is interactive on a 2000x1500 image', () => {
    const w = 2000, h = 1500, img = disk(w, h, 1000, 750, 400, [210, 120, 70], [60, 90, 140], 20);
    const t0 = performance.now();
    const qs = new QuickSelector(img);
    const t1 = performance.now();
    let m = qs.update([{ points: [[900, 700], [1100, 760]], positive: true }], undefined, 40);
    const t2 = performance.now();
    m = qs.update([{ points: [[200, 200], [300, 260]], positive: true }], m, 40);
    const t3 = performance.now();
    process.stderr.write(`\n[timing] quickSelect 2000x1500: setup ${(t1 - t0).toFixed(0)} ms, stroke ${(t2 - t1).toFixed(0)} ms, second stroke ${(t3 - t2).toFixed(0)} ms\n`);
    expect(m.data[750 * w + 1000]).toBe(255);
    // Generous bound: the target is ~100 ms, but test machines may be loaded.
    expect(t2 - t1).toBeLessThan(1500);
  }, 60000);
});

describe('live wire', () => {
  it('follows a strong vertical edge instead of the straight line', () => {
    const w = 100, h = 100, img = rgba8(w, h);
    let s = 1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const edge = 50 + Math.round(10 * Math.sin(y / 12));
        const v = (x < edge ? 60 : 190) + (s % 31) - 15;
        img.data.set([v, v, v, 255], (y * w + x) * 4);
      }
    const lw = new LiveWire(img);
    const sy = 5, ty = 95;
    const ex = (y: number) => 50 + Math.round(10 * Math.sin(y / 12));
    lw.setSeed(ex(sy), sy);
    const path = lw.pathTo(ex(ty), ty);
    expect(path[0]).toEqual([ex(sy), sy]);
    expect(path[path.length - 1]).toEqual([ex(ty), ty]);
    let off = 0;
    for (const [x, y] of path) off = Math.max(off, Math.min(Math.abs(x - ex(y)), Math.abs(x - (ex(y) - 1))));
    expect(off).toBeLessThanOrEqual(1);
    // Path is 8-connected.
    for (let i = 1; i < path.length; i++) expect(Math.max(Math.abs(path[i][0] - path[i - 1][0]), Math.abs(path[i][1] - path[i - 1][1]))).toBe(1);
  });
  it('snaps to the strongest nearby edge and handles targets outside the window', () => {
    const img = rgba8(400, 50, [0, 0, 0, 255]);
    for (let y = 0; y < 50; y++) for (let x = 200; x < 400; x++) img.data.set([255, 255, 255, 255], (y * 400 + x) * 4);
    const lw = new LiveWire(img, { window: 20 });
    const [sx] = lw.snap(195, 25, 8);
    expect(sx === 199 || sx === 200).toBe(true);
    lw.setSeed(10, 10);
    const p = lw.pathTo(390, 40);
    expect(p[p.length - 1]).toEqual([390, 40]);
    expect(p[0]).toEqual([10, 10]);
  });
  it('pathTo is fast for typical windows on a large image', () => {
    const w = 2000, h = 1500, img = disk(w, h, 1000, 750, 400, [200, 200, 200], [50, 50, 50], 30);
    const t0 = performance.now();
    const lw = new LiveWire(img);
    const t1 = performance.now();
    lw.setSeed(600, 750);
    const t2 = performance.now();
    let worst = 0;
    // Simulate mouse moves along the circle.
    for (let a = 0.05; a <= 0.6; a += 0.05) {
      const s = performance.now();
      const p = lw.pathTo(1000 - 400 * Math.cos(a), 750 - 400 * Math.sin(a));
      worst = Math.max(worst, performance.now() - s);
      expect(p.length).toBeGreaterThan(1);
    }
    process.stderr.write(`\n[timing] LiveWire 2000x1500: constructor ${(t1 - t0).toFixed(0)} ms, first setSeed ${(t2 - t1).toFixed(0)} ms, worst pathTo ${worst.toFixed(1)} ms (up to ~240 px away)\n`);
    expect(worst).toBeLessThan(500);
  }, 60000);
});
