import { describe, it, expect } from 'vitest';
import { EASINGS, valueAt, splitKeyframes, shiftKeyframes, scaleKeyframes, setKey } from '../src/model/keyframes.js';
import { fixture, clip, onMain, s } from './helpers.js';
import { normalizeProject } from '../src/model/project.js';
import { splitClip, mainTrack, trimClip, setKeyEaseAt } from '../src/model/timeline.js';
import { evaluate } from '../src/engine/scene.js';
import { setEase } from '../src/ui/timeline/keyframe-panel.js';

const names = [...Object.keys(EASINGS), 'cubic(0.3,1.6,0.6,1)'];
const keys = ease => ({ x: [{ t: 0, v: -2, ease }, { t: 4000, v: 8, ease: 'linear' }] });
const at = (kf, t) => valueAt(kf, 'x', t, 0);

describe('preserving eased motion when cutting', () => {
  it.each(names)('keeps both sides of a split on the original %s curve', name => {
    const src = keys(name);
    const [left, right] = splitKeyframes(src, 1700);
    for (let t = 0; t <= 4000; t += 25) {
      expect(at(t <= 1700 ? left : right, t <= 1700 ? t : t - 1700), `${name} at ${t}`).toBeCloseTo(at(src, t), 9);
    }
  });

  it.each(names)('keeps repeated trims and speed changes on the original %s curve', name => {
    const src = keys(name);
    const first = shiftKeyframes(src, -500, 3000);
    const trimmed = shiftKeyframes(first, -300, 1800);
    const slowed = scaleKeyframes(trimmed, 2);
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4));
    c.keyframes = trimmed;
    const saved = mainTrack(normalizeProject(JSON.parse(JSON.stringify(p)))).clips[0].keyframes;
    const [, right] = splitKeyframes(trimmed, 700);
    for (let t = 0; t <= 1800; t += 25) {
      expect(at(trimmed, t), `${name} at ${t}`).toBeCloseTo(at(src, t + 800), 9);
      expect(at(slowed, t * 2)).toBeCloseTo(at(src, t + 800), 9);
      expect(at(saved, t)).toBeCloseTo(at(src, t + 800), 9);
      if (t >= 700) expect(at(right, t - 700)).toBeCloseTo(at(src, t + 800), 9);
    }
  });

  it('keeps a bounce between equal-valued trim endpoints', () => {
    const src = keys('bounce');
    // Two adjacent bounces both reach their maximum at these times.
    const trimmed = shiftKeyframes(src, -4000 / 2.75, 4000 / 2.75);
    expect(at(trimmed, 0)).toBeCloseTo(at(trimmed, 4000 / 2.75));
    expect(at(trimmed, 2000 / 2.75)).toBeCloseTo(at(src, 6000 / 2.75), 9);
    expect(at(trimmed, 2000 / 2.75)).toBeLessThan(at(trimmed, 0));
  });

  it('preserves the rendered motion through timeline split, trim, and save/reopen', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4));
    c.keyframes.x = [{ t: 0, v: 0, ease: 'easeIn' }, { t: s(4), v: 1, ease: 'linear' }];
    const expected = [2.5, 3, 3.5].map(t => evaluate(p, s(t))[0].x);
    const right = splitClip(p, c.id, s(2));
    trimClip(p, right.id, 'start', s(2.25), { ripple: false, linkOverlays: false });
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect([2.5, 3, 3.5].map(t => evaluate(loaded, s(t))[0].x)).toEqual(expected);
  });

  it('lets a new value and a new ease replace the trimmed curve', () => {
    const [left] = splitKeyframes(keys('easeIn'), 2000);
    setKey(left, 'x', 0, 1);
    const b = left.x[1].v;
    expect(at(left, 1000)).toBeCloseTo(1 + (b - 1) / 8);
    const [, right] = splitKeyframes(keys('easeOut'), 2000);
    const c = { keyframes: right };
    setEase(c, 'x', 0, 'easeOut');
    expect(at(right, 1000)).toBeCloseTo(right.x[0].v + (right.x[1].v - right.x[0].v) * 0.875);
  });

  it('lets the timeline easing command replace a retained curve for all properties', () => {
    const [, right] = splitKeyframes(keys('easeOut'), 2000);
    const c = { keyframes: right };
    setKeyEaseAt(c, 0, 'easeOut');
    expect(at(right, 1000)).toBeCloseTo(right.x[0].v + (right.x[1].v - right.x[0].v) * 0.875);
    expect(right.x[0].curve).toBeUndefined();
  });

  it('does not alias retained curve data after copying, splitting, or scaling', () => {
    const trimmed = shiftKeyframes(keys('easeIn'), -500, 3000);
    const [left, right] = splitKeyframes(trimmed, 1000);
    const scaled = scaleKeyframes(trimmed, 2);
    const before = JSON.stringify(trimmed);
    left.x[0].curve.start = 100;
    right.x[0].curve.end = 200;
    scaled.x[0].curve.from = 0;
    expect(JSON.stringify(trimmed)).toBe(before);
  });

  it.each([{ from: -1 }, { to: 2 }, { to: 0.2 }, { end: Infinity }, { ease: 'unknown' }])('drops invalid retained curve data on load: %j', invalid => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4));
    c.keyframes.x = [{ t: 0, v: 0, ease: 'easeIn', curve: { ease: 'easeIn', from: 0.2, to: 0.8, start: 0, end: 1, ...invalid } }, { t: 1000, v: 1, ease: 'linear' }];
    const loaded = mainTrack(normalizeProject(p)).clips[0];
    expect(loaded.keyframes.x[0].curve).toBeUndefined();
    expect(at(loaded.keyframes, 500)).toBeCloseTo(0.125);
  });


  it('retains mixed curves across existing keys and cuts outside the keyed range', () => {
    const src = { x: [
      { t: 500, v: -2, ease: 'easeOut' },
      { t: 1300, v: 3, ease: 'elastic' },
      { t: 2800, v: -4, ease: 'hold' },
      { t: 3600, v: 2, ease: 'cubic(0.3,1.6,0.6,1)' },
      { t: 4200, v: 5, ease: 'linear' },
    ] };
    for (const [lo, hi] of [[0, 4600], [100, 2000], [900, 3900], [1300, 3600], [2800, 3700], [4300, 4800]]) {
      const trimmed = shiftKeyframes(src, -lo, hi - lo);
      for (let i = 0; i <= 40; i++) {
        const t = (hi - lo) * i / 40;
        expect(at(trimmed, t), `${lo}..${hi} at ${t}`).toBeCloseTo(at(src, lo + t), 9);
      }
    }
  });

});
