import { expect, it } from 'vitest';
import { frameTimes } from '../src/features/animation/video-import';

it('does not import an extra duplicate frame at the end of a whole video', () => {
  expect(frameTimes(0, 0.4, 25, 1)).toHaveLength(10);
  expect(frameTimes(0, 0.4, 25, 2)).toHaveLength(5);
});

it('samples a partial final frame inside the range and permits a single-time sample', () => {
  const times = frameTimes(0, 0.35, 10, 1);
  expect(times).toHaveLength(4);
  [0.05, 0.15, 0.25, 0.35].forEach((t, i) => expect(times[i]).toBeCloseTo(t, 12));
  expect(frameTimes(0.2, 0.2, 10, 1)).toEqual([0.2]);
});

it('respects the import limit and does not add a frame for floating-point endpoint noise', () => {
  expect(frameTimes(0, 10, 30, 1, 4)).toHaveLength(4);
  expect(frameTimes(0.1, 0.30000000000000004, 10, 1)).toHaveLength(2);
});
