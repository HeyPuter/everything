import { describe, expect, it } from 'vitest';
import { applyHealMode } from '../src/features/retouch/logic';

const img = (...px: number[][]) => ({
  width: px.length,
  height: 1,
  data: new Uint8ClampedArray(px.flat()),
});
const mask = (...v: number[]) => ({ width: v.length, height: 1, data: new Uint8Array(v) });

describe('healing modes', () => {
  const backdrop = img([200, 100, 50, 255], [200, 100, 50, 255]);
  const healed = img([100, 100, 100, 255], [100, 100, 100, 255]);
  it('keeps the healed pixels in Normal mode', () => {
    expect(applyHealMode('normal', backdrop, healed, mask(255, 0))).toBe(healed);
  });
  it('combines inside the stroke only for blend modes', () => {
    const out = applyHealMode('darken', backdrop, healed, mask(255, 0));
    expect(Array.from(out.data.slice(0, 4))).toEqual([100, 100, 50, 255]);
    expect(Array.from(out.data.slice(4))).toEqual([200, 100, 50, 255]);
    const lighter = applyHealMode('lighten', backdrop, healed, mask(255, 0));
    expect(Array.from(lighter.data.slice(0, 3))).toEqual([200, 100, 100]);
  });
  it('weights by the soft edge of the stroke', () => {
    const out = applyHealMode('multiply', backdrop, healed, mask(128, 0));
    // Multiply gives 78, 39, 20 at full strength; half way from the backdrop.
    expect(out.data[0]).toBeGreaterThan(135);
    expect(out.data[0]).toBeLessThan(142);
  });
  it('copies the source with the soft edge in Replace mode', () => {
    const source = img([0, 0, 0, 255], [0, 0, 0, 255]);
    const out = applyHealMode('replace', backdrop, healed, mask(255, 51), source);
    expect(Array.from(out.data.slice(0, 4))).toEqual([0, 0, 0, 255]);
    expect(out.data[4]).toBe(160);
    // Without a source (spot healing) Replace has nothing to copy.
    expect(applyHealMode('replace', backdrop, healed, mask(255, 0))).toBe(healed);
  });
});
