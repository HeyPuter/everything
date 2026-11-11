import { describe, it, expect } from 'vitest';
import { addClip, moveClip, mainTrack, findClip, pruneTracks, resolveOverlaps, mainInsertIndex } from '../src/model/timeline.js';
import { makeTrack } from '../src/model/project.js';
import { fixture, clip, onMain, spans, kinds, trackOf, noOverlaps, s } from './helpers.js';

const RIPPLE = { ripple: true, linkOverlays: true };
const FREE = { ripple: false, linkOverlays: false };

describe('addClip on the base track', () => {
  it('with ripple inserts at the nearest clip boundary and closes gaps', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 4), clip('video', 4, 4));
    const early = clip('video', 1.5, 2); // before A's midpoint: goes first
    addClip(p, early, { ...RIPPLE, main: true });
    expect(mainTrack(p).clips.map((c) => c.id)).toEqual([early.id, a.id, b.id]);
    expect(spans(mainTrack(p))).toEqual([[0, 2], [2, 4], [6, 4]]);

    const middle = clip('video', 4.5, 1); // past A's midpoint (2 to 6): goes after A
    addClip(p, middle, { ...RIPPLE, main: true });
    expect(mainTrack(p).clips.map((c) => c.id)).toEqual([early.id, a.id, middle.id, b.id]);

    const late = clip('video', 99, 1);
    addClip(p, late, { ...RIPPLE, main: true });
    expect(mainTrack(p).clips.at(-1)).toBe(late);
    expect(late.start).toBe(s(11));
  });

  it('without ripple keeps the drop time when there is room', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    const c = clip('image', 6, 2);
    addClip(p, c, { ...FREE, main: true });
    expect(trackOf(p, c.id).main).toBe(true);
    expect(c.start).toBe(s(6));
  });

  it('without ripple puts an overlapping clip on an overlay track above the base track', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    const c = clip('video', 2, 4);
    addClip(p, c, { ...FREE, main: true });
    const track = trackOf(p, c.id);
    expect(track.main).toBeFalsy();
    expect(kinds(p)).toEqual(['video', 'main']);
    expect(c.start).toBe(s(2));
  });

  it('never puts audio on the base track', () => {
    const p = fixture();
    const a = clip('audio', 0, 3);
    addClip(p, a, { ...RIPPLE, main: true });
    expect(trackOf(p, a.id).kind).toBe('audio');
    expect(mainTrack(p).clips).toHaveLength(0);
  });
});

describe('addClip track creation order', () => {
  it('stacks effects, filters and adjustments on top, text above video, audio at the bottom', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 10));
    addClip(p, clip('audio', 0, 5), RIPPLE);
    addClip(p, clip('video', 0, 5), RIPPLE); // overlay
    addClip(p, clip('text', 0, 3), RIPPLE);
    addClip(p, clip('effect', 0, 3), RIPPLE);
    addClip(p, clip('filter', 0, 3), RIPPLE);
    addClip(p, clip('adjust', 0, 3), RIPPLE);
    expect(kinds(p)).toEqual(['adjust', 'filter', 'effect', 'text', 'video', 'main', 'audio']);
  });

  it('opens a new track of the same kind next to the existing ones when they are busy', () => {
    const p = fixture();
    const t1 = clip('text', 0, 3);
    const t2 = clip('text', 1, 3);
    const a1 = clip('audio', 0, 3);
    const a2 = clip('audio', 1, 3);
    for (const c of [t1, t2, a1, a2]) addClip(p, c, RIPPLE);
    expect(kinds(p)).toEqual(['text', 'text', 'main', 'audio', 'audio']);
    // The newer, overlapping text goes above; the newer audio goes below.
    expect(p.tracks[0].clips[0]).toBe(t2);
    expect(p.tracks[4].clips[0]).toBe(a2);
  });

  it('reuses a free track of the right kind instead of creating one', () => {
    const p = fixture();
    addClip(p, clip('text', 0, 2), RIPPLE);
    addClip(p, clip('text', 3, 2), RIPPLE);
    expect(kinds(p)).toEqual(['text', 'main']);
  });

  it('honors trackId only when the track accepts the clip and has room', () => {
    const p = fixture();
    const audioTrack = makeTrack('audio');
    const textTrack = makeTrack('text');
    p.tracks.unshift(textTrack);
    p.tracks.push(audioTrack);
    const wrongKind = clip('text', 0, 2);
    addClip(p, wrongKind, { ...RIPPLE, trackId: audioTrack.id });
    expect(trackOf(p, wrongKind.id)).toBe(textTrack);

    textTrack.locked = true;
    const blocked = clip('text', 5, 2);
    addClip(p, blocked, { ...RIPPLE, trackId: textTrack.id });
    expect(trackOf(p, blocked.id)).not.toBe(textTrack);
  });
});

describe('mainInsertIndex', () => {
  it('picks the boundary nearest the drop time', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2), clip('video', 2, 6));
    expect(mainInsertIndex(p, s(0.9))).toBe(0);
    expect(mainInsertIndex(p, s(1.1))).toBe(1);
    expect(mainInsertIndex(p, s(4.9))).toBe(1);
    expect(mainInsertIndex(p, s(5.1))).toBe(2);
  });
});

describe('moveClip', () => {
  it('moves an overlay clip in time on its own track', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 10));
    const t = clip('text', 1, 2);
    addClip(p, t, RIPPLE);
    expect(moveClip(p, t.id, { start: s(5) }, RIPPLE)).toBe(true);
    expect(t.start).toBe(s(5));
    expect(kinds(p)).toEqual(['text', 'main']);
  });

  it('moves a clip to another track of the same kind', () => {
    const p = fixture();
    const top = makeTrack('text');
    const lower = makeTrack('text');
    p.tracks.unshift(top, lower);
    const t = clip('text', 0, 2);
    lower.clips.push(t);
    moveClip(p, t.id, { start: s(1), trackId: top.id }, RIPPLE);
    expect(trackOf(p, t.id)).toBe(top);
    expect(p.tracks).not.toContain(lower); // emptied track is pruned
  });

  it('refuses a destination track of another kind and keeps the clip on its own track', () => {
    const p = fixture();
    const t = clip('text', 0, 2);
    addClip(p, t, RIPPLE);
    const audio = makeTrack('audio');
    p.tracks.push(audio);
    moveClip(p, t.id, { start: s(3), trackId: audio.id }, RIPPLE);
    expect(trackOf(p, t.id).kind).toBe('text');
    expect(t.start).toBe(s(3));
  });

  it('creates a new track when dropped between tracks', () => {
    const p = fixture();
    const a = clip('text', 0, 2);
    const b = clip('text', 4, 2);
    addClip(p, a, RIPPLE);
    addClip(p, b, RIPPLE);
    moveClip(p, b.id, { start: s(0), newTrackAt: 0 }, RIPPLE);
    expect(kinds(p)).toEqual(['text', 'text', 'main']);
    expect(p.tracks[0].clips).toEqual([b]);
  });

  it('sends a clip dropped onto an occupied overlay spot to a free track', () => {
    const p = fixture();
    const a = clip('text', 0, 4);
    const b = clip('text', 5, 2);
    addClip(p, a, RIPPLE);
    addClip(p, b, RIPPLE);
    moveClip(p, b.id, { start: s(1) }, RIPPLE);
    expect(trackOf(p, b.id)).not.toBe(trackOf(p, a.id));
    expect(b.start).toBe(s(1));
    expect(noOverlaps(p)).toBe(true);
  });

  it('reorders the base track with ripple on', () => {
    const p = fixture();
    const [a, b, c] = onMain(p, clip('video', 0, 2), clip('video', 2, 3), clip('video', 5, 1));
    moveClip(p, a.id, { start: s(5.8) }, RIPPLE); // past C's midpoint once A is lifted out
    expect(mainTrack(p).clips).toEqual([b, c, a]);
    expect(spans(mainTrack(p))).toEqual([[0, 3], [3, 1], [4, 2]]);
  });

  it('leaves a gap on the base track without ripple, and refuses to overlap', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    expect(moveClip(p, b.id, { start: s(6) }, FREE)).toBe(true);
    expect(spans(mainTrack(p))).toEqual([[0, 2], [6, 2]]);
    expect(moveClip(p, b.id, { start: s(1) }, FREE)).toBe(false);
    expect(b.start).toBe(s(6));
    expect(mainTrack(p).clips).toEqual([a, b]);
  });

  it('puts every clip back exactly when a base track move is refused, even ones held at 0', () => {
    const p = fixture();
    const [, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const t = clip('text', 1, 1);
    addClip(p, t, FREE);
    // A 3 s move left holds the title at 0; the base clip has no room there.
    expect(moveClip(p, b.id, { start: s(-1) }, { ...FREE, with: [t.id] })).toBe(false);
    expect(b.start).toBe(s(2));
    expect(t.start).toBe(s(1));
  });

  it('refuses a group move without ripple that would stack a base clip on another', () => {
    const p = fixture();
    const [a, b, c] = onMain(p, clip('video', 0, 2), clip('video', 2, 3), clip('video', 5, 2));
    // C has room further right, but A moving with it would land on B.
    expect(moveClip(p, c.id, { start: s(6) }, { ...FREE, with: [a.id] })).toBe(false);
    expect(spans(mainTrack(p))).toEqual([[0, 2], [2, 3], [5, 2]]);
    expect(mainTrack(p).clips).toEqual([a, b, c]);
    expect(noOverlaps(p)).toBe(true);
  });

  it('moves a group by one offset that stops at 0, keeping its layout', () => {
    const p = fixture();
    const x = clip('text', 0, 1);
    const y = clip('text', 1, 1);
    const lead = clip('effect', 5, 1);
    for (const c of [x, y, lead]) addClip(p, c, FREE);
    // Each clamped on its own, Y would slide onto X at 0.
    expect(moveClip(p, lead.id, { start: s(4.5) }, { ...FREE, with: [x.id, y.id] })).toBe(false);
    expect([x.start, y.start, lead.start]).toEqual([0, s(1), s(5)]);
    expect(trackOf(p, x.id)).toBe(trackOf(p, y.id));
  });

  it('moves grouped clips by the same offset', () => {
    const p = fixture();
    const t = clip('text', 1, 2);
    const fx = clip('effect', 2, 2);
    addClip(p, t, RIPPLE);
    addClip(p, fx, RIPPLE);
    moveClip(p, t.id, { start: s(4) }, { ...RIPPLE, with: [t.id, fx.id] });
    expect(t.start).toBe(s(4));
    expect(fx.start).toBe(s(5));
  });

  it('lets overlay clips on the moved base clip follow it (overlay linking)', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 3));
    const title = clip('text', 2.5, 1);
    addClip(p, title, RIPPLE);
    moveClip(p, b.id, { start: 0 }, RIPPLE); // B to the front
    expect(mainTrack(p).clips).toEqual([b, a]);
    expect(title.start).toBe(s(0.5));
  });

  it('keeps the base track compact when an overlay clip is dropped onto it (overlay linking on)', () => {
    const p = fixture();
    const [a, h] = onMain(p, clip('video', 0, 5), clip('video', 5, 5));
    const x = clip('video', 6, 2); // overlay sitting on H
    addClip(p, x, RIPPLE);
    moveClip(p, x.id, { start: 0, trackId: mainTrack(p).id }, RIPPLE);
    expect(mainTrack(p).clips).toEqual([x, a, h]);
    expect(spans(mainTrack(p))).toEqual([[0, 2], [2, 5], [7, 5]]);
    expect(noOverlaps(p)).toBe(true);
  });

  it('does not move clips on locked tracks', () => {
    const p = fixture();
    const t = clip('text', 1, 2);
    addClip(p, t, RIPPLE);
    trackOf(p, t.id).locked = true;
    expect(moveClip(p, t.id, { start: s(5) }, RIPPLE)).toBe(false);
    expect(t.start).toBe(s(1));
  });
});

describe('pruneTracks and resolveOverlaps', () => {
  it('removes empty tracks but always keeps the base track', () => {
    const p = fixture();
    p.tracks.push(makeTrack('audio'), makeTrack('text'));
    pruneTracks(p);
    expect(kinds(p)).toEqual(['main']);
  });

  it('moves overlapping overlay clips onto other tracks and leaves the base track alone', () => {
    const p = fixture();
    const text = makeTrack('text');
    p.tracks.unshift(text);
    text.clips.push(clip('text', 0, 3), clip('text', 1, 3), clip('text', 2, 3));
    resolveOverlaps(p);
    expect(noOverlaps(p)).toBe(true);
    expect(p.tracks.filter((t) => t.kind === 'text')).toHaveLength(3);
    expect(findClip(p, text.clips[0].id).track).toBe(text);
  });
});
