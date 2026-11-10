import { describe, it, expect } from 'vitest';
import {
  Batch,
  SEG_FLOATS,
  SEG_STRIDE,
  TRI_FLOATS,
  TRI_STRIDE,
  F_HIGHLIGHT,
  JOIN_STEP,
} from '../src/render/batch.js';

const style = { rgb: [10, 20, 30], alpha: 1, lwIndex: 3, basePattern: [], ltscale: 1 };

describe('Batch', () => {
  it('packs one instance per segment with running dash distance', () => {
    const b = new Batch(() => 7, 2, 2);
    b.line([0, 0, 3, 4, 3, 10], false, style);
    expect(b.segCount).toBe(2);
    // Second segment starts 5 units along the path.
    expect(b.segF[SEG_FLOATS + 8]).toBe(5);
    const u = (b.segF.length && new Uint8Array(b.segBuf)) || null;
    expect([...u.subarray(40, 44)]).toEqual([10, 20, 30, 255]);
    expect(u[44]).toBe(3);
    expect(b.bounds).toEqual([0, 0, 3, 10]);
  });

  it('closes polylines and maps patterns to texture rows', () => {
    const pattern = [1, -1];
    const b = new Batch((p) => (p === pattern ? 5 : 0));
    b.line([0, 0, 1, 0, 1, 1], true, { ...style, basePattern: pattern });
    expect(b.segCount).toBe(3);
    expect(new Uint8Array(b.segBuf)[45]).toBe(5);
  });

  it('keeps full precision far from the origin with high/low parts', () => {
    const b = new Batch(() => 0);
    const x = 512345.6789;
    b.line([x, 0, x + 0.001, 0], false, style);
    const hi = b.segF[0],
      lo = b.segF[4];
    expect(hi + lo).toBeCloseTo(x, 9);
    expect(Math.abs(hi + lo - x)).toBeLessThan(1e-6);
  });

  it('grows its buffers as needed', () => {
    const b = new Batch(() => 0, 1, 1);
    const pts = [];
    for (let i = 0; i < 1000; i++) pts.push(i, 0);
    b.line(pts, false, style);
    expect(b.segCount).toBe(999);
    expect(b.segF[998 * SEG_FLOATS]).toBe(998);
  });

  it('triangulates fills, including holes', () => {
    const b = new Batch(() => 0);
    b.fill([[0, 0, 10, 0, 10, 10, 0, 10], [2, 2, 2, 8, 8, 8, 8, 2]], style);
    expect(b.vertCount % 3).toBe(0);
    // Area of the triangles equals the ring minus the hole.
    let area = 0;
    for (let i = 0; i < b.vertCount; i += 3) {
      const p = (k) => [b.triF[(i + k) * TRI_FLOATS] + b.triF[(i + k) * TRI_FLOATS + 2], b.triF[(i + k) * TRI_FLOATS + 1] + b.triF[(i + k) * TRI_FLOATS + 3]];
      const [a, c, d] = [p(0), p(1), p(2)];
      area += Math.abs((c[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (c[1] - a[1])) / 2;
    }
    expect(area).toBeCloseTo(64, 6);
  });

  it('writes independent segments in bulk and carries flags', () => {
    const b = new Batch(() => 0);
    b.flags = F_HIGHLIGHT;
    b.segs(new Float64Array([0, 0, 1, 0, 5, 5, 6, 6]), style);
    expect(b.segCount).toBe(2);
    expect(new Uint8Array(b.segBuf)[44] >> 5).toBe(F_HIGHLIGHT);
    expect(new Uint8Array(b.segBuf)[44] & 31).toBe(3);
    b.reset();
    expect(b.segCount).toBe(0);
    expect(b.bounds).toBeNull();
  });

  it('gives neighbouring polyline segments the same bisector at their joint', () => {
    const b = new Batch(() => 0);
    const joins = () => {
      const u = new Uint8Array(b.segBuf);
      return Array.from({ length: b.segCount }, (_, i) => [
        u[i * SEG_STRIDE + 46],
        u[i * SEG_STRIDE + 47],
      ]);
    };
    const angle = (code) => (code - 1) * JOIN_STEP;
    // Open path: free ends, a 90 degree left turn, then a 150 degree hairpin.
    b.line([0, 0, 10, 0, 10, 10, 9, 10 - Math.tan(Math.PI / 3)], false, style);
    let j = joins();
    expect(j[0][0]).toBe(0);
    expect(j[0][1]).toBe(j[1][0]);
    expect(angle(j[0][1])).toBeCloseTo(Math.PI / 4, 1);
    expect(j[1][1]).toBe(0);
    expect(j[2][0]).toBe(0);
    expect(j[2][1]).toBe(0);
    // Closed square: every joint is shared, including the closing one.
    b.reset();
    b.line([0, 0, 10, 0, 10, 10, 0, 10], true, style);
    j = joins();
    for (let i = 0; i < 4; i++) {
      expect(j[i][1]).toBeGreaterThan(0);
      expect(j[i][1]).toBe(j[(i + 1) % 4][0]);
    }
    // Straight continuation: the cut is perpendicular to the path.
    b.reset();
    b.line([0, 0, 0, 5, 0, 10], false, style);
    j = joins();
    expect(angle(j[0][1])).toBeCloseTo(Math.PI / 2, 1);
    // Independent segments and repeated points get square caps.
    b.reset();
    b.line([0, 0, 0, 0, 5, 0], false, style);
    b.segs(new Float64Array([0, 0, 1, 0, 1, 0, 2, 0]), style);
    expect(joins().flat()).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('gives back buffers grown far past their starting size', () => {
    const b = new Batch(() => 0, 4, 4);
    const small = b.segBuf;
    b.line([0, 0, 1, 0, 2, 0], false, style);
    b.shrink();
    expect(b.segBuf).toBe(small);
    expect(b.segCount).toBe(0);
    const pts = [];
    for (let i = 0; i < 100; i++) pts.push(i, 0);
    b.line(pts, false, style);
    b.fill([[0, 0, 10, 0, 10, 10, 0, 10], [2, 2, 2, 8, 8, 8, 8, 2]], style);
    for (let i = 0; i < 20; i++) b.fill([[0, 0, 10, 0, 10, 10, 0, 10]], style);
    expect(b.triBuf.byteLength).toBeGreaterThan(16 * 3 * TRI_STRIDE);
    expect(b.segBuf.byteLength).toBeGreaterThan(16 * SEG_STRIDE);
    // Kept while builds keep needing them (a repeated select-all).
    const grown = b.segBuf;
    b.shrink(1000);
    expect(b.segBuf).toBe(grown);
    expect(b.segCount + b.vertCount).toBe(0);
    b.line([0, 0, 1, 0], false, style);
    b.shrink(5000);
    expect(b.segBuf).toBe(grown);
    // Given back by the first build after they went unused for a while.
    b.line([0, 0, 1, 0], false, style);
    b.shrink(20000);
    expect(b.segBuf.byteLength).toBe(4 * SEG_STRIDE);
    expect(b.triBuf.byteLength).toBe(4 * 3 * TRI_STRIDE);
    expect(b.segCount + b.vertCount).toBe(0);
    b.line([0, 0, 1, 0], false, style);
    expect(b.segCount).toBe(1);
  });

  describe('long segments', () => {
    const ends = (b, i = 0) => {
      const o = i * SEG_FLOATS,
        F = b.segF;
      return [F[o] + F[o + 4], F[o + 1] + F[o + 5], F[o + 2] + F[o + 6], F[o + 3] + F[o + 7]];
    };
    const clipping = () => {
      const b = new Batch(() => 3);
      b.longLen = 1000;
      b.box = [-100, -100, 100, 100];
      return b;
    };

    it('are cut to the box around the view, keeping their place and dash phase', () => {
      const b = clipping();
      const pattern = [3, -1];
      // Passes through (7, 0) at 45 degrees.
      b.line([7 - 1e6, -1e6, 7 + 1e6, 1e6], false, { ...style, basePattern: pattern });
      expect(b.segCount).toBe(1);
      expect(b.clipped).toBe(true);
      const [x1, y1, x2, y2] = ends(b);
      expect(x1).toBeCloseTo(-93, 6);
      expect(y1).toBeCloseTo(-100, 6);
      expect(x2).toBeCloseTo(100, 6);
      expect(y2).toBeCloseTo(93, 6);
      // Dashes continue from the real start of the line.
      expect(b.segF[8]).toBeCloseTo(((1e6 - 100) * Math.SQRT2) % 4, 4);
      // The extents are still those of the whole line.
      expect(b.bounds).toEqual([7 - 1e6, -1e6, 7 + 1e6, 1e6]);
    });

    it('are left out when they miss the box, and short ones are untouched', () => {
      const b = clipping();
      b.line([-1e6, 500, 1e6, 500, 1e6, 495, 1e6 + 5, 495], false, style);
      expect(b.segCount).toBe(2);
      expect(ends(b, 0)).toEqual([1e6, 500, 1e6, 495]);
      expect(ends(b, 1)).toEqual([1e6, 495, 1e6 + 5, 495]);
      b.reset();
      expect(b.clipped).toBe(false);
      b.line([-500, 3, 400, 3], false, style);
      expect(ends(b)).toEqual([-500, 3, 400, 3]);
      expect(b.clipped).toBe(false);
    });

    it('lose the joint at a cut end only', () => {
      const b = clipping();
      b.line([-1e6, 0, 50, 0, 50, 20], false, style);
      const u = new Uint8Array(b.segBuf);
      expect(ends(b)).toEqual([-100, 0, 50, 0]);
      expect(u[46]).toBe(0);
      expect(u[47]).not.toBe(0);
      expect(u[SEG_STRIDE + 46]).toBe(u[47]);
    });

    it('are cut on the fast path for independent segments too', () => {
      const b = clipping();
      b.segs([-1e6, 5, 1e6, 5, 0, 0, 1, 1, -1e6, 500, 1e6, 500], style);
      expect(b.segCount).toBe(2);
      expect(ends(b, 0)).toEqual([-100, 5, 100, 5]);
      expect(ends(b, 1)).toEqual([0, 0, 1, 1]);
      expect(b.bounds).toEqual([-1e6, 0, 1e6, 500]);
    });
  });
});
