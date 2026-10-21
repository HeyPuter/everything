import { describe, it, expect } from 'vitest';
import { US } from '../src/lib/time.js';
import {
  normalizeCurve, curveSpeedAt, curveIntegral, curveInverse, meanSpeed, curveDuration, sliceCurve, mirrorCurve,
  sourceOffset, localAtSource, speedAt, sourceSpan, hasCurve, CURVE_PRESETS, presetOf, presetPoints, flatCurve,
  remapKeyframes, curveTable, CURVE_MIN, CURVE_MAX,
} from '../src/model/speed-curve.js';
import { normalizeClip, normalizeProject } from '../src/model/project.js';
import * as T from '../src/model/timeline.js';
import { sliceProject } from '../src/model/slice.js';
import { evaluate } from '../src/engine/scene.js';
import { beatTimes, needsStretch, sourceRange } from '../src/model/audio.js';
import { fixture, clip, onMain, s } from './helpers.js';

/** Plain numeric integral of the curve's speed (midpoint rule, fine grid). */
function numeric(points, x, n = 200_000) {
  let sum = 0;
  const h = x / n;
  const v = curveTable(points).speed;
  for (let i = 0; i < n; i++) sum += v((i + 0.5) * h);
  return sum * h;
}

const pts = (pairs) => pairs.map(([t, v]) => ({ t, v }));

describe('curve math', () => {
  const curves = [...CURVE_PRESETS.map((p) => p.points), pts([[0, 0.1], [0.2, 10], [0.21, 0.1], [1, 1]])];

  it('integrates the speed accurately', () => {
    for (const c of curves) {
      for (const x of [0.013, 0.25, 0.5, 0.731, 1]) {
        expect(curveIntegral(c, x)).toBeCloseTo(numeric(c, x), 6);
      }
    }
  });

  it('source position only moves forward', () => {
    for (const c of curves) {
      let prev = -1;
      for (let i = 0; i <= 2000; i++) {
        const f = curveIntegral(c, i / 2000);
        expect(f).toBeGreaterThan(prev);
        prev = f;
      }
    }
  });

  it('stays inside its points (no overshoot) and within 0.1x..10x', () => {
    for (const c of curves) {
      const lo = Math.min(...c.map((p) => p.v));
      const hi = Math.max(...c.map((p) => p.v));
      for (let i = 0; i <= 1000; i++) {
        const v = curveSpeedAt(c, i / 1000);
        expect(v).toBeGreaterThanOrEqual(Math.max(CURVE_MIN, lo) - 1e-9);
        expect(v).toBeLessThanOrEqual(Math.min(CURVE_MAX, hi) + 1e-9);
      }
    }
  });

  it('passes through its points', () => {
    const c = CURVE_PRESETS.find((p) => p.id === 'slow-middle').points;
    for (const p of c) expect(curveSpeedAt(c, p.t)).toBeCloseTo(p.v, 9);
  });

  it('inverts the integral', () => {
    for (const c of curves) {
      for (const x of [0, 0.001, 0.1, 0.42, 0.5, 0.99, 1]) {
        expect(curveInverse(c, curveIntegral(c, x))).toBeCloseTo(x, 9);
      }
    }
  });

  it('continues at the end speeds outside 0..1', () => {
    const c = pts([[0, 0.5], [1, 2]]);
    expect(curveIntegral(c, 1.5)).toBeCloseTo(meanSpeed(c) + 0.5 * 2, 9);
    expect(curveIntegral(c, -0.2)).toBeCloseTo(-0.1, 9);
    expect(curveInverse(c, meanSpeed(c) + 1)).toBeCloseTo(1.5, 9);
  });

  it('a flat curve is constant speed', () => {
    const c = flatCurve(2);
    expect(meanSpeed(c)).toBeCloseTo(2, 12);
    expect(curveIntegral(c, 0.3)).toBeCloseTo(0.6, 12);
    expect(curveDuration(c, 10 * US)).toBeCloseTo(5 * US, 3);
  });

  it('normalizes stored curves', () => {
    expect(normalizeCurve(null)).toBe(null);
    expect(normalizeCurve([])).toBe(null);
    expect(normalizeCurve('x')).toBe(null);
    expect(normalizeCurve([{ t: 0.5, v: 50 }])).toEqual([{ t: 0, v: 10 }, { t: 0.5, v: 10 }, { t: 1, v: 10 }]);
    expect(normalizeCurve([{ t: 1, v: 2 }, { t: -1, v: 0 }, { t: 0.5, v: NaN }])).toEqual([{ t: 0, v: 0.1 }, { t: 1, v: 2 }]);
    const long = Array.from({ length: 80 }, (_, i) => ({ t: i / 79, v: 1 + (i % 2) }));
    expect(normalizeCurve(long).length).toBeLessThanOrEqual(32);
  });

  it('presets are recognized and copied', () => {
    expect(CURVE_PRESETS.length).toBeGreaterThanOrEqual(8);
    for (const p of CURVE_PRESETS) {
      const copy = presetPoints(p.id);
      expect(copy).not.toBe(p.points);
      expect(presetOf(copy)).toBe(p.id);
      expect(normalizeCurve(copy)).toEqual(copy);
    }
    expect(presetOf(pts([[0, 1], [1, 1.5]]))).toBe(null);
  });

  it('slices exactly', () => {
    for (const c of curves) {
      for (const [a, b] of [[0, 0.37], [0.37, 1], [0.2, 0.8], [0.5, 1.4], [-0.3, 0.6]]) {
        const piece = sliceCurve(c, a, b);
        expect(piece[0].t).toBe(0);
        expect(piece.at(-1).t).toBe(1);
        for (let i = 0; i <= 50; i++) {
          const x = i / 50;
          const orig = a + x * (b - a);
          if (orig < 0 || orig > 1) continue;
          expect(curveSpeedAt(piece, x)).toBeCloseTo(curveSpeedAt(c, orig), 6);
        }
      }
    }
  });

  it('mirrors for reversed playback', () => {
    for (const c of curves) {
      const m = mirrorCurve(c);
      for (let i = 0; i <= 40; i++) expect(curveSpeedAt(m, i / 40)).toBeCloseTo(curveSpeedAt(c, 1 - i / 40), 9);
      expect(meanSpeed(m)).toBeCloseTo(meanSpeed(c), 9);
    }
  });

  it('remaps keyframes through a mapping and keeps them in range', () => {
    const kf = { opacity: [{ t: 0, v: 0 }, { t: 100, v: 1 }, { t: 200, v: 0.5 }] };
    expect(remapKeyframes(kf, (t) => t * 2, 300)).toEqual({ opacity: [{ t: 0, v: 0 }, { t: 200, v: 1 }, { t: 300, v: 0.5 }] });
  });
});

describe('clips with a speed curve', () => {
  const curve = CURVE_PRESETS.find((p) => p.id === 'ramp-up').points;

  it('constant speed is unchanged and a flat curve matches it', () => {
    const a = clip('video', 1, 4, { in: s(2), speed: 2 });
    const b = clip('video', 1, 4, { in: s(2), speed: 2, speedCurve: flatCurve(2) });
    expect(hasCurve(a)).toBe(false);
    expect(hasCurve(b)).toBe(true);
    for (const t of [1, 1.5, 2.25, 4.9, 5]) expect(T.sourceTimeAt(b, s(t))).toBeCloseTo(T.sourceTimeAt(a, s(t)), 3);
    expect(T.sourceTimeAt(a, s(2))).toBe(s(4));
    expect(sourceSpan(b)).toBeCloseTo(s(8), 3);
  });

  it('maps local time to source time through the curve and back', () => {
    const c = clip('video', 0, 4, { speedCurve: curve });
    for (const u of [0, 0.5, 1, 2.7, 4]) {
      const off = sourceOffset(c, s(u));
      expect(localAtSource(c, off)).toBeCloseTo(s(u), 3);
      expect(off).toBeCloseTo(s(4) * curveIntegral(curve, u / 4), 3);
    }
    expect(speedAt(c, 0)).toBeCloseTo(0.4, 9);
    expect(speedAt(c, s(4))).toBeCloseTo(3, 9);
  });

  it('applying a curve keeps the footage and changes the timeline length', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4, { in: s(1) }));
    expect(T.setSpeedCurve(p, c.id, presetPoints('ramp-up'), { ripple: true })).toBe(true);
    const span = s(4);
    expect(c.duration).toBe(Math.round(span / meanSpeed(curve)));
    expect(c.speed).toBeCloseTo(meanSpeed(curve), 12);
    expect(sourceSpan(c)).toBeCloseTo(span, -1);
    expect(T.sourceTimeAt(c, c.start)).toBe(s(1));
    expect(T.sourceTimeAt(c, c.start + c.duration)).toBeCloseTo(s(5), -1);
  });

  it('without ripple the curve is limited by the next clip', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4), clip('video', 4, 2));
    T.setSpeedCurve(p, c.id, pts([[0, 0.25], [1, 0.25]]), {});
    expect(c.duration).toBe(s(4));
  });

  it('ripples the base track and moves linked overlays', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 4), clip('video', 4, 2));
    const title = clip('text', 4.5, 1);
    T.addClip(p, title, {});
    T.setSpeedCurve(p, a.id, pts([[0, 2], [1, 2]]), { ripple: true, linkOverlays: true });
    expect(a.duration).toBe(s(2));
    expect(b.start).toBe(s(2));
    expect(title.start).toBe(s(2.5));
  });

  it('null goes back to constant 1x, and setSpeed clears the curve', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4));
    T.setSpeedCurve(p, c.id, presetPoints('pulse'), { ripple: true });
    T.setSpeedCurve(p, c.id, null, { ripple: true });
    expect(c.speedCurve).toBeUndefined();
    expect(c.speed).toBe(1);
    expect(c.duration).toBeCloseTo(s(4), -1);
    T.setSpeedCurve(p, c.id, presetPoints('pulse'), { ripple: true });
    T.setSpeed(p, c.id, 2, { ripple: true });
    expect(c.speedCurve).toBeUndefined();
    expect(c.duration).toBeCloseTo(s(2), -1);
  });

  it('keeps keyframes on the same moment of the footage', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4, { keyframes: { opacity: [{ t: 0, v: 0 }, { t: s(1), v: 1 }, { t: s(4), v: 0 }] } }));
    T.setSpeedCurve(p, c.id, presetPoints('ramp-up'), { ripple: true });
    const keys = c.keyframes.opacity;
    expect(keys[0].t).toBe(0);
    expect(keys[2].t).toBe(c.duration);
    // The key that sat on source second 1 still shows source second 1.
    expect(T.sourceTimeAt(c, keys[1].t)).toBeCloseTo(s(1), -2);
    // And back to constant speed: still on that moment.
    T.setSpeed(p, c.id, 1, { ripple: true });
    expect(c.keyframes.opacity[1].t).toBeCloseTo(s(1), -2);
  });

  it('split pieces together play exactly what the original played', () => {
    for (const preset of CURVE_PRESETS) {
      const p = fixture();
      const [c] = onMain(p, clip('video', 1, 4, { in: s(0.5) }));
      T.setSpeedCurve(p, c.id, presetPoints(preset.id), { ripple: false });
      const orig = structuredClone(c);
      const cut = c.start + Math.round(c.duration * 0.37);
      const right = T.splitClip(p, c.id, cut);
      expect(right).toBeTruthy();
      expect(c.duration + right.duration).toBe(orig.duration);
      for (let i = 0; i <= 100; i++) {
        const t = orig.start + Math.round((orig.duration * i) / 100);
        const piece = t < cut ? c : right;
        expect(Math.abs(T.sourceTimeAt(piece, t) - T.sourceTimeAt(orig, t))).toBeLessThan(2);
      }
      expect(c.speed).toBeCloseTo(sourceSpan(c) / c.duration, 9);
      expect(right.speed).toBeCloseTo(sourceSpan(right) / right.duration, 9);
    }
  });

  it('trims keep the remaining part playing the same source times', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4, { in: s(3) }));
    T.setSpeedCurve(p, c.id, presetPoints('slow-middle'), {});
    const orig = structuredClone(c);
    T.trimClip(p, c.id, 'start', c.start + s(1), {});
    T.trimClip(p, c.id, 'end', c.start + c.duration - s(0.5), {});
    for (let t = c.start; t <= c.start + c.duration; t += s(0.1)) expect(Math.abs(T.sourceTimeAt(c, t) - T.sourceTimeAt(orig, t))).toBeLessThan(2);
    // Extending again keeps the middle where it was; the edges continue at the edge speeds.
    T.trimClip(p, c.id, 'start', c.start - s(0.5), {});
    for (let t = orig.start + s(1); t <= c.start + c.duration; t += s(0.1)) expect(Math.abs(T.sourceTimeAt(c, t) - T.sourceTimeAt(orig, t))).toBeLessThan(2);
  });

  it('trim bounds use the edge speeds', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 5, 2, { in: s(2) }));
    T.setSpeedCurve(p, c.id, pts([[0, 2], [1, 0.5]]), { ripple: false });
    const { lo } = T.trimBounds(p, c.id, 'start');
    expect(lo).toBe(c.start - Math.floor(s(2) / 2));
    const { hi } = T.trimBounds(p, c.id, 'end');
    const rest = s(10) - c.in - sourceSpan(c);
    expect(hi).toBe(c.start + Math.floor(c.duration + rest / 0.5));
  });

  it('delete left / right of the playhead slice the curve', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4, { in: s(1) }));
    T.setSpeedCurve(p, c.id, presetPoints('fast-middle'), {});
    const orig = structuredClone(c);
    const t = Math.round(c.duration * 0.6);
    T.trimToPlayhead(p, t, 'left', [c.id], {});
    for (let x = c.start; x <= c.start + c.duration; x += s(0.05)) expect(Math.abs(T.sourceTimeAt(c, x) - T.sourceTimeAt(orig, x))).toBeLessThan(2);
    const p2 = fixture();
    const [d] = onMain(p2, structuredClone(orig));
    T.trimToPlayhead(p2, t, 'right', [d.id], {});
    expect(d.duration).toBe(t);
    for (let x = 0; x <= t; x += s(0.05)) expect(Math.abs(T.sourceTimeAt(d, x) - T.sourceTimeAt(orig, x))).toBeLessThan(2);
  });

  it('freeze frame grabs the curved frame and the still has no curve', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4));
    T.setSpeedCurve(p, c.id, presetPoints('ramp-down'), { ripple: true });
    const t = Math.round(c.duration / 3);
    const want = T.sourceTimeAt(c, t);
    const still = T.freezeFrame(p, c.id, t, s(1), { ripple: true });
    expect(still.in).toBeCloseTo(want, 0);
    expect(still.speedCurve).toBeUndefined();
    expect(still.speed).toBe(1);
  });

  it('detached audio carries the same curve', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4));
    T.setSpeedCurve(p, c.id, presetPoints('stutter'), { ripple: true });
    const audio = T.detachAudio(p, c.id);
    expect(audio.speedCurve).toEqual(c.speedCurve);
    expect(audio.speedCurve).not.toBe(c.speedCurve);
    expect(audio.duration).toBe(c.duration);
    for (const x of [0, 0.3, 0.9]) expect(T.sourceTimeAt(audio, c.duration * x)).toBeCloseTo(T.sourceTimeAt(c, c.duration * x), 6);
  });

  it('duplicate and paste copy the curve', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4));
    T.setSpeedCurve(p, c.id, presetPoints('pulse'), { ripple: true });
    const dup = T.duplicateClip(p, c.id, { ripple: true });
    expect(dup.speedCurve).toEqual(c.speedCurve);
    const [pasted] = T.pasteClips(p, [structuredClone(c)], s(20), {});
    expect(pasted.speedCurve).toEqual(c.speedCurve);
  });

  it('slicing a project for range export cuts the curve too', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4, { in: s(1) }));
    T.setSpeedCurve(p, c.id, presetPoints('ease'), { ripple: true });
    const lo = Math.round(c.duration * 0.25);
    const hi = Math.round(c.duration * 0.8);
    const cut = sliceProject(p, lo, hi);
    const k = T.mainTrack(cut).clips[0];
    expect(T.projectDuration(cut)).toBe(hi - lo);
    for (let x = 0; x <= hi - lo; x += s(0.05)) expect(Math.abs(T.sourceTimeAt(k, x) - T.sourceTimeAt(c, x + lo))).toBeLessThan(2);
  });

  it('the scene and the exporter read source times from the curve', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4));
    T.setSpeedCurve(p, c.id, presetPoints('smash-cut'), { ripple: true });
    for (const x of [0.1, 0.5, 0.52, 0.9]) {
      const t = Math.round(c.duration * x);
      const layer = evaluate(p, t).find((l) => l.clip?.id === c.id);
      expect(layer.sourceTime).toBeCloseTo(T.sourceTimeAt(c, t), 6);
    }
  });

  it('beats and source range follow the curve', () => {
    const c = clip('audio', 2, 4, { in: s(1), speedCurve: presetPoints('ramp-up') });
    c.duration = Math.round(curveDuration(c.speedCurve, s(4)));
    c.beats = [s(1), s(2), s(3), s(4.5)];
    const times = beatTimes(c);
    expect(times.length).toBe(4);
    for (const [i, t] of times.entries()) expect(T.sourceTimeAt(c, t)).toBeCloseTo(c.beats[i], -1);
    expect(sourceRange(c)[1]).toBeCloseTo(5, 4);
    expect(needsStretch(c)).toBe(true);
    expect(needsStretch({ ...c, keepPitch: false })).toBe(false);
    expect(needsStretch({ ...c, speedCurve: flatCurve(1) })).toBe(false);
  });
});

describe('saving and loading', () => {
  it('old clips load without a curve', () => {
    const c = normalizeClip({ type: 'video', id: 'x', assetId: 'a', start: 0, duration: s(2), speed: 2 });
    expect(c.speedCurve).toBeUndefined();
    expect(c.speed).toBe(2);
  });

  it('keeps a curve and derives the mean speed', () => {
    const c = normalizeClip({ type: 'audio', id: 'x', assetId: 'a', start: 0, duration: s(2), speed: 5, speedCurve: [{ t: 0, v: 1 }, { t: 1, v: 3 }] });
    expect(c.speedCurve).toEqual([{ t: 0, v: 1 }, { t: 1, v: 3 }]);
    expect(c.speed).toBeCloseTo(meanSpeed(c.speedCurve), 12);
  });

  it('drops curves on stills, images and broken data', () => {
    expect(normalizeClip({ type: 'video', assetId: 'a', duration: s(2), freeze: true, speedCurve: flatCurve(2) }).speedCurve).toBeUndefined();
    expect(normalizeClip({ type: 'image', assetId: 'a', duration: s(2), speedCurve: flatCurve(2) }).speedCurve).toBeUndefined();
    expect(normalizeClip({ type: 'video', assetId: 'a', duration: s(2), speedCurve: 'fast' }).speedCurve).toBeUndefined();
  });

  it('round-trips a sliced curve with explicit tangents', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4));
    T.setSpeedCurve(p, c.id, presetPoints('slow-middle'), { ripple: true });
    T.splitClip(p, c.id, Math.round(c.duration * 0.4));
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    const a = T.mainTrack(loaded).clips;
    const b = T.mainTrack(p).clips;
    for (let i = 0; i < 2; i++) {
      expect(a[i].speedCurve).toEqual(b[i].speedCurve);
      expect(a[i].speed).toBeCloseTo(b[i].speed, 12);
    }
  });
});
