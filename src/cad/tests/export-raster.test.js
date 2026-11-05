import { describe, it, expect } from 'vitest';
import { RecordingSink } from '../src/core/display.js';
import {
  renderToCanvas,
  exportPng,
  pagePixels,
  pngSettings,
  MAX_PNG_SIDE,
} from '../src/io/export/raster.js';

/** A fake 2D context that records method calls and property writes. */
function fakeContext(width = 200, height = 100) {
  const calls = [];
  const state = { canvas: { width, height } };
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      return (...args) => calls.push([k, ...args]);
    },
    set(t, k, v) {
      calls.push(['set', k, v]);
      t[k] = v;
      return true;
    },
  });
  return { ctx, calls };
}

const black = { rgb: [255, 255, 255], aci7: true, lw: 25, pattern: [], id: 1, alpha: 1 };
const dashed = { rgb: [255, 0, 0], aci7: false, lw: 50, pattern: [12, -6], id: 2, alpha: 1 };
const solid = { rgb: [0, 0, 255], aci7: false, lw: 25, pattern: [], id: 3, alpha: 0.5 };

describe('renderToCanvas', () => {
  it('fits the drawing and batches same-style items into one stroke', () => {
    const s = new RecordingSink();
    s.line([0, 0, 10, 0], false, black);
    s.line([0, 5, 10, 5], false, black);
    const { ctx, calls } = fakeContext();
    const { scale } = renderToCanvas(ctx, s.items, { margin: 0, background: '#ffffff' });
    expect(scale).toBe(20);
    expect(calls).toContainEqual(['fillRect', 0, 0, 200, 100]);
    expect(calls).toContainEqual(['moveTo', 0, 100]);
    expect(calls).toContainEqual(['lineTo', 200, 100]);
    expect(calls).toContainEqual(['moveTo', 0, 0]);
    expect(calls.filter((c) => c[0] === 'stroke').length).toBe(1);
    expect(calls).toContainEqual(['set', 'strokeStyle', 'rgb(0,0,0)']);
    expect(calls).toContainEqual(['setLineDash', []]);
    expect(calls[0][0]).toBe('save');
    expect(calls[calls.length - 1][0]).toBe('restore');
  });

  it('uses line dashes, lineweights in pixels and even-odd fills', () => {
    const s = new RecordingSink();
    s.line([0, 0, 10, 0], false, dashed);
    s.fill([[0, 0, 10, 0, 10, 5, 0, 5], [2, 2, 3, 2, 3, 3, 2, 3]], solid);
    const { ctx, calls } = fakeContext();
    renderToCanvas(ctx, s.items, { margin: 0, dpi: 254 });
    expect(calls).toContainEqual(['setLineDash', [240, 120]]);
    const lw = calls.find((c) => c[0] === 'set' && c[1] === 'lineWidth');
    expect(lw[2]).toBeCloseTo(5, 9);
    expect(calls).toContainEqual(['fill', 'evenodd']);
    expect(calls).toContainEqual(['set', 'globalAlpha', 0.5]);
    expect(calls.filter((c) => c[0] === 'closePath').length).toBe(2);
  });

  it('lays out paper mode at the requested dpi with a clip', () => {
    const s = new RecordingSink();
    s.line([0, 0, 100, 0], false, black);
    const { ctx, calls } = fakeContext();
    const settings = { paper: 'A4', margins: 10, dpi: 25.4, center: false, scale: { paper: 1, drawing: 1 } };
    renderToCanvas(ctx, s.items, settings);
    expect(pagePixels(settings)).toEqual({ width: 210, height: 297 });
    expect(calls.some((c) => c[0] === 'clip')).toBe(true);
    const mv = calls.find((c) => c[0] === 'moveTo');
    expect(mv[1]).toBeCloseTo(10, 9);
    expect(mv[2]).toBeCloseTo(287, 9);
  });

  it('keeps PNG images within the largest canvas browsers accept', () => {
    // A tall drawing exported 2400 px wide would be 96000 px high.
    const tall = pngSettings({ width: 2400, height: 96000 });
    expect(tall.height).toBe(MAX_PNG_SIDE);
    expect(tall.width).toBe(Math.round((2400 * MAX_PNG_SIDE) / 96000));
    expect(pngSettings({ width: 800, height: 600 })).toMatchObject({ width: 800, height: 600 });
    const a0 = pngSettings({ paper: 'A0', dpi: 600 });
    const px = pagePixels(a0);
    expect(Math.max(px.width, px.height)).toBeLessThanOrEqual(MAX_PNG_SIDE);
    expect(pngSettings({ paper: 'A4', dpi: 200 }).dpi).toBe(200);
  });

  it('rejects PNG export without any canvas implementation', async () => {
    if (typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined') return;
    await expect(exportPng([], { width: 10, height: 10 })).rejects.toThrow(/canvas/);
  });
});
