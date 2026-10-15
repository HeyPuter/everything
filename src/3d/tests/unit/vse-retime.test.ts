import { describe, it, expect } from 'vitest';
import * as S from '../../src/sequencer/strips';
import * as R from '../../src/sequencer/retime';
import type { Strip } from '../../src/sequencer/types';

function movie(len = 100, start = 1): Strip {
  return S.newStrip('MOVIE', 'm', 1, start, len);
}

describe('retiming', () => {
  it('only applies to content strips', () => {
    expect(R.retimable(movie())).toBe(true);
    expect(R.retimable(S.newStrip('COLOR', 'c', 1, 1, 10))).toBe(false);
    expect(R.retimable(S.newStrip('CROSS', 'x', 1, 1, 10))).toBe(false);
  });

  it('halving the speed doubles the length and maps content frames', () => {
    const m = movie(100);
    R.ensureKeys(m);
    expect(R.setSegmentSpeed(m, 0, 0.5)).toBe(true);
    expect(m.frame_duration).toBe(200);
    expect(S.finalEnd(m)).toBe(201);
    expect(S.contentFrame(m, 1)).toBe(0);
    expect(S.contentFrame(m, 21)).toBe(10);
    expect(S.contentFrame(m, 200)).toBe(99);
    expect(R.speedAt(m, 50)).toBeCloseTo(0.5);
  });

  it('segments keep their own speed; later content follows', () => {
    const m = movie(100);
    const i = R.addKey(m, 50);
    expect(i).toBe(1);
    R.setSegmentSpeed(m, 1, 2);
    expect(m.frame_duration).toBe(75);
    expect(S.contentFrame(m, 1 + 40)).toBe(40);
    expect(S.contentFrame(m, 1 + 60)).toBe(70);
    expect(R.contentLength(m)).toBe(100);
  });

  it('freeze frames hold the content and lengthen the strip', () => {
    const m = movie(100);
    expect(R.addFreezeFrame(m, 30, 10)).toBe(true);
    expect(m.frame_duration).toBe(110);
    expect(S.contentFrame(m, 1 + 30)).toBe(30);
    expect(S.contentFrame(m, 1 + 35)).toBe(30);
    expect(S.contentFrame(m, 1 + 41)).toBe(31);
    expect(R.speedAt(m, 35)).toBe(0);
  });

  it('transitions ease between speeds without changing the length', () => {
    const m = movie(100);
    R.addKey(m, 50);
    R.setSegmentSpeed(m, 1, 2);
    const len = m.frame_duration;
    const k = m.retiming_keys!;
    expect(R.addTransition(m, 1, 10)).toBe(true);
    expect(m.frame_duration).toBe(len);
    expect(k.length).toBe(4);
    expect(k[1].transition).toBe(true);
    // speed rises from 1 to 2 through the transition
    const s0 = R.speedAt(m, 46),
      s1 = R.speedAt(m, 50),
      s2 = R.speedAt(m, 54);
    expect(s0).toBeLessThan(s1);
    expect(s1).toBeLessThan(s2);
    expect(R.mapContent(m, 45)).toBeCloseTo(45);
    expect(R.mapContent(m, 55)).toBeCloseTo(k[2].content);
  });

  it('moving a key changes the speed before it; deleting keys and reset restore', () => {
    const m = movie(100);
    R.addKey(m, 50);
    expect(R.moveKey(m, 1, 50)).toBe(true);
    expect(m.frame_duration).toBe(150);
    expect(R.segmentSpeed(m.retiming_keys!, 0)).toBeCloseTo(0.5);
    expect(R.deleteKeys(m, [1])).toBe(true);
    expect(m.retiming_keys!.length).toBe(2);
    expect(R.resetRetiming(m)).toBe(true);
    expect(m.retiming_keys).toBeUndefined();
    expect(m.frame_duration).toBe(100);
  });

  it('a retimed sound plays as constant-rate pieces', () => {
    const s = S.newStrip('SOUND', 's', 1, 1, 100);
    R.addFreezeFrame(s, 50, 20);
    const pieces = R.retimedPieces(s, 1, 1000);
    expect(pieces.map((p) => [p.start, p.end, p.rate])).toEqual([
      [1, 51, 1],
      [51, 71, 0],
      [71, 121, 1],
    ]);
    expect(pieces[2].content).toBe(50);
  });

  it('hard split of a retimed strip keeps its content', () => {
    const e = S.newSequenceEditor();
    const m = movie(100);
    e.strips.push(m);
    R.ensureKeys(m);
    R.setSegmentSpeed(m, 0, 0.5);
    const [r] = S.splitStrips(e, e.strips, [m], 101, 'HARD');
    expect(S.finalEnd(m)).toBe(101);
    expect(S.contentFrame(r, 101)).toBe(50);
  });
});
