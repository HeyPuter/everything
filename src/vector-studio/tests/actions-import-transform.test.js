import { describe, expect, it } from 'vitest';
import { parseSetsData, ACTIONS_FORMAT } from '../src/features/panels/actions-model.js';

const file = (step) => ({ format: ACTIONS_FORMAT, sets: [{ name: 'Imported', actions: [{ name: 'Transform', steps: [{ kind: 'transform', ...step }] }] }] });

describe('imported action transforms', () => {
  it.each([
    {},
    { m: [1, 0, 0, 1] },
    { m: [1, 0, 0], d: [0, 0] },
    { m: [1, 0, 0, 1], d: [0] },
    { m: ['1', 0, 0, 1], d: [0, 0] },
    { m: [1, 0, null, 1], d: [0, 0] },
    { m: [1, 0, 0, 1], d: [Infinity, 0] },
  ])('rejects incomplete or nonnumeric geometry: %j', (step) => {
    expect(() => parseSetsData(file(step))).toThrow(/invalid transform/);
  });

  it('preserves legitimate reflection, rotation, scaling, and fractional translation', () => {
    const step = { m: [0, -2, -3, 0], d: [-0.5, 10.25], copy: true };
    const parsed = parseSetsData(file(step))[0].actions[0].steps[0];
    expect(parsed).toMatchObject(step);
    expect(parsed.on).toBe(true);
  });
});
