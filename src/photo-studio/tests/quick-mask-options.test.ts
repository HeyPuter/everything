import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUICK_MASK,
  channelFromSelection,
  filmAlpha,
  filmColor,
  quickMaskHint,
  sanitizeQuickMaskOptions,
} from '../src/features/quick-mask-options';

describe('Quick Mask Options', () => {
  it('accepts only valid stored options', () => {
    expect(sanitizeQuickMaskOptions(null)).toEqual(DEFAULT_QUICK_MASK);
    expect(
      sanitizeQuickMaskOptions({ indicates: 'selected', color: '#00FF00', opacity: 0.3 }),
    ).toEqual({ indicates: 'selected', color: '#00ff00', opacity: 0.3 });
    expect(sanitizeQuickMaskOptions({ indicates: 'other', color: 'red', opacity: 7 })).toEqual({
      indicates: 'masked',
      color: '#ff0000',
      opacity: 1,
    });
    expect(sanitizeQuickMaskOptions({ opacity: 'x' }).opacity).toBe(0.5);
  });
  it('stores the selection as is for masked areas and inverted for selected areas', () => {
    const sel = new Uint8Array([0, 128, 255]);
    expect(channelFromSelection(sel, 'masked')).toBe(sel);
    expect([...channelFromSelection(sel, 'selected')]).toEqual([255, 127, 0]);
    // The mapping is its own inverse, so leaving reads the selection back.
    expect([...channelFromSelection(channelFromSelection(sel, 'selected'), 'selected')]).toEqual([
      0, 128, 255,
    ]);
  });
  it('tints dark channel values with the chosen color and opacity', () => {
    const o = { indicates: 'masked' as const, color: '#3366cc', opacity: 0.4 };
    expect(filmColor(o)).toEqual([0x33, 0x66, 0xcc]);
    expect(filmAlpha(0, o)).toBe(102);
    expect(filmAlpha(255, o)).toBe(0);
  });
  it('explains what black paint does in each mode', () => {
    expect(quickMaskHint({ ...DEFAULT_QUICK_MASK })).toMatch(/black to remove/);
    expect(quickMaskHint({ ...DEFAULT_QUICK_MASK, indicates: 'selected' })).toMatch(/black to add/);
  });
});
