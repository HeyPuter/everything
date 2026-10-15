// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { fft, oceanField, oceanParams } from '../../src/eval/mods/ocean';
import { modifierTypes } from '../../src/eval/modifiers';
import '../../src/eval/mods/index';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

const t = modifierTypes.OCEAN;
const run = (props: Record<string, unknown>, m?: EvalMesh) => t.apply(m ?? (newMeshData('p', prim.plane(2)) as unknown as EvalMesh), { ...t.defaults(), ...props } as never, { render: false } as ModifierContext);
const sd = (a: ArrayLike<number>) => {
  let s = 0,
    s2 = 0;
  for (let i = 0; i < a.length; i++) (s += a[i]), (s2 += a[i] * a[i]);
  return Math.sqrt(s2 / a.length - (s / a.length) ** 2);
};
const zs = (m: EvalMesh) => Float32Array.from({ length: m.positions.length / 3 }, (_, i) => m.positions[i * 3 + 2]);

describe('Ocean', () => {
  it('inverts a forward FFT', () => {
    const re = Float64Array.from([1, 2, 3, 4, 0, -1, 2, 5]),
      im = new Float64Array(8);
    const r0 = re.slice();
    fft(re, im, false);
    fft(re, im, true);
    re.forEach((v, i) => expect(v / 8).toBeCloseTo(r0[i], 9));
  });

  it('generates a grid of resolution² cells spanning the spatial size', () => {
    const out = run({});
    expect(out.positions.length / 3).toBe(2500);
    expect(out.offsets.length - 1).toBe(2401);
    expect(sd(zs(out))).toBeGreaterThan(0.3);
    expect(sd(zs(out))).toBeLessThan(1.2);
    const small = run({ viewport_resolution: 4, size: 2, repeat_x: 2 });
    expect(small.positions.length / 3).toBe(33 * 17);
    let minX = Infinity,
      maxX = -Infinity;
    for (let i = 0; i < small.positions.length; i += 3) (minX = Math.min(minX, small.positions[i])), (maxX = Math.max(maxX, small.positions[i]));
    expect(minX).toBeGreaterThan(-52);
    expect(maxX).toBeGreaterThan(148);
  });

  it('is deterministic, animates with time and scales with wave scale', () => {
    const p = oceanParams(t.defaults() as never, false);
    const a = oceanField(p),
      b = oceanField(p);
    expect(Array.from(a.h)).toEqual(Array.from(b.h));
    const later = oceanField({ ...p, time: 3 });
    expect(Math.abs(later.h[5] - a.h[5]) + Math.abs(later.h[77] - a.h[77])).toBeGreaterThan(1e-4);
    const twice = oceanField({ ...p, scale: 2 });
    expect(twice.h[123]).toBeCloseTo(a.h[123] * 2, 6);
    const flat = oceanField({ ...p, chop: 0 });
    expect(flat.dx.every((x) => x === 0)).toBe(true);
    expect(oceanField({ ...p, seed: 3 }).h[9]).not.toBeCloseTo(a.h[9], 6);
  });

  it('displaces an existing mesh and makes foam colors', () => {
    const grid = newMeshData('g', prim.grid(10, 10, 20)) as unknown as EvalMesh;
    const out = run({ geometry_mode: 'DISPLACE', use_foam: true, foam_coverage: 0.3 }, grid);
    expect(out.positions.length).toBe(grid.positions.length);
    expect(sd(zs(out))).toBeGreaterThan(0.05);
    expect(out.colors!.length).toBe(grid.indices.length * 4);
    expect(Math.max(...out.colors!)).toBeGreaterThan(0.3);
  });
});
