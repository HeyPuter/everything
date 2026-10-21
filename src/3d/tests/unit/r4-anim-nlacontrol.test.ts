// @vitest-environment happy-dom
// NLA animated influence against values recorded in the reference app: turning it on keys the
// stored influence (0) at the strip start; a key of 0.5 at frame 15 then gives the recorded results.
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/object';
import type { NlaStrip, ObjectData } from '../../src/data/types';
import { keyProperty } from '../../src/anim/keyframes';
import { applyAnimData, stripInfluence } from '../../src/anim/evaluate';
import { setAnimatedInfluence, keyStripInfluence, influenceCurve } from '../../src/animation/nlacontrol';
import { makeStrip } from '../../src/animation/actionops';

let cube: ObjectData;
let strip: NlaStrip;

beforeEach(() => {
  setApp(new App(startupDocument()));
  cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
  for (const [f, x] of [
    [1, 0],
    [21, 2],
  ]) {
    cube.location[0] = x;
    keyProperty(app.doc, cube, 'location', 0, f);
  }
  const ad = cube.animation_data!;
  strip = makeStrip(app.doc.actions[ad.action!], 1);
  ad.nla_tracks.push({ name: 'NlaTrack', strips: [strip], mute: false, is_solo: false });
  ad.action = null;
});

describe('NLA animated influence', () => {
  it('turning it on keys the stored influence at the strip start', () => {
    setAnimatedInfluence(strip, true);
    expect(influenceCurve(strip)!.keyframe_points.map((k) => [k.co[0], k.co[1]])).toEqual([[1, 0]]);
    expect(stripInfluence(strip, 10)).toBe(0);
  });
  it('keyed influence matches the reference', () => {
    setAnimatedInfluence(strip, true);
    keyStripInfluence(strip, 15, 0.5);
    const REF: [number, number, number][] = [
      [1, 0, 0],
      [10, 0.3013, 0.3542],
      [15, 0.784, 0.5],
      [21, 1.0, 0.5],
    ];
    for (const [f, x, w] of REF) {
      applyAnimData(app.doc, cube, cube.animation_data!, f);
      expect(cube.location[0], `x @${f}`).toBeCloseTo(x, 3);
      expect(stripInfluence(strip, f), `influence @${f}`).toBeCloseTo(w, 3);
    }
  });
  it('turning it off keeps the keys and restores full influence', () => {
    setAnimatedInfluence(strip, true);
    keyStripInfluence(strip, 15, 0.5);
    setAnimatedInfluence(strip, false);
    expect(influenceCurve(strip)!.keyframe_points.length).toBe(2);
    applyAnimData(app.doc, cube, cube.animation_data!, 21);
    expect(cube.location[0]).toBeCloseTo(2, 5);
  });
});
