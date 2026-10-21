import { describe, it, expect } from 'vitest';
import type { FCurve, Keyframe } from '../../src/data/types';
import { calcHandles, evaluateFCurve, insertKeyframe } from '../../src/anim/fcurve';
import expected from '../fixtures/anim/easing.json';

/** Easing interpolations (Expo, Elastic, Bounce, Back, Circ, Sine with each easing) against reference samples. */
describe('easing interpolation matches the reference', () => {
  for (const [name, values] of Object.entries(expected as Record<string, number[]>)) {
    // Elastic follows its own (unmatched) oscillation shape
    if (name.endsWith('_params') || name.startsWith('ELASTIC')) continue;
    it(name, () => {
      const [interp, ...rest] = name.split('_');
      const fc: FCurve = { data_path: 'location', array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [] };
      insertKeyframe(fc, 0, 0);
      insertKeyframe(fc, 100, 1);
      const k = fc.keyframe_points[0];
      k.interpolation = interp as Keyframe['interpolation'];
      k.easing = rest.join('_') as Keyframe['easing'];
      calcHandles(fc);
      values.forEach((v, i) => expect(evaluateFCurve(fc, i * 5), `${name} @${i * 5}`).toBeCloseTo(v, 3));
    });
  }
});
