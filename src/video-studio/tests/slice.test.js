import { describe, it, expect } from 'vitest';
import { sliceProject, exportSpan } from '../src/model/slice.js';
import { addClip, mainTrack, projectDuration } from '../src/model/timeline.js';
import { evaluate, gainAt } from '../src/engine/scene.js';
import { captionCues } from '../src/media/transcribe.js';
import { fixture, clip, onMain, s } from './helpers.js';

/** What the base track shows at t: the clip, its source time, and any transition. */
const shown = (p, t) => {
  const l = evaluate(p, t)[0];
  if (!l) return 'nothing';
  if (l.kind === 'transition') return `${l.id} ${l.progress.toFixed(4)} ${l.from.clip.id}@${l.from.sourceTime} ${l.to.clip.id}@${l.to.sourceTime}`;
  return `${l.clip.id}@${l.sourceTime} x=${l.x.toFixed(4)} o=${l.opacity.toFixed(4)}`;
};
/** The slice shows and plays what the timeline does over the range. */
function expectSame(p, out, lo, hi) {
  for (let t = lo; t < hi; t += s(0.1)) expect(shown(out, t - lo), `t=${t}`).toBe(shown(p, t));
  const heard = (q, t) => mainTrack(q).clips.filter((c) => t >= c.start && t < c.start + c.duration).map((c) => `${c.id}:${gainAt(c, t).toFixed(4)}`).join();
  for (let t = lo; t < hi; t += s(0.1)) expect(heard(out, t - lo), `t=${t}`).toBe(heard(p, t));
}

const FREE = { ripple: false, linkOverlays: false };

describe('sliceProject', () => {
  it('keeps what lies in the range, shifted to 0 and ending with the range', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 4), clip('video', 4, 4), clip('video', 8, 4), clip('video', 12, 4));
    const t = clip('text', 3, 2);
    addClip(p, t, FREE);
    p.markers.push({ id: 'm', time: s(5), color: '#ffffff', label: '' }, { id: 'n', time: s(11), color: '#ffffff', label: '' });
    const out = sliceProject(p, s(2), s(9));
    const main = mainTrack(out);
    // Clips across the edges stay whole, so everything clip-local is as on the timeline.
    expect(main.clips.map((c) => [c.start / 1e6, c.duration / 1e6, c.in / 1e6])).toEqual([[-2, 4, 0], [2, 4, 0], [6, 4, 0]]);
    expectSame(p, out, s(2), s(9));
    expect(out.tracks.find((x) => x.kind === 'text').clips[0].start).toBe(s(1));
    expect(out.markers.map((m) => m.time)).toEqual([s(3)]);
    expect(projectDuration(out)).toBe(s(7));
    // The original is untouched.
    expect(mainTrack(p).clips[0].duration).toBe(s(4));
  });

  it('keeps keyframed motion continuous across the cut', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    v.keyframes = { x: [{ t: 0, v: 0, ease: 'linear' }, { t: s(4), v: 1, ease: 'linear' }] };
    const out = sliceProject(p, s(1), s(3));
    expect(evaluate(out, 0)[0].x).toBeCloseTo(0.25, 6);
    expect(evaluate(out, s(2) - 1)[0].x).toBeCloseTo(0.75, 5);
    expectSame(p, out, s(1), s(3));
  });

  it('keeps a transition the range starts or ends in', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 5), clip('video', 5, 5, { in: s(2) }));
    a.transition = { id: 'mix', duration: s(2) };
    for (const [lo, hi] of [[5.5, 8], [3, 5.5], [4.5, 5.2], [0, 4.2]]) {
      const out = sliceProject(p, s(lo), s(hi));
      expect(projectDuration(out)).toBe(s(hi - lo));
      expectSame(p, out, s(lo), s(hi));
    }
  });

  it('keeps fades and animations cut by the range edges', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 10, { fadeIn: s(4), fadeOut: s(1), animIn: { id: 'fade-in', duration: s(3) }, animOut: { id: 'fade-out', duration: s(2) } }));
    const out = sliceProject(p, s(2), s(9.5));
    expect(gainAt(mainTrack(out).clips[0], 0)).toBeCloseTo(gainAt(a, s(2)), 6);
    expectSame(p, out, s(2), s(9.5));
    expectSame(p, sliceProject(p, 0, s(5)), 0, s(5));
  });

  it('cuts captions at the range edges', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 10));
    addClip(p, clip('text', 1, 3, { caption: true, text: 'one' }), FREE);
    addClip(p, clip('text', 4, 3, { caption: true, text: 'two' }), FREE);
    expect(captionCues(sliceProject(p, s(2), s(5)))).toEqual([{ start: 0, end: 2, text: 'one' }, { start: 2, end: 3, text: 'two' }]);
  });

  it('limits to chosen clips and the look layers over them', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 4), clip('video', 4, 4));
    const fx = clip('effect', 5, 2);
    const fx2 = clip('effect', 0, 1);
    addClip(p, fx, FREE);
    addClip(p, fx2, FREE);
    const out = sliceProject(p, b.start, s(8), { keep: new Set([b.id]) });
    expect(out.tracks.flatMap((t) => t.clips).map((c) => c.type).sort()).toEqual(['effect', 'video']);
    void a;
  });

  it('drops a transition whose partner is cut away', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4), clip('video', 4, 4));
    a.transition = { id: 'mix', duration: s(1) };
    expect(mainTrack(sliceProject(p, 0, s(3.5))).clips[0].transition).toBeNull();
    expect(mainTrack(sliceProject(p, 0, s(8))).clips[0].transition).toEqual({ id: 'mix', duration: s(1) });
  });
});

describe('exportSpan', () => {
  it('covers the whole timeline, the range or the selection', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 4), clip('video', 4, 4));
    expect(exportSpan(p, 'all')).toEqual({ start: 0, end: s(8) });
    p.range = { in: s(1), out: s(20) };
    expect(exportSpan(p, 'range')).toEqual({ start: s(1), end: s(8) });
    expect(exportSpan(p, 'selection', [b.id])).toEqual({ start: s(4), end: s(8) });
    expect(exportSpan(p, 'selection', [])).toEqual({ start: 0, end: s(8) });
    void a;
  });
});
