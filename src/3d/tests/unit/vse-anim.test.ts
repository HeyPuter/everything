import { describe, it, expect } from 'vitest';
import * as S from '../../src/sequencer/strips';
import * as A from '../../src/sequencer/stripanim';
import { addFade, clearFade } from '../../src/sequencer/fades';

describe('strip keyframes', () => {
  it('keys the transform, interpolates and applies per frame', () => {
    const s = S.newStrip('COLOR', 'c', 1, 1, 100);
    expect(A.keyingPaths(s, 'TRANSFORM').length).toBe(5);
    expect(A.keyingPaths(S.newStrip('SOUND', 's', 1, 1, 10), 'AUTO' as never)).toEqual(['volume']);
    A.insertKeys(s, A.keyingPaths(s, 'LOCATION'), 1);
    s.transform.offset_x = 100;
    A.insertKeys(s, A.keyingPaths(s, 'LOCATION'), 11);
    expect(A.animatedStrip(s, 6).transform.offset_x).toBeCloseTo(50);
    expect(s.transform.offset_x).toBe(100);
    A.applyKeys(s, 1);
    expect(s.transform.offset_x).toBe(0);
    expect(A.keyFrames(s)).toEqual([1, 11]);
  });

  it('keys move with the strip, delete and clear', () => {
    const s = S.newStrip('COLOR', 'c', 1, 1, 100);
    A.insertKeys(s, ['transform.rotation'], 10);
    S.translateStrip(s, 5);
    expect(A.keyFrames(s)).toEqual([15]);
    expect(A.deleteKeysAt(s, 15)).toBe(1);
    expect(s.keys).toBeUndefined();
    A.insertKeys(s, ['transform.rotation'], 10);
    addFade(s, 'IN', 10, 1);
    // clearing the fade keeps the other keys
    expect(clearFade(s)).toBe(true);
    expect(A.keyFrames(s)).toEqual([10]);
    expect(A.clearKeys(s)).toBe(true);
    expect(s.keys).toBeUndefined();
  });
});
