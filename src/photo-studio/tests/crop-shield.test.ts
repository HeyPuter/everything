import { describe, expect, it } from 'vitest';
import type { Editor } from '../src/editor';
import { DEFAULT_SHIELD, cropShield, shieldStyle } from '../src/features/transform/crop-shield';

const ed = (cropShieldSetting?: unknown) =>
  ({ settings: { cropShield: cropShieldSetting } }) as unknown as Editor;

describe('crop shield', () => {
  it('starts as a dark shield and sanitizes stored values', () => {
    expect(cropShield(ed())).toEqual(DEFAULT_SHIELD);
    expect(cropShield(ed({ color: 'red', opacity: 3 }))).toMatchObject({
      color: '#000000',
      opacity: 1,
    });
    expect(cropShield(ed({ color: 'canvas' })).color).toBe('canvas');
  });
  it('lightens while the box is dragged when Auto Adjust is on', () => {
    expect(shieldStyle(DEFAULT_SHIELD, false)).toEqual({ fill: '#000000', opacity: 0.55 });
    expect(shieldStyle(DEFAULT_SHIELD, true)!.opacity).toBeCloseTo(0.33);
    expect(shieldStyle({ ...DEFAULT_SHIELD, autoAdjust: false }, true)!.opacity).toBe(0.55);
  });
  it('matches the canvas color, or hides the cropped area entirely', () => {
    expect(shieldStyle({ ...DEFAULT_SHIELD, color: 'canvas' }, false)!.fill).toContain('--canvas');
    expect(shieldStyle({ ...DEFAULT_SHIELD, show: false }, false)).toEqual({
      fill: 'var(--canvas-mode, var(--canvas))',
      opacity: 1,
    });
    expect(shieldStyle({ ...DEFAULT_SHIELD, shield: false }, false)).toBeUndefined();
  });
});
