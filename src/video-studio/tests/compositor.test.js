import { describe, it, expect, vi } from 'vitest';
import { gradeParams, Compositor } from '../src/engine/compositor.js';
import { DEFAULT_ADJUST } from '../src/model/project.js';
import { effectPass } from '../src/engine/fx-render.js';
import { EFFECT_SHADERS, TRANSITION_SHADERS, GRADE_FS } from '../src/engine/shaders.js';

describe('gradeParams', () => {
  it('is neutral with no adjustments and no filter', () => {
    const g = gradeParams(null, null);
    for (const k of Object.keys(DEFAULT_ADJUST)) expect(g[k]).toBe(0);
    expect(g).toMatchObject({ mono: 0, splitAmount: 0, shadowTint: [0, 0, 0], highlightTint: [1, 1, 1] });
  });

  it('passes color adjustment values through', () => {
    const g = gradeParams({ ...DEFAULT_ADJUST, brightness: 20, contrast: -10, sharpen: 5 }, null);
    expect(g).toMatchObject({ brightness: 20, contrast: -10, sharpen: 5, saturation: 0 });
  });

  it('adds the filter on top of the color adjustments, scaled by intensity', () => {
    // vivid: saturation 30, contrast 12, brightness 3
    const full = gradeParams({ ...DEFAULT_ADJUST, saturation: 10 }, { id: 'vivid', intensity: 100 });
    expect(full).toMatchObject({ saturation: 40, contrast: 12, brightness: 3 });
    const half = gradeParams(null, { id: 'vivid', intensity: 50 });
    expect(half).toMatchObject({ saturation: 15, contrast: 6, brightness: 1.5 });
    const off = gradeParams(null, { id: 'vivid', intensity: 0 });
    expect(off.saturation).toBe(0);
    expect(gradeParams(null, { id: 'vivid' }).saturation).toBe(30);
  });

  it('scales black and white and split toning, converting tints to RGB', () => {
    const g = gradeParams(null, { id: 'sepia', intensity: 50 });
    expect(g.mono).toBeCloseTo(0.5);
    expect(g.splitAmount).toBeCloseTo(0.3);
    expect(g.highlightTint.map((v) => Math.round(v * 255))).toEqual([0xd9, 0xa6, 0x6b]);
    expect(g.shadowTint.map((v) => Math.round(v * 255))).toEqual([0x3b, 0x24, 0x12]);
  });

  it('ignores unknown filters', () => {
    expect(gradeParams({ ...DEFAULT_ADJUST, tint: 4 }, { id: 'missing', intensity: 100 })).toEqual(gradeParams({ ...DEFAULT_ADJUST, tint: 4 }, null));
  });
});

describe('Compositor', () => {
  it('fails with a clear error where WebGL2 is unavailable', () => {
    const canvas = document.createElement('canvas');
    // jsdom has no WebGL; make sure the test does not depend on its console noise.
    canvas.getContext = vi.fn(() => null);
    expect(() => new Compositor(canvas, { resolve: () => null })).toThrow('WebGL2 is not available');
    expect(canvas.getContext).toHaveBeenCalledWith('webgl2', expect.any(Object));
  });
});

describe('sizes in pixels', () => {
  it('counts output pixels per project pixel', () => {
    const c = Object.assign(Object.create(Compositor.prototype), { width: 552, projW: 1920 });
    expect(c.pxScale).toBeCloseTo(0.2875, 6);
    c.width = 1920;
    expect(c.pxScale).toBe(1);
    c.width = 3840;
    expect(c.pxScale).toBe(2);
  });

  it('gives effects the pixel scale, so a blur reaches as far in the preview as in the export', () => {
    const set = {};
    const comp = {
      gl: { BLEND: 1, disable() {} },
      pxScale: 0.25,
      _program: () => ({}),
      _into() {},
      _use: (p) => p,
      _bindTex() {},
      _seti() {},
      _set: (p, name, ...v) => (set[name] = v),
      _fullPass() {},
    };
    const buf = { w: 480, h: 270, tex: {}, fb: {} };
    expect(effectPass(comp, 'blur', { strength: 100 }, buf, { ...buf }, {})).toBe(true);
    expect(set.u_px).toEqual([0.25]);
  });

  it('measures blur and kernel offsets in project pixels', () => {
    for (const id of ['blur', 'glow', 'sharpen', 'edge']) expect(EFFECT_SHADERS[id], id).toMatch(/u_texel \* u_px/);
    expect(TRANSITION_SHADERS.blur).toMatch(/r \* u_px \/ u_res/);
    expect(GRADE_FS).toMatch(/u_texel \* u_px/);
  });
});
