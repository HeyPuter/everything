import { describe, it, expect } from 'vitest';
import type { FCurve, Keyframe } from '../../src/data/types';
import { calcHandles, insertKeyframe } from '../../src/anim/fcurve';
import expected from '../fixtures/anim/auto_handles.json';

/** Automatic handles (and Continuous Acceleration smoothing) against recorded reference values. */
describe('automatic handles match the reference', () => {
  for (const [name, keys] of Object.entries(expected as Record<string, number[][][]>)) {
    it(name, () => {
      const [ht, sm] = name.startsWith('AUTO_CLAMPED') ? ['AUTO_CLAMPED', name.slice(13)] : ['AUTO', name.slice(5)];
      const fc: FCurve = { data_path: 'location', array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], auto_smoothing: sm as FCurve['auto_smoothing'] };
      for (const [, co] of keys) {
        const k = insertKeyframe(fc, co[0], co[1]);
        k.handle_left_type = k.handle_right_type = ht as Keyframe['handle_left_type'];
      }
      calcHandles(fc);
      fc.keyframe_points.forEach((k, i) => {
        const [l, , r] = keys[i];
        expect(k.handle_left[0]).toBeCloseTo(l[0], 3);
        expect(k.handle_left[1]).toBeCloseTo(l[1], 3);
        expect(k.handle_right[0]).toBeCloseTo(r[0], 3);
        expect(k.handle_right[1]).toBeCloseTo(r[1], 3);
      });
    });
  }
});

describe('clamped Continuous Acceleration limits overshooting handles', () => {
  it('matches the reference handles of a longer curve', () => {
    const VALS = [0, 0.1, 0.25, 1.2, 1.0, 0.9, 2.5, 2.4, 2.6, 0.3, -0.5, 0.0, 0.05, 1.5, 1.6];
    // recorded handle values (left, right) of the reference run
    const REF = [[0, 0], [0.075, 0.125], [0.1, 0.4], [1.2, 1.2], [1.075, 0.925], [0.9, 0.9], [2.5, 2.5], [2.4, 2.4], [2.6, 2.6], [1.075, -0.475], [-0.5, -0.5], [-0.05, 0.05], [0, 0.1], [1.4, 1.6], [1.6, 1.6]];
    const fc: FCurve = { data_path: 'location', array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], auto_smoothing: 'CONT_ACCEL' };
    VALS.forEach((v, i) => insertKeyframe(fc, 1 + i * 2, v));
    calcHandles(fc);
    fc.keyframe_points.forEach((k, i) => {
      expect(k.handle_left[1], `left ${i}`).toBeCloseTo(REF[i][0], 4);
      expect(k.handle_right[1], `right ${i}`).toBeCloseTo(REF[i][1], 4);
    });
  });
});

