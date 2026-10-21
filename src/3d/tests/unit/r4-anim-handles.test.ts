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
