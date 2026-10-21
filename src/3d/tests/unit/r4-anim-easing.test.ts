import { describe, it, expect } from 'vitest';
import type { FCurve, Keyframe } from '../../src/data/types';
import { calcHandles, evaluateFCurve, insertKeyframe } from '../../src/anim/fcurve';
import expected from '../fixtures/anim/easing.json';
import elasticParams from '../fixtures/anim/elastic_params.json';

/** Easing interpolations (Expo, Elastic, Bounce, Back, Circ, Sine with each easing) against reference samples. */
describe('easing interpolation matches the reference', () => {
  for (const [name, values] of Object.entries(expected as Record<string, number[]>)) {
    if (name.endsWith('_params')) continue;
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

/** Elastic ease-in with various amplitudes (value units) and periods (frames) over a 100 frame segment. */
describe('elastic amplitude and period match the reference', () => {
  for (const [name, values] of Object.entries(elasticParams as Record<string, number[]>)) {
    it(name, () => {
      const [amplitude, period] = name.split('_').map(Number);
      const fc: FCurve = { data_path: 'location', array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [] };
      insertKeyframe(fc, 0, 0);
      insertKeyframe(fc, 100, 1);
      Object.assign(fc.keyframe_points[0], { interpolation: 'ELASTIC', easing: 'EASE_IN', amplitude, period });
      values.forEach((v, f) => expect(evaluateFCurve(fc, f), `${name} @${f}`).toBeCloseTo(v, 4));
    });
  }
});


describe('Back with no overshoot', () => {
  it('a back of 0 eases like a cubic (as in the reference)', () => {
    const fc: FCurve = { data_path: 'location', array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [] };
    insertKeyframe(fc, 0, 0);
    insertKeyframe(fc, 100, 1);
    Object.assign(fc.keyframe_points[0], { interpolation: 'BACK', easing: 'EASE_IN', back: 0 });
    // recorded reference values at frames 10, 30, 50, 70, 90
    [0.001, 0.027, 0.125, 0.343, 0.729].forEach((v, i) => expect(evaluateFCurve(fc, 10 + i * 20)).toBeCloseTo(v, 5));
  });
});
