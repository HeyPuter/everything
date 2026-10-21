import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real model needs WebAssembly and a canvas; the panel only needs its state.
vi.mock('../src/media/segmenter.js', () => {
  let state = 'idle';
  const listeners = new Set();
  return {
    SEG_SIZE: 256,
    segment: () => null,
    ready: vi.fn(() => {
      state = 'loading';
      for (const fn of listeners) fn(state);
      return Promise.resolve(false);
    }),
    segmenterState: () => state,
    segmenterError: () => 'nope',
    // Tests: the model download failed.
    failLoad: () => {
      state = 'failed';
      for (const fn of listeners) fn(state);
    },
    onSegmenterChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
});

import { CUTOUT_DEFAULT, normalizeCutout, normalizeStrokes, strokeOverride, applyOverride, matteWindow, steadyMatte } from '../src/model/cutout.js';
import { normalizeClip, makeClip, createProject } from '../src/model/project.js';
import { captureAttributes, applyAttributes, attributeGroupsFor } from '../src/ui/organize-actions.js';
import { usesCutout } from '../src/engine/cutout.js';
import { LAYER_FS } from '../src/engine/shaders.js';
import { evaluate } from '../src/engine/scene.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import * as T from '../src/model/timeline.js';
import { US } from '../src/lib/time.js';

describe('cutout model', () => {
  it('normalizes settings and clamps them', () => {
    expect(normalizeCutout({})).toEqual(CUTOUT_DEFAULT);
    expect(normalizeCutout({ feather: 400, shrink: -90, smooth: 'x' })).toEqual({ feather: 100, shrink: -50, smooth: CUTOUT_DEFAULT.smooth });
  });

  it('keeps the field on video and image clips through a save', () => {
    const v = normalizeClip({ ...makeClip('video', { assetId: 'a', duration: US }), cutout: { feather: 10, shrink: 5, smooth: 0 } });
    expect(v.cutout).toEqual({ feather: 10, shrink: 5, smooth: 0 });
    const plain = normalizeClip(makeClip('image', { assetId: 'a', duration: US }));
    expect('cutout' in plain).toBe(false);
  });

  it('turns feather and shrink into a matte window', () => {
    const [lo, hi] = matteWindow({ feather: 0, shrink: 0 });
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
    expect(hi - lo).toBeLessThan(0.05);
    const [wl, wh] = matteWindow({ feather: 100, shrink: 0 });
    expect(wh - wl).toBeGreaterThan(0.5);
    // Shrinking needs more confidence to keep a pixel.
    expect(matteWindow({ feather: 20, shrink: 40 })[0]).toBeGreaterThan(matteWindow({ feather: 20, shrink: -40 })[0]);
    for (const c of [{ feather: 100, shrink: 50 }, { feather: 100, shrink: -50 }]) {
      const [a, b] = matteWindow(c);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
      expect(b).toBeGreaterThan(a);
    }
  });

  it('steadies small flicker but lets real motion through', () => {
    const prev = new Uint8ClampedArray([100, 0, 255]);
    const next = steadyMatte(new Uint8ClampedArray([110, 255, 250]), prev, 80);
    expect(next[0]).toBeGreaterThan(100);
    expect(next[0]).toBeLessThan(110);
    expect(next[1]).toBe(255); // a jump from 0 to 255 is motion, not noise
    expect(steadyMatte(new Uint8ClampedArray([110]), new Uint8ClampedArray([100]), 0)[0]).toBe(110);
    expect(steadyMatte(new Uint8ClampedArray([110]), null, 80)[0]).toBe(110);
  });

  it('keeps valid brush strokes only', () => {
    expect(normalizeCutout({ strokes: [] })).toEqual(CUTOUT_DEFAULT);
    const s = normalizeStrokes([{ keep: 1, size: 9, pts: [[0.123456, 2], ['x', 0], [-1, 0.5]] }, { pts: [] }, null, { size: 0.1 }]);
    expect(s).toEqual([{ keep: true, size: 0.5, pts: [[0.1235, 1], [0, 0.5]] }]);
    expect(normalizeCutout({ strokes: s }).strokes).toEqual(s);
  });

  it('paints strokes into an override map, later strokes winning', () => {
    const W = 64;
    const ov = strokeOverride([{ keep: false, size: 0.25, pts: [[0.5, 0.5]] }], W, W, 1);
    const at = (o, u, v) => o[Math.floor(v * W) * W + Math.floor(u * W)];
    expect(at(ov, 0.5, 0.5)).toBe(-1);
    expect(at(ov, 0.1, 0.1)).toBe(0);
    // A line of keep across the middle overrides the remove dot.
    const both = strokeOverride([{ keep: false, size: 0.25, pts: [[0.5, 0.5]] }, { keep: true, size: 0.1, pts: [[0.1, 0.5], [0.9, 0.5]] }], W, W, 1);
    expect(at(both, 0.5, 0.5)).toBe(1);
    expect(at(both, 0.3, 0.5)).toBe(1);
    expect(at(both, 0.5, 0.4)).toBe(-1);
    // Wide frames squeeze the brush horizontally in the stretched map.
    const wide = strokeOverride([{ keep: true, size: 0.5, pts: [[0.5, 0.5]] }], W, W, 2);
    const span = (o, row) => [...o.subarray(row * W, row * W + W)].filter((v) => v > 0.5).length;
    expect(span(wide, W / 2)).toBeLessThan(span(strokeOverride([{ keep: true, size: 0.5, pts: [[0.5, 0.5]] }], W, W, 1), W / 2) * 0.6);
  });

  it('applies the override to matte values', () => {
    const data = new Uint8ClampedArray([0, 200, 100, 100]);
    applyOverride(data, new Float32Array([1, -1, 0.5, 0]));
    expect([...data]).toEqual([255, 0, 178, 100]);
  });

  it('is copied as its own attribute group', () => {
    const src = makeClip('video', { assetId: 'a', duration: US });
    src.cutout = { feather: 5, shrink: 10, smooth: 20 };
    expect(attributeGroupsFor(src).map((g) => g.id)).toContain('cutout');
    const dst = makeClip('image', { assetId: 'b', duration: US });
    applyAttributes(dst, captureAttributes(src), ['cutout'], src.duration);
    expect(dst.cutout).toEqual(src.cutout);
    expect(dst.cutout).not.toBe(src.cutout);
  });

  it('reaches the layer and tells the exporter to load the model', () => {
    const p = createProject();
    p.assets.a = { id: 'a', kind: 'video', name: 'v.mp4', duration: 5 * US, width: 640, height: 360, fps: 30, hasVideo: true };
    const c = makeClip('video', { assetId: 'a', duration: 2 * US });
    T.mainTrack(p).clips.push(c);
    expect(usesCutout(p)).toBe(false);
    c.cutout = { ...CUTOUT_DEFAULT };
    expect(usesCutout(p)).toBe(true);
    const layer = evaluate(p, US / 2).find((l) => l.clip?.id === c.id);
    expect(layer.cutout).toEqual(CUTOUT_DEFAULT);
    c.disabled = true;
    expect(usesCutout(p)).toBe(false);
  });

  it('applies the matte in the layer shader', () => {
    expect(LAYER_FS).toMatch(/uniform sampler2D u_matteTex/);
    expect(LAYER_FS).toMatch(/\* cut;/);
  });
});

describe('cutout panel', () => {
  let env;
  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
    const p = createProject();
    p.assets.a = { id: 'a', kind: 'video', name: 'v.mp4', duration: 5 * US, width: 640, height: 360, fps: 30, hasVideo: true, hasAudio: false };
    const c = makeClip('video', { assetId: 'a', duration: 2 * US });
    T.mainTrack(p).clips.push(c);
    const store = new EditorStore(p);
    const ctx = { store };
    ctx.actions = createActions(ctx);
    const insp = createInspector(ctx);
    document.body.append(insp.el);
    store.select(c.id);
    env = { store, el: insp.el, id: c.id };
  });
  afterEach(() => env.el.remove());

  const tab = (name) => [...env.el.querySelectorAll('[role=tab]')].find((t) => t.textContent === name);
  const clip = () => T.findClip(env.store.project, env.id).clip;

  it('turns background removal on and off with undo, and remembers settings', async () => {
    tab('Cutout').click();
    const sw = env.el.querySelector('.video-tab [role=switch], .video-tab input[type=checkbox]');
    expect(sw).toBeTruthy();
    const slider = () => [...env.el.querySelectorAll('.field')].find((f) => f.querySelector('.field-label')?.textContent === 'Edge softness').querySelector('input[type=range]');
    expect(slider().disabled).toBe(true);
    sw.click();
    expect(clip().cutout).toEqual(CUTOUT_DEFAULT);
    expect(slider().disabled).toBe(false);
    const { ready } = await import('../src/media/segmenter.js');
    expect(ready).toHaveBeenCalled();
    expect(env.el.querySelector('.cutout-status').textContent).toMatch(/ready/);
    const s = slider();
    s.value = '70';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    expect(clip().cutout.feather).toBe(70);
    sw.click();
    expect(clip().cutout).toBeUndefined();
    sw.click();
    expect(clip().cutout.feather).toBe(70);
    env.store.undo();
    expect(clip().cutout).toBeUndefined();
  });

  it('offers Try again when background removal could not load', async () => {
    tab('Cutout').click();
    env.el.querySelector('.video-tab [role=switch], .video-tab input[type=checkbox]').click();
    const seg = await import('../src/media/segmenter.js');
    const again = () => [...env.el.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
    expect(again().hidden).toBe(true);
    seg.failLoad();
    expect(env.el.querySelector('.cutout-status').textContent).toBe('nope');
    expect(again().hidden).toBe(false);
    seg.ready.mockClear();
    again().click();
    expect(seg.ready).toHaveBeenCalledWith({ retry: true });
    expect(env.el.querySelector('.cutout-status').textContent).toMatch(/ready/);
    expect(again().hidden).toBe(true);
  });

  it('shows and clears brush fixes', () => {
    env.store.update('x', (p) => {
      T.findClip(p, env.id).clip.cutout = { ...CUTOUT_DEFAULT, strokes: [{ keep: true, size: 0.1, pts: [[0.5, 0.5]] }, { keep: false, size: 0.1, pts: [[0.2, 0.2]] }] };
    });
    tab('Cutout').click();
    expect(env.el.querySelector('.cutout-fixes').textContent).toBe('2 fixes');
    const clear = [...env.el.querySelectorAll('button')].find((b) => b.textContent === 'Clear fixes');
    expect(clear.hidden).toBe(false);
    clear.click();
    expect(clip().cutout.strokes).toBeUndefined();
    expect(clip().cutout.feather).toBe(CUTOUT_DEFAULT.feather);
    expect(env.el.querySelector('.cutout-fixes').textContent).toBe('');
  });

  it('Remove background toggles the selected clips and opens the Cutout tab', () => {
    const ctx = { store: env.store };
    ctx.actions = createActions(ctx);
    ctx.inspector = { showVideoSub: vi.fn() };
    expect(ctx.actions.removeBackground()).toBe(true);
    expect(clip().cutout).toEqual(CUTOUT_DEFAULT);
    expect(ctx.inspector.showVideoSub).toHaveBeenCalledWith('cutout');
    ctx.actions.removeBackground();
    expect(clip().cutout).toBeUndefined();
    env.store.clearSelection();
    expect(ctx.actions.removeBackground()).toBe(false);
  });

  it('opens on the Cutout sub-tab when asked', () => {
    const ctx = { store: env.store };
    ctx.actions = createActions(ctx);
    const insp = createInspector(ctx);
    document.body.append(insp.el);
    insp.showVideoSub('cutout');
    const sel = [...insp.el.querySelectorAll('.video-tab .subtabs [role=tab]')].find((t) => t.getAttribute('aria-selected') === 'true');
    expect(sel.textContent).toBe('Cutout');
    insp.el.remove();
  });
});
