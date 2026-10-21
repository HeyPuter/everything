import { describe, it, expect } from 'vitest';
import {
  deleteClips, trimToPlayhead, duplicateClip, pasteClips, setSpeed, freezeFrame, detachAudio,
  mainTrack, addClip, captureLinks, compactMain, sourceTimeAt, clipEnd,
} from '../src/model/timeline.js';
import { fixture, clip, onMain, spans, trackOf, noOverlaps, kinds, s } from './helpers.js';

const RIPPLE = { ripple: true, linkOverlays: true };
const FREE = { ripple: false, linkOverlays: false };

describe('deleteClips', () => {
  it('closes the gap on the base track with ripple', () => {
    const p = fixture();
    const [a, , c] = onMain(p, clip('video', 0, 2), clip('video', 2, 3), clip('video', 5, 1));
    expect(deleteClips(p, [mainTrack(p).clips[1].id], RIPPLE)).toBe(1);
    expect(mainTrack(p).clips).toEqual([a, c]);
    expect(spans(mainTrack(p))).toEqual([[0, 2], [2, 1]]);
  });

  it('leaves the gap without ripple', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2), clip('video', 2, 3), clip('video', 5, 1));
    deleteClips(p, [mainTrack(p).clips[1].id], FREE);
    expect(spans(mainTrack(p))).toEqual([[0, 2], [5, 1]]);
  });

  it('keeps overlay clips on the base clip they sit on when overlay linking is on', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 3));
    const onB = clip('text', 3, 1);
    const onA = clip('text', 0.5, 1);
    addClip(p, onB, RIPPLE);
    addClip(p, onA, RIPPLE);
    deleteClips(p, [a.id], RIPPLE);
    expect(b.start).toBe(0);
    expect(onB.start).toBe(s(1));
    expect(onA.start).toBe(s(0.5)); // its host is gone, so it stays put
  });

  it('does not move overlay clips when overlay linking is off', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2), clip('video', 2, 3));
    const t = clip('text', 3, 1);
    addClip(p, t, RIPPLE);
    deleteClips(p, [a.id], { ripple: true, linkOverlays: false });
    expect(t.start).toBe(s(3));
  });

  it('skips clips on locked tracks and prunes emptied tracks', () => {
    const p = fixture();
    const t = clip('text', 0, 1);
    const a = clip('audio', 0, 1);
    addClip(p, t, RIPPLE);
    addClip(p, a, RIPPLE);
    trackOf(p, a.id).locked = true;
    expect(deleteClips(p, [t.id, a.id], RIPPLE)).toBe(1);
    expect(kinds(p)).toEqual(['main', 'audio']);
  });
});

describe('captureLinks', () => {
  it('shifts linked clips by how far their host moved and resolves collisions', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const t1 = clip('text', 2.5, 1);
    const t2 = clip('text', 0.5, 2.5); // on A, overlaps where t1 will land
    addClip(p, t1, RIPPLE);
    addClip(p, t2, RIPPLE);
    const relink = captureLinks(p);
    mainTrack(p).clips = [b, a];
    compactMain(p);
    relink();
    expect(t1.start).toBe(s(0.5));
    expect(t2.start).toBe(s(2.5));
    expect(noOverlaps(p)).toBe(true);
  });
});

describe('trimToPlayhead (Q / W)', () => {
  it('deletes left of the playhead and ripples with ripple', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 4), clip('video', 4, 4));
    expect(trimToPlayhead(p, s(6), 'left', [], RIPPLE)).toBe(1);
    expect(b.in).toBe(s(2));
    expect(spans(mainTrack(p))).toEqual([[0, 4], [4, 2]]);
    expect(a.duration).toBe(s(4));
  });

  it('deletes left of the playhead in place without ripple', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4));
    trimToPlayhead(p, s(1), 'left', [], FREE);
    expect([c.start, c.duration, c.in]).toEqual([s(1), s(3), s(1)]);
  });

  it('deletes right of the playhead', () => {
    const p = fixture();
    const [, b] = onMain(p, clip('video', 0, 4), clip('video', 4, 4));
    trimToPlayhead(p, s(5), 'right', [], RIPPLE);
    expect(b.duration).toBe(s(1));
  });

  it('acts on the given clips instead of the base track', () => {
    const p = fixture();
    const [main] = onMain(p, clip('video', 0, 4));
    const t = clip('text', 0, 4);
    addClip(p, t, RIPPLE);
    expect(trimToPlayhead(p, s(1), 'right', [t.id], RIPPLE)).toBe(1);
    expect(t.duration).toBe(s(1));
    expect(main.duration).toBe(s(4));
  });

  it('ignores clips that are not under the playhead or would become too short', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    expect(trimToPlayhead(p, s(9), 'left', [], RIPPLE)).toBe(0);
    expect(trimToPlayhead(p, s(4) - 2000, 'left', [], RIPPLE)).toBe(0);
  });
});

describe('duplicateClip', () => {
  it('puts the copy right after the original on the base track and ripples', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 3));
    const copy = duplicateClip(p, a.id, RIPPLE);
    expect(mainTrack(p).clips).toEqual([a, copy, b]);
    expect(spans(mainTrack(p))).toEqual([[0, 2], [2, 2], [4, 3]]);
    expect(copy.id).not.toBe(a.id);
    expect(copy.assetId).toBe(a.assetId);
  });

  it('places an overlay copy after the original, on another track if needed', () => {
    const p = fixture();
    const t = clip('text', 0, 2);
    const blocker = clip('text', 2, 1);
    addClip(p, t, RIPPLE);
    addClip(p, blocker, RIPPLE);
    const copy = duplicateClip(p, t.id, RIPPLE);
    expect(copy.start).toBe(s(2));
    expect(trackOf(p, copy.id)).not.toBe(trackOf(p, t.id));
    expect(noOverlaps(p)).toBe(true);
  });

  it('does not share nested objects with the original', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2));
    const copy = duplicateClip(p, a.id, RIPPLE);
    copy.transform.x = 0.5;
    expect(a.transform.x).toBe(0);
  });
});

describe('pasteClips', () => {
  it('pastes at the playhead keeping relative layout, with fresh ids', () => {
    const p = fixture();
    const src = [{ ...clip('text', 1, 1), _main: false }, { ...clip('text', 3, 1), _main: false }];
    const pasted = pasteClips(p, src, s(10), RIPPLE);
    expect(pasted.map((c) => c.start)).toEqual([s(10), s(12)]);
    expect(pasted.map((c) => c.id)).not.toContain(src[0].id);
  });

  it('returns base-track clips to the base track', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2));
    const pasted = pasteClips(p, [{ ...structuredClone(a), _main: true }], s(2), RIPPLE);
    expect(trackOf(p, pasted[0].id).main).toBe(true);
    expect(spans(mainTrack(p))).toEqual([[0, 2], [2, 2]]);
  });

  it('keeps a title on its pasted base clip, wherever the ripple insert lands', () => {
    const board = (p, titleFirst) => {
      const [a] = onMain(p, clip('video', 0, 5), clip('video', 5, 5));
      const t = clip('text', 1, 2);
      addClip(p, t, FREE);
      const items = [{ ...structuredClone(a), _main: true }, { ...structuredClone(t), _main: false }];
      return titleFirst ? items.reverse() : items;
    };
    for (const [at, titleFirst, lands] of [[5, true, 5], [7, false, 5], [0, true, 0], [9, true, 10]]) {
      const p = fixture();
      const pasted = pasteClips(p, board(p, titleFirst), s(at), RIPPLE);
      const video = pasted.find((c) => c.type === 'video');
      const title = pasted.find((c) => c.type === 'text');
      expect(video.start).toBe(s(lands));
      expect(title.start - video.start).toBe(s(1));
      expect(title._main).toBeUndefined();
      expect(noOverlaps(p)).toBe(true);
    }
  });

  it('pastes several base clips together, with overlays on the ones they sat on', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 3), clip('video', 5, 4));
    const t = clip('text', 3, 1); // over b
    addClip(p, t, FREE);
    const items = [t, b, a].map((c) => ({ ...structuredClone(c), _main: c !== t }));
    const pasted = pasteClips(p, items, s(6), RIPPLE);
    expect(spans(mainTrack(p))).toEqual([[0, 2], [2, 3], [5, 2], [7, 3], [10, 4]]);
    expect(pasted.find((c) => c.type === 'text').start).toBe(s(8));
  });

  it('skips clips whose media is no longer in the project', () => {
    const p = fixture();
    const orphan = clip('video', 0, 2, { assetId: 'gone' });
    expect(pasteClips(p, [orphan], 0, RIPPLE)).toEqual([]);
  });
});

describe('setSpeed', () => {
  it('changes the duration so the same source span plays', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4));
    setSpeed(p, c.id, 2, RIPPLE);
    expect(c.duration).toBe(s(2));
    expect(sourceTimeAt(c, clipEnd(c))).toBe(s(4));
  });

  it('scales keyframe times with the new duration', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4, { keyframes: { x: [{ t: s(1), v: 0, ease: 'linear' }, { t: s(4), v: 1, ease: 'linear' }] } }));
    setSpeed(p, c.id, 0.5, RIPPLE);
    expect(c.keyframes.x.map((k) => k.t)).toEqual([s(2), s(8)]);
  });

  it('ripples base clips with ripple but stops at the neighbor without it', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    setSpeed(p, a.id, 0.5, RIPPLE);
    expect(spans(mainTrack(p))).toEqual([[0, 4], [4, 2]]);
    setSpeed(p, b.id, 0.25, FREE);
    expect(b.duration).toBe(s(8));
    setSpeed(p, a.id, 0.1, FREE); // would be 20 s, but B starts at 4 s
    expect(a.duration).toBe(s(4));
    expect(a.speed).toBe(0.1);
  });

  it('clamps speed to 0.1x..100x and ignores clips without a source', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4));
    setSpeed(p, c.id, 1000, RIPPLE);
    expect(c.speed).toBe(100);
    const t = clip('text', 0, 2);
    addClip(p, t, RIPPLE);
    expect(setSpeed(p, t.id, 2, RIPPLE)).toBe(false);
  });

  it('shortens a transition that no longer fits', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2, { transition: { id: 'mix', duration: s(1.5) } }), clip('video', 2, 4));
    setSpeed(p, a.id, 2, RIPPLE);
    expect(a.transition.duration).toBe(s(1));
  });
});

describe('freezeFrame', () => {
  it('inserts a muted still of the frame at the playhead and ripples with ripple', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4, { in: s(1), animOut: { id: 'fade-out', duration: s(0.5) } }));
    const still = freezeFrame(p, c.id, s(1), s(3), RIPPLE);
    expect(still).toMatchObject({ freeze: true, in: s(2), start: s(1), duration: s(3), muted: true, speed: 1, animOut: null });
    expect(spans(mainTrack(p))).toEqual([[0, 1], [1, 3], [4, 3]]);
    expect(mainTrack(p).clips[1]).toBe(still);
  });

  it('pushes later clips on the same track without ripple', () => {
    const p = fixture();
    const [c, after] = onMain(p, clip('video', 0, 4), clip('video', 6, 2));
    freezeFrame(p, c.id, s(2), s(1), FREE);
    expect(spans(mainTrack(p))).toEqual([[0, 2], [2, 1], [3, 2], [7, 2]]);
    expect(after.start).toBe(s(7));
  });

  it('never leaves overlapping clips when the playhead is within a frame of an edge', () => {
    for (const opts of [RIPPLE, FREE]) {
      for (const [t, index] of [[s(4) - 5000, 2], [s(1) + 5000, 1]]) {
        const p = fixture();
        const [, c] = onMain(p, clip('video', 0, 1), clip('video', 1, 3), clip('video', 4, 2));
        const still = freezeFrame(p, c.id, t, s(1), opts);
        expect(noOverlaps(p)).toBe(true);
        expect(mainTrack(p).clips.reduce((sum, x) => sum + x.duration, 0)).toBe(s(7));
        // Before the clip near its start, after it near its end.
        expect(mainTrack(p).clips.indexOf(still)).toBe(index);
      }
    }
  });

  it('only works on video clips with the playhead inside them', () => {
    const p = fixture();
    const [img, vid] = onMain(p, clip('image', 0, 2), clip('video', 2, 2));
    expect(freezeFrame(p, img.id, s(1), s(1), RIPPLE)).toBe(null);
    expect(freezeFrame(p, vid.id, s(5), s(1), RIPPLE)).toBe(null);
  });
});

describe('detachAudio', () => {
  it('moves the sound to an audio clip and mutes the video', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 1, 4, { in: s(2), volume: 0.5, fadeIn: s(1), keyframes: { volume: [{ t: 0, v: 1, ease: 'linear' }], x: [{ t: 0, v: 1, ease: 'linear' }] } }));
    const a = detachAudio(p, v.id);
    expect(a).toMatchObject({ type: 'audio', assetId: 'vid', start: s(1), duration: s(4), in: s(2), volume: 0.5, fadeIn: s(1), muted: false });
    expect(Object.keys(a.keyframes)).toEqual(['volume']);
    expect(v.muted).toBe(true);
    expect(v.audioDetached).toBe(true);
    expect(trackOf(p, a.id).kind).toBe('audio');
  });

  it('refuses media without sound and does not detach twice', () => {
    const p = fixture();
    const [silent, v] = onMain(p, clip('video', 0, 2, { assetId: 'silent' }), clip('video', 2, 2));
    expect(detachAudio(p, silent.id)).toBe(null);
    expect(detachAudio(p, v.id)).not.toBe(null);
    expect(detachAudio(p, v.id)).toBe(null);
  });
});
