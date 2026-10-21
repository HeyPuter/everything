import { describe, it, expect } from 'vitest';
import type { FCurve, Keyframe } from '../../src/data/types';
import { calcHandles, evaluateFCurve, insertKeyframe } from '../../src/anim/fcurve';
import expected from '../fixtures/anim/fcurve_eval.json';

const FRAMES = [2, 4, 7, 9.5, 11, 13, 14.5, 17, 22, 28];

/** F-Curve evaluation (Bézier with automatic handles, easing equations) against reference values. */
describe('F-Curve evaluation matches the reference', () => {
  for (const [name, values] of Object.entries(expected as Record<string, number[]>)) {
    // Elastic follows its own (unmatched) oscillation shape
    it(name, () => {
      const [interp, ...rest] = name.split('_');
      const easing = rest.slice(-1)[0] === 'AUTO' ? 'AUTO' : rest.slice(-2).join('_').replace(/^IN_OUT$/, 'EASE_IN_OUT');
      const ht = name.includes('AUTO_CLAMPED') ? 'AUTO_CLAMPED' : 'AUTO';
      // new curves use Continuous Acceleration smoothing (the default for new F-Curves)
      const fc: FCurve = { data_path: 'location', array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], auto_smoothing: 'CONT_ACCEL' };
      for (const [f, v] of [
        [1, 0],
        [10, 5],
        [15, 2],
        [30, 8],
      ]) {
        const k = insertKeyframe(fc, f, v);
        k.handle_left_type = k.handle_right_type = ht as Keyframe['handle_left_type'];
        k.interpolation = interp as Keyframe['interpolation'];
        k.easing = (name.endsWith('EASE_IN_OUT') ? 'EASE_IN_OUT' : name.endsWith('EASE_IN') ? 'EASE_IN' : name.endsWith('EASE_OUT') ? 'EASE_OUT' : 'AUTO') as Keyframe['easing'];
      }
      void easing;
      calcHandles(fc);
      FRAMES.forEach((f, i) => expect(evaluateFCurve(fc, f), `${name} @${f}`).toBeCloseTo(values[i], 3));
    });
  }
});
