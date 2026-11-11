import { describe, it, expect } from 'vitest';
import { effectsMargin } from '../src/render/effects.js';

describe('raster effect layers', () => {
  it('keep the artwork a shadow, blur or glow reads from when the object runs off screen', () => {
    // At 400% a shadow 40pt to the right comes from artwork 160 device px to its left.
    expect(effectsMargin([{ type: 'dropShadow', x: 40, y: 0, blur: 0 }], 4)).toBeGreaterThanOrEqual(160);
    expect(effectsMargin([{ type: 'dropShadow', x: 0, y: -30, blur: 10 }], 2)).toBeGreaterThanOrEqual(2 * (30 + 15));
    expect(effectsMargin([{ type: 'blur', radius: 10 }], 4)).toBeGreaterThanOrEqual(120);
    expect(effectsMargin([{ type: 'outerGlow', blur: 10 }], 4)).toBeGreaterThanOrEqual(120);
    expect(effectsMargin([{ type: 'innerGlow', blur: 10 }], 4)).toBeGreaterThanOrEqual(120);
    expect(effectsMargin([{ type: 'feather', radius: 10 }], 4)).toBeGreaterThanOrEqual(120);
  });

  it('stay within the margin limits for small, huge and broken values', () => {
    expect(effectsMargin([{ type: 'dropShadow', x: 1, y: 1, blur: 0 }], 1)).toBe(96);
    expect(effectsMargin([{ type: 'dropShadow', x: 1e9, y: 0, blur: 0 }], 64)).toBe(1536);
    expect(effectsMargin([{ type: 'blur', radius: NaN }, { type: 'dropShadow', x: Infinity, y: NaN }], 4)).toBe(96);
  });
});
