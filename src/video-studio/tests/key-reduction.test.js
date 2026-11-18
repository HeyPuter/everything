import { it, expect } from 'vitest';
import { thinKeys } from '../src/media/reframe.js';
import { valueAt } from '../src/model/keyframes.js';

const at = (keys, t) => valueAt({ x: keys }, 'x', t, 0);
it('keeps accumulated curvature within the requested error across the whole path', () => {
  const keys = Array.from({ length: 101 }, (_, i) => ({ t: i * 1000, v: i * i * 0.00001, ease: 'linear' }));
  const before = structuredClone(keys), tol = 0.0015;
  const reduced = thinKeys(keys, tol);
  expect(reduced.length).toBeLessThan(keys.length);
  for (let t = 0; t <= 100_000; t += 250) expect(Math.abs(at(reduced, t) - at(keys, t))).toBeLessThanOrEqual(tol + 1e-12);
  expect(keys).toEqual(before);
});

it('does not merge independent easing intervals even when their knots line up', () => {
  const keys = [0, 1, 2].map(i => ({ t: i * 1000, v: i * 0.5, ease: 'easeInOut' }));
  const reduced = thinKeys(keys, 0.001);
  for (let t = 0; t <= 2000; t += 50) expect(at(reduced, t)).toBeCloseTo(at(keys, t), 10);
});

it.each(['linear', 'wave', 'spike', 'alternating'])('bounds error and retains endpoints on a %s path', shape => {
  const keys = Array.from({ length: 3001 }, (_, i) => ({ t: i * 10, v: shape === 'linear' ? i / 3000 : shape === 'wave' ? Math.sin(i / 100) : shape === 'spike' ? (i === 1201 ? 1 : 0) : i % 2, ease: 'linear' }));
  const out = thinKeys(keys, 0.004);
  expect(out[0]).toBe(keys[0]); expect(out.at(-1)).toBe(keys.at(-1));
  for (const k of keys) expect(Math.abs(at(out, k.t) - k.v)).toBeLessThanOrEqual(0.004 + 1e-12);
  if (shape === 'linear') expect(out).toHaveLength(2);
});

it('retains short paths, duplicate times, and retained easing records without mutation', () => {
  expect(thinKeys([])).toEqual([]);
  const one = [{ t: 0, v: 1 }]; expect(thinKeys(one)).toEqual(one);
  const duplicate = [{ t: 0, v: 0 }, { t: 0, v: 1 }, { t: 1, v: 2 }];
  expect(thinKeys(duplicate)).toEqual(duplicate);
  const retained = [{ t: 0, v: 0, ease: 'linear', curve: { ease: 'linear', from: 0, to: 0.5, start: 0, end: 2 } }, { t: 1, v: 1 }, { t: 2, v: 2 }];
  expect(thinKeys(retained)).toEqual(retained);
});
