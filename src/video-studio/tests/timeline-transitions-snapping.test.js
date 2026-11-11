import { describe, it, expect } from 'vitest';
import {
  setTransition, maxTransition, cleanupTransitions, nextAdjacent, moveClip,
  snap, snapRange, snapPoints, editPoint, addClip, canTransition,
} from '../src/model/timeline.js';
import { createCompound } from '../src/model/compound.js';
import { evaluate } from '../src/engine/scene.js';
import { fixture, clip, onMain, s } from './helpers.js';

const RIPPLE = { ripple: true, linkOverlays: true };
const FREE = { ripple: false, linkOverlays: false };

describe('transitions', () => {
  it('needs a touching neighbor on the same track', () => {
    const p = fixture();
    const [a, b, c] = onMain(p, clip('video', 0, 2), clip('video', 2, 2), clip('video', 5, 2));
    expect(nextAdjacent(p, a.id)).toBe(b);
    expect(nextAdjacent(p, b.id)).toBe(null);
    expect(setTransition(p, b.id, 'mix')).toBe(false);
    expect(setTransition(p, c.id, 'mix')).toBe(false);
    expect(setTransition(p, a.id, 'mix')).toBe(true);
    expect(a.transition).toEqual({ id: 'mix', duration: s(0.5) });
  });

  it('is limited by both clips and a 5 second ceiling', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('image', 0, 1), clip('image', 1, 20));
    expect(maxTransition(p, a)).toBe(s(1));
    setTransition(p, a.id, 'mix', s(3));
    expect(a.transition.duration).toBe(s(1));
    onMain(p, clip('image', 21, 20));
    setTransition(p, b.id, 'mix', s(9));
    expect(b.transition.duration).toBe(s(5));
  });

  it('is refused between clips too short for a tenth of a second', () => {
    const p = fixture();
    const [a] = onMain(p, clip('image', 0, 0.05), clip('image', 0.05, 2));
    expect(setTransition(p, a.id, 'mix')).toBe(false);
  });

  it('is only for video and image clips', () => {
    const p = fixture();
    const t1 = clip('text', 0, 2);
    addClip(p, t1, RIPPLE);
    addClip(p, clip('text', 2, 2), RIPPLE);
    expect(setTransition(p, t1.id, 'mix')).toBe(false);
  });

  it('is not offered into a compound clip, whose contents play on tracks of their own', () => {
    const p = fixture();
    const [a, b, c] = onMain(p, clip('video', 0, 2), clip('video', 2, 2), clip('video', 4, 2));
    const comp = createCompound(p, [b.id, c.id], RIPPLE);
    expect(nextAdjacent(p, a.id)).toBe(comp);
    expect(maxTransition(p, a)).toBe(0);
    expect(canTransition(p, a)).toBe(false);
    expect(setTransition(p, a.id, 'mix')).toBe(false);
    // One made before (or loaded) is dropped, as it never played.
    a.transition = { id: 'mix', duration: s(0.5) };
    cleanupTransitions(p);
    expect(a.transition).toBe(null);
    // Out of a compound clip neither.
    const [x, y] = onMain(p, clip('video', 10, 2), clip('video', 12, 2));
    const out = createCompound(p, [x.id], FREE);
    expect(nextAdjacent(p, out.id)).toBe(y);
    expect(canTransition(p, out)).toBe(false);
    // The engine draws no transition at that cut.
    const q = fixture();
    const [k, l, m] = onMain(q, clip('video', 0, 2), clip('video', 2, 2), clip('video', 4, 2));
    createCompound(q, [l.id, m.id], RIPPLE);
    k.transition = { id: 'mix', duration: s(1) };
    expect(evaluate(q, s(2)).some((layer) => layer.kind === 'transition')).toBe(false);
  });

  it('is removed by passing no id', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    setTransition(p, a.id, 'mix');
    setTransition(p, a.id, null);
    expect(a.transition).toBe(null);
  });

  it('is dropped by cleanup once the clips no longer touch', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    setTransition(p, a.id, 'mix');
    moveClip(p, b.id, { start: s(5) }, FREE);
    cleanupTransitions(p);
    expect(a.transition).toBe(null);
  });

  it('is shortened by cleanup when the next clip gets shorter than it', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    setTransition(p, a.id, 'mix', s(1.5));
    b.duration = s(0.3);
    cleanupTransitions(p);
    expect(a.transition).toEqual({ id: 'mix', duration: s(0.3) });
  });
});

describe('snapping', () => {
  it('collects sorted unique points from clip edges, playhead and markers', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2), clip('video', 2, 3));
    p.markers.push({ id: 'm', time: s(7), color: '#ffffff', label: '' });
    expect(snapPoints(p, { playhead: s(1) })).toEqual([0, s(1), s(2), s(5), s(7)]);
    expect(snapPoints(p, { exclude: new Set([a.id]) })).toEqual([0, s(2), s(5), s(7)]);
  });

  it('snaps to the nearest point within the threshold only', () => {
    const pts = [0, s(1), s(2)];
    expect(snap(s(1.04), pts, s(0.05))).toEqual({ time: s(1), snapped: true });
    expect(snap(s(1.94), pts, s(0.05))).toEqual({ time: s(1.94), snapped: false });
    expect(snap(s(1.5) + 1, pts, s(0.6))).toEqual({ time: s(2), snapped: true });
    expect(snap(-10, pts, 100)).toEqual({ time: 0, snapped: true });
    expect(snap(s(9), [], s(1))).toEqual({ time: s(9), snapped: false });
  });

  it('snaps a moving range by whichever edge is closer', () => {
    const pts = [0, s(5)];
    // Start is 0.2 s from 0, end is 0.1 s from 5: the end wins.
    expect(snapRange(s(0.2), s(4.9), pts, s(0.3))).toEqual({ start: s(0.1), snapped: true, at: s(5) });
    expect(snapRange(s(0.1), s(4.6), pts, s(0.3))).toEqual({ start: 0, snapped: true, at: 0 });
    expect(snapRange(s(2), s(1), pts, s(0.3))).toEqual({ start: s(2), snapped: false, at: null });
  });
});

describe('editPoint', () => {
  it('steps to the next and previous clip edges on any track', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2), clip('video', 2, 3));
    addClip(p, clip('text', 3, 1), RIPPLE);
    expect(editPoint(p, 0, 1)).toBe(s(2));
    expect(editPoint(p, s(2), 1)).toBe(s(3));
    expect(editPoint(p, s(4), -1)).toBe(s(3));
    expect(editPoint(p, s(5), 1)).toBe(s(5)); // nothing after the end
    expect(editPoint(p, 0, -1)).toBe(0);
  });
});
