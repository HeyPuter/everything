import { it, expect } from 'vitest';
import { advanceRecordingClock } from '../src/input/recording-clock.js';
import { TempoMap, tempoPieces, tempoToNorm } from '../src/engine/tempo.js';

it('counts missed constant-tempo loops without losing elapsed musical time', () => {
  const result = advanceRecordingClock(new TempoMap(120), 300, 10, { start: 0, end: 384 });
  expect(result.tick).toBeCloseTo(300);
  expect(result.elapsed).toBeCloseTo(1920);
});

it('integrates partial and complete loop passes through a tempo ramp', () => {
  const map = new TempoMap(tempoPieces(120, [{
    start: 0, end: 192, offset: 0,
    points: [{ t: 0, v: tempoToNorm(60) }, { t: 192, v: tempoToNorm(180) }],
  }]));
  const seconds = map.duration(120, 144) + 2 * map.duration(48, 144) + map.duration(48, 72);
  const result = advanceRecordingClock(map, 120, seconds, { start: 48, end: 144 });
  expect(result.tick).toBeCloseTo(72);
  expect(result.elapsed).toBeCloseTo(240);
});

it('finishes the song before entering a loop when playback started beyond that loop', () => {
  const map = new TempoMap(120);
  const seconds = map.duration(300, 384) + map.duration(96, 120);
  const result = advanceRecordingClock(map, 300, seconds, { start: 96, end: 192, outer: 384 });
  expect(result.tick).toBeCloseTo(120);
  expect(result.elapsed).toBeCloseTo(108);
});
