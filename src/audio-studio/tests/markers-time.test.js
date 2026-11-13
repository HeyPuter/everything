import { describe, it, expect } from 'vitest';
import { shiftMarkersForDelete, shiftMarkersForInsert, nextMarkerName, createMarker } from '../src/model/markers.js';
import { formatTime, parseTime, rulerStep, rulerLabel } from '../src/lib/time.js';

describe('markers', () => {
  it('trims range markers that overlap a deleted range', () => {
    const [m] = shiftMarkersForDelete([createMarker({ start: 10, duration: 20 })], 20, 40);
    expect([m.start, m.duration]).toEqual([10, 10]);
  });
  it('keeps a cue at the insertion point and grows spanning ranges', () => {
    const out = shiftMarkersForInsert([createMarker({ start: 5 }), createMarker({ start: 2, duration: 6 })], 5, 10);
    expect(out[0].start).toBe(5);
    expect(out[1].duration).toBe(16);
  });
  it('names markers without collisions', () => {
    expect(nextMarkerName([{ name: 'Marker 01' }])).toBe('Marker 02');
  });
});

describe('time', () => {
  it('formats decimal, compact, samples and SMPTE', () => {
    expect(formatTime(48000 * 75.5, 48000)).toBe('1:15.500');
    expect(formatTime(48000 * 3725, 48000, 'compact')).toBe('01:02:05.000');
    expect(formatTime(1234, 48000, 'samples')).toBe('1234');
    expect(formatTime(48000 * 1.5, 48000, 'smpte30')).toBe('00:00:01:15');
  });
  it('parses what it formats', () => {
    for (const f of ['decimal', 'compact', 'samples', 'smpte25']) {
      const text = formatTime(96000, 48000, f);
      expect(parseTime(text, 48000, f)).toBe(96000);
    }
    expect(parseTime('2.5', 1000)).toBe(2500);
    expect(parseTime('nonsense', 1000)).toBeNaN();
  });
  it('shows exact beat positions in bars and beats despite float error', () => {
    // 17 beats at 100 BPM is 10.2 s, which computes as 16.999... beats.
    expect(formatTime(489600, 48000, 'bars', { tempo: 100 })).toBe('5:2.00');
    // 0.24 s at 60 BPM is 0.24 beats, which computes as 0.2399...
    expect(formatTime(10584, 44100, 'bars', { tempo: 60 })).toBe('1:1.24');
    expect(formatTime(parseTime('3:4.50', 48000, 'bars', { tempo: 100 }), 48000, 'bars', { tempo: 100 })).toBe('3:4.50');
    expect(formatTime(-48000, 48000, 'bars', { tempo: 120 })).toBe('-1:3.00');
  });
  it('picks readable ruler steps', () => {
    expect(rulerStep(0.01, 80)).toBe(1);
    expect(rulerStep(1, 80)).toBe(120);
  });
  it('rolls ruler labels over at minute boundaries despite float drift', () => {
    // The ruler steps with `s += step`, which lands a hair under round values.
    let s = 110;
    for (let i = 0; i < 100; i++) s += 0.1;
    expect(s).toBeLessThan(120);
    expect(rulerLabel(s, 0.1)).toBe('2:00.0');
    expect(rulerLabel(59.99999999, 0.05)).toBe('1:00.00');
    expect(rulerLabel(3599.999999999991, 0.2)).toBe('1:00:00.0');
    expect(rulerLabel(119.9999999, 60)).toBe('2:00');
    expect(rulerLabel(75.5, 0.1)).toBe('1:15.5');
    expect(rulerLabel(12.25, 0.01)).toBe('12.25');
  });
});
