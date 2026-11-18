import { describe, expect, it } from 'vitest';
import { adjustmentKey } from '../src/renderer/adjustment-key';
import { compileSpatial } from '../src/features/adjust/compile';

const cube = (n: number, tweak = 0) => {
  const rows = ['LUT_3D_SIZE ' + n];
  for (let i = 0; i < n * n * n; i++) rows.push(`${(i % n) / (n - 1)} 0.5 ${i === 7 ? tweak : 0}`);
  return rows.join('\n');
};
const lookup = (source: unknown, amount = 100) => ({
  kind: 'color-lookup',
  params: { source, amount },
});

describe('adjustment layer change keys', () => {
  it('match plain JSON for small settings', () => {
    const spec = { kind: 'levels', params: { rgb: { inBlack: 3, inWhite: 250, gamma: 1.2 } } };
    expect(adjustmentKey(spec)).toBe(JSON.stringify(spec));
    expect(adjustmentKey(undefined)).toBe('');
  });

  it('give equal .cube text the same key and any edit a new one', () => {
    const a = cube(17),
      b = cube(17);
    expect(adjustmentKey(lookup({ type: 'cube', name: 'x', text: a }))).toBe(
      adjustmentKey(lookup({ type: 'cube', name: 'x', text: b })),
    );
    expect(adjustmentKey(lookup({ type: 'cube', name: 'x', text: a }))).not.toBe(
      adjustmentKey(lookup({ type: 'cube', name: 'x', text: cube(17, 1) })),
    );
    expect(adjustmentKey(lookup({ type: 'cube', name: 'x', text: a }))).not.toBe(
      adjustmentKey(lookup({ type: 'cube', name: 'x', text: a }, 50)),
    );
    // Far more distinct files than the intern table holds still never share a key.
    const keys = new Set(
      Array.from({ length: 80 }, (_, i) =>
        adjustmentKey(lookup({ type: 'cube', name: 'x', text: cube(17, i / 100) })),
      ),
    );
    expect(keys.size).toBe(80);
  });

  it('track every value of a baked table', () => {
    const data = new Float32Array(17 * 17 * 17 * 3).map((_, i) => (i % 97) / 96);
    const spec = (d: Float32Array) =>
      lookup({ type: 'lut', name: 't', lut: { kind: '3d', size: 17, data: d } });
    const key = adjustmentKey(spec(data));
    expect(adjustmentKey(spec(data.slice()))).toBe(key);
    for (const i of [0, 1234, data.length - 1]) {
      const changed = data.slice();
      changed[i] += 1e-6;
      expect(adjustmentKey(spec(changed))).not.toBe(key);
    }
    expect(adjustmentKey(spec(data.slice(3)))).not.toBe(key);
  });

  it('skips the spatial compiler for color kinds', () => {
    expect(compileSpatial(lookup({ type: 'cube', name: 'x', text: cube(5) }) as never)).toBeNull();
    expect(
      compileSpatial({ kind: 'clarity-dehaze', params: { clarity: 40, dehaze: 0 } }),
    ).not.toBeNull();
  });
});
