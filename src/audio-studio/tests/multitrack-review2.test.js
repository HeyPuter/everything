// Regression tests for multitrack fixes from the second pass of the adversarial review.
import { describe, it, expect } from 'vitest';
import * as S from '../src/model/session-edits.js';
import { remixClip, unremixClip, revertRemixes } from '../src/model/clip-remix.js';

describe('reverting part of a remixed clip', () => {
  const segs = [
    [100, 400],
    [200, 500],
    [700, 1000],
  ];
  const remixed = () =>
    remixClip(
      S.createClip({
        trackId: 't',
        sourceId: 'orig',
        start: 300,
        offset: 100,
        length: 500,
        fadeOut: { length: 80, curve: 0 },
      }),
      { target: 900 },
      segs,
      'k',
    );

  it('returns each piece of a split remix to its own share of the original, without duplicating it', () => {
    let s = S.addClips(S.createSessionState({ tracks: 0 }), [remixed()]);
    s = S.splitClips(s, null, 300 + 450);
    const [left, right] = s.clips;
    const back = revertRemixes(s, [left.id, right.id]);
    const [l, r] = back.clips;
    expect(l).toMatchObject({
      sourceId: 'orig',
      start: 300,
      offset: 100,
      length: 250,
      remix: null,
    });
    expect(r).toMatchObject({
      sourceId: 'orig',
      start: 750,
      offset: 350,
      length: 250,
      remix: null,
    });
    // Together they hold the original range once.
    expect(l.offset + l.length).toBe(r.offset);
    expect(r.offset + r.length).toBe(600);
    expect(r.fadeOut.length).toBe(80);
    // A whole remixed clip still goes back to the whole original range.
    expect(unremixClip(remixed())).toMatchObject({ offset: 100, length: 500 });
  });
});
