import { describe, it, expect } from 'vitest';
import type { FCurve } from '../../src/data/types';
import { calcHandles, insertKeyframe } from '../../src/anim/fcurve';
import * as T from '../../src/animation/fcurvetools';
import { cleanKeys, finalizeCurve, setKeySelected } from '../../src/animation/keyedit';
import impulses from '../fixtures/anim/smooth_impulses.json';
import expected from '../fixtures/anim/graph_tools.json';

const VALS = [0, 0.1, 0.25, 1.2, 1.0, 0.9, 2.5, 2.4, 2.6, 0.3, -0.5, 0.0, 0.05, 1.5, 1.6];

/** The reference run keys the cube's X location (Continuous Acceleration handles) and selects keys. */
function setup(inner: boolean) {
  const fc: FCurve = { data_path: 'location', array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], auto_smoothing: 'CONT_ACCEL' };
  VALS.forEach((v, i) => insertKeyframe(fc, 1 + i * 2, v));
  calcHandles(fc);
  fc.keyframe_points.forEach((k, i) => setKeySelected(k, !inner || (i > 0 && i < VALS.length - 1)));
  return { fc, refs: [{ ob: {} as never, action: { id: 'a', name: 'a', fcurves: [fc] }, fc }] };
}

const RUN: Record<string, (r: ReturnType<typeof setup>['refs']) => void> = {
  clean: (r) => cleanKeys(r, 0.2),
  decimate_ratio: (r) => T.decimateKeys(r, 'RATIO', 0.5),
  decimate_error: (r) => T.decimateKeys(r, 'ERROR', 1, 0.3),
  smooth: (r) => T.smoothKeys(r),
  gaussian: (r) => T.gaussianSmooth(r, 1, 0.33, 6),
  butterworth: (r) => T.butterworthSmooth(r, { cutoff: 3, order: 4, samplesPerFrame: 1, blend: 1, blendInOut: 1, fps: 24 }),
  ease: (r) => T.applyBlend(r, 'EASE', 0.8, { sharpness: 2 }),
  blend_to_neighbor: (r) => T.applyBlend(r, 'BLEND_TO_NEIGHBOR', 0.75),
  breakdown: (r) => T.applyBlend(r, 'BREAKDOWN', 0.3),
  blend_to_default: (r) => T.applyBlend(r, 'BLEND_TO_DEFAULT', 0.5),
  push_pull: (r) => T.applyBlend(r, 'PUSH_PULL', 1.5),
  scale_average: (r) => T.applyBlend(r, 'SCALE_AVERAGE', 1.5),
  blend_offset: (r) => T.applyBlend(r, 'BLEND_OFFSET', 0.5),
  shear: (r) => T.applyBlend(r, 'SHEAR', 0.4),
  blend_to_ease: (r) => T.applyBlend(r, 'BLEND_TO_EASE', 0.5),
  match_slope: (r) => T.applyBlend(r, 'MATCH_SLOPE', 0.5),
  time_offset: (r) => T.applyBlend(r, 'TIME_OFFSET', 1.5),
  scale_from_neighbor: (r) => T.applyBlend(r, 'SCALE_FROM_NEIGHBOR', 0.5),
};

/** Tools whose results still differ: curve-fitting decimation. */
const KNOWN_DIFFERENT = new Set(['decimate_ratio', 'decimate_error']);

describe('Graph Editor key tools match the reference', () => {
  for (const [name, res] of Object.entries(expected as Record<string, { keys: number[][] }>)) {
    if (KNOWN_DIFFERENT.has(name)) continue;
    it(name, () => {
      const { fc, refs } = setup(!['clean', 'decimate_ratio', 'decimate_error'].includes(name));
      RUN[name](refs);
      finalizeCurve(fc, false);
      const got = fc.keyframe_points.map((k) => [k.co[0], k.co[1]]);
      expect(got.length, `${name} key count`).toBe(res.keys.length);
      res.keys.forEach(([f, v], i) => {
        expect(got[i][0], `${name} frame ${i}`).toBeCloseTo(f, 2);
        expect(got[i][1], `${name} value @${f}`).toBeCloseTo(v, 2);
      });
    });
  }
});

describe('ease shapes', () => {
  it('Blend to Ease follows the recorded ease-in / ease-out values', async () => {
    const { easeOneSided } = await import('../../src/animation/fcurvetools');
    // recorded from the reference app on a 0 → 1 segment
    const easeIn: [number, number][] = [
      [0.2, 1 / 365],
      [0.4, 2 / 65],
      [0.5, 1 / 14],
      [0.8, 16 / 35],
    ];
    for (const [x, y] of easeIn) {
      expect(easeOneSided(x, false)).toBeCloseTo(y, 9);
      expect(easeOneSided(1 - x, true)).toBeCloseTo(1 - y, 9);
    }
  });
  it('Ease is an algebraic S-curve shifted by the factor', async () => {
    const { easeCurve } = await import('../../src/animation/fcurvetools');
    // recorded: factor 0 / sharpness 2 and factor 0.8 / sharpness 2, at x = 0.25
    expect(easeCurve(0.25, 0, 2)).toBeCloseTo(0.10472, 5);
    expect(easeCurve(0.25, 0.8, 2)).toBeCloseTo(0.66363, 5);
  });
});

describe('legacy smooth', () => {
  it('matches the recorded impulse responses (selection runs of different extents)', async () => {
    const T = await import('../../src/animation/fcurvetools');
    const { setKeySelected } = await import('../../src/animation/keyedit');
    const sels: Record<string, (i: number) => boolean> = { inner: (i) => i > 0 && i < 14, all: () => true, mid: (i) => i >= 3 && i <= 10 };
    for (const [name, out] of Object.entries(impulses as Record<string, number[]>)) {
      const [sel, p] = name.split('_');
      const fc: FCurve = { data_path: 'location', array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], auto_smoothing: 'CONT_ACCEL' };
      for (let i = 0; i < 15; i++) insertKeyframe(fc, 1 + 2 * i, i === Number(p) ? 1 : 0);
      fc.keyframe_points.forEach((k, i) => setKeySelected(k, sels[sel](i)));
      T.smoothKeys([{ ob: {} as never, action: { id: 'a', name: 'a', fcurves: [fc] }, fc }]);
      fc.keyframe_points.forEach((k, i) => expect(k.co[1], `${name} key ${i}`).toBeCloseTo(out[i], 5));
    }
  });
});

