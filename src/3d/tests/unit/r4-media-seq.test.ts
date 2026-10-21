import { describe, it, expect } from 'vitest';
import * as S from '../../src/sequencer/strips';

describe('slip without clamping', () => {
  it('lets the content slide past a handle; the strip holds its edge frames there', () => {
    const e = S.newSequenceEditor();
    const m = S.newStrip('MOVIE', 'M', 1, 0, 100);
    e.strips.push(m);
    m.frame_offset_start = 20;
    m.frame_offset_end = 30;
    S.slip(m, 40, false);
    // handles stay put, the content moved 40 frames (its start is now past the left handle)
    expect([S.finalStart(m), S.finalEnd(m), m.frame_start]).toEqual([20, 70, 40]);
    expect(m.frame_offset_start).toBe(-20);
    // frames before the content show its first frame
    expect(S.contentFrame(m, 25)).toBe(0);
    expect(S.contentFrame(m, 45)).toBe(5);
    // a clamped slip brings the content back under the handles
    S.slip(m, 0, true);
    expect(m.frame_start).toBe(20);
    expect(m.frame_offset_start).toBe(0);
    S.slip(m, 40, true);
    expect(m.frame_start).toBe(20);
    S.slip(m, -1000, true);
    expect(S.finalEnd(m)).toBe(m.frame_start + m.frame_duration);
  });
});
