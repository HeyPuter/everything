import { describe, it, expect } from 'vitest';
import { newMovieClip, newTrack, newMarker } from '../../src/tracking/types';
import { trackedSegments, isShortTrack, dropShortSegments, maxAcceleration } from '../../src/tracking/cleanup';

function track(frames: number[], pos = (f: number) => [0.5 + f * 0.01, 0.5] as [number, number]) {
  const c = newMovieClip('c', 'c', { size: [100, 100] });
  const t = newTrack(c.tracking, 'T');
  for (const f of frames) t.markers.push(newMarker(f, pos(f), c.size, 10, 30));
  return t;
}

describe('track clean-up', () => {
  it('finds tracked runs and short tracks', () => {
    const t = track([1, 2, 3, 7, 8]);
    t.markers.find((m) => m.frame === 2)!.mute = true;
    expect(trackedSegments(t)).toEqual([
      [1, 1],
      [3, 3],
      [7, 8],
    ]);
    expect(isShortTrack(t, 2)).toBe(false);
    expect(isShortTrack(t, 3)).toBe(true);
    expect(dropShortSegments(t, 2)).toBe(true);
    expect(t.markers.filter((m) => !m.mute).map((m) => m.frame)).toEqual([7, 8]);
  });

  it('measures motion spikes', () => {
    expect(maxAcceleration(track([1, 2, 3, 4]), [100, 100])).toBeCloseTo(0, 6);
    const jumpy = track([1, 2, 3, 4], (f) => [f === 3 ? 0.8 : 0.5, 0.5]);
    expect(maxAcceleration(jumpy, [100, 100])).toBeCloseTo(60, 6);
  });
});
