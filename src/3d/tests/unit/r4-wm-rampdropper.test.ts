import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/app/app', () => ({ app: { pointer: { x: 0, y: 0 } }, registerOperators: () => {} }));
vi.mock('../../src/app/keymap', () => ({ addKeys: () => {}, keymaps: {}, keyName: () => '', keyInputHooks: [] }));
vi.mock('../../src/ui/widgets', () => ({ srgbToLinear: (c: number) => c }));
vi.mock('../../src/render/context', () => ({ renderContext: null }));

describe('color ramp eyedropper helpers', () => {
  it('spreads sampled colors evenly over the ramp', async () => {
    const { stopsFromColors, linePoints } = await import('../../src/ui/rampdropper');
    const c = (v: number): [number, number, number, number] => [v, v, v, 1];
    expect(stopsFromColors([])).toEqual([]);
    expect(stopsFromColors([c(0.5)])).toEqual([{ pos: 0, color: c(0.5) }]);
    expect(stopsFromColors([c(0), c(0.5), c(1)]).map((s) => s.pos)).toEqual([0, 0.5, 1]);
    expect(linePoints(0, 0, 10, 20, 3)).toEqual([[0, 0], [5, 10], [10, 20]]);
    expect(linePoints(4, 4, 9, 9, 1)).toEqual([[4, 4]]);
  });
});
