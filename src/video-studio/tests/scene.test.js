import { describe, it, expect } from 'vitest';
import { evaluate, binaryClipAt, gainAt, audibleClips, upcomingVideoClips, applyAnimations, clipLayer } from '../src/engine/scene.js';
import { addClip, mainTrack } from '../src/model/timeline.js';
import { fixture, clip, onMain, trackOf, s } from './helpers.js';

const RIPPLE = { ripple: true, linkOverlays: true };

/** A project with every visual kind stacked over one base clip. */
function stacked() {
  const p = fixture();
  const [main] = onMain(p, clip('video', 0, 10));
  const overlay = clip('image', 0, 10);
  const text = clip('text', 0, 10);
  const fx = clip('effect', 0, 10, { effect: 'glitch' });
  const filter = clip('filter', 0, 10, { filter: 'noir', intensity: 70 });
  const adjust = clip('adjust', 0, 10);
  const audio = clip('audio', 0, 10);
  for (const c of [overlay, text, fx, filter, adjust, audio]) addClip(p, c, RIPPLE);
  return { p, main, overlay, text, fx, filter, adjust, audio };
}

const state = (fields = {}) => ({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blur: 0, reveal: 1, ...fields });

describe('evaluate', () => {
  it('lists visible layers bottom to top and skips audio', () => {
    const { p, main, overlay, text, fx, filter, adjust } = stacked();
    const layers = evaluate(p, s(1));
    expect(layers.map((l) => l.clip.id)).toEqual([main.id, overlay.id, text.id, fx.id, filter.id, adjust.id]);
    expect(layers.map((l) => l.kind)).toEqual(['media', 'media', 'text', 'effect', 'filter', 'adjust']);
    expect(layers[4]).toMatchObject({ filter: 'noir', intensity: 70 });
    expect(layers[3]).toMatchObject({ effect: 'glitch', local: s(1) });
    // Layers carry their track index so the compositor can cache per track.
    expect(layers.map((l) => l.trackIndex)).toEqual([...layers.map((l) => l.trackIndex)].sort((a, b) => b - a));
  });

  it('skips hidden tracks unless asked to include them', () => {
    const { p, text } = stacked();
    trackOf(p, text.id).hidden = true;
    expect(evaluate(p, s(1)).some((l) => l.clip.id === text.id)).toBe(false);
    expect(evaluate(p, s(1), { includeHidden: true }).some((l) => l.clip.id === text.id)).toBe(true);
  });

  it('shows nothing in gaps and past the end', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2), clip('video', 3, 2));
    expect(evaluate(p, s(2.5))).toEqual([]);
    expect(evaluate(p, s(5))).toEqual([]);
    expect(evaluate(p, s(2) - 1)).toHaveLength(1);
  });

  it('maps timeline time to source time with in point and speed', () => {
    const p = fixture();
    onMain(p, clip('video', 1, 4, { in: s(2), speed: 1.5 }));
    const [layer] = evaluate(p, s(3));
    expect(layer.sourceTime).toBe(s(5));
    expect(layer).toMatchObject({ width: 1920, height: 1080 });
  });

  it('draws a transition across a window centered on the cut', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2, { transition: { id: 'wipe-left', duration: s(1) } }), clip('video', 2, 2, { in: s(3) }));
    expect(evaluate(p, s(1.49))[0].kind).toBe('media');
    const start = evaluate(p, s(1.5))[0];
    expect(start).toMatchObject({ kind: 'transition', id: 'wipe-left', progress: 0 });
    expect(start.from.clip).toBe(a);
    expect(start.to.clip).toBe(b);
    expect(evaluate(p, s(2))[0].progress).toBeCloseTo(0.5);
    expect(evaluate(p, s(2.5) - 1)[0].progress).toBeCloseTo(1, 5);
    expect(evaluate(p, s(2.5))[0]).toMatchObject({ kind: 'media', clip: b });
    // The incoming clip shows frames from before its in point while the transition runs.
    expect(evaluate(p, s(1.75))[0].to.sourceTime).toBe(s(2.75));
    expect(evaluate(p, s(1.75))[0].to.held).toBeUndefined();
  });

  it('holds the picture where a transition runs past the media', () => {
    const p = fixture(); // 'vid' is 10 s long
    onMain(p, clip('video', 0, 2, { in: s(8), transition: { id: 'mix', duration: s(1) } }), clip('video', 2, 2));
    const before = evaluate(p, s(1.75))[0];
    expect(before.to).toMatchObject({ sourceTime: 0, held: true });
    expect(before.from.held).toBeUndefined();
    const after = evaluate(p, s(2.25))[0];
    expect(after.from).toMatchObject({ sourceTime: s(10) - 1000, held: true });
    expect(after.to.held).toBeUndefined();
  });

  it('ignores a transition whose neighbor has moved away', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2, { transition: { id: 'mix', duration: s(1) } }), clip('video', 3, 2));
    const [layer] = evaluate(p, s(1.8));
    expect(layer).toMatchObject({ kind: 'media', clip: a });
  });
});

describe('animations', () => {
  const visual = (fields) => ({ ...clip('text', 0, 4), ...fields });

  it('fades and slides clips in over the in animation', () => {
    const fade = visual({ animIn: { id: 'fade-in', duration: s(1) } });
    expect(applyAnimations(fade, 0, state()).opacity).toBe(0);
    expect(applyAnimations(fade, s(0.5), state()).opacity).toBeCloseTo(0.5);
    expect(applyAnimations(fade, s(1), state()).opacity).toBe(1);
    const slide = visual({ animIn: { id: 'slide-left-in', duration: s(1) } });
    expect(applyAnimations(slide, 0, state()).x).toBeCloseTo(1);
    expect(applyAnimations(slide, s(1), state()).x).toBe(0);
  });

  it('fades clips out over the out animation at the end of the clip', () => {
    const fade = visual({ animOut: { id: 'fade-out', duration: s(1) } });
    expect(applyAnimations(fade, s(3), state()).opacity).toBe(1);
    expect(applyAnimations(fade, s(3.5), state()).opacity).toBeCloseTo(0.5);
    expect(applyAnimations(fade, s(4), state()).opacity).toBeCloseTo(0);
  });

  it('repeats loop animations over their period', () => {
    const spin = visual({ animLoop: { id: 'spin', duration: s(2) } });
    expect(applyAnimations(spin, s(0.5), state()).rotation).toBeCloseTo(90);
    expect(applyAnimations(spin, s(2.5), state()).rotation).toBeCloseTo(90);
    const pulse = visual({ animLoop: { id: 'pulse', duration: s(1) } });
    expect(applyAnimations(pulse, s(0.25), state()).scale).toBeCloseTo(1.08);
  });

  it('reveals typewriter text progressively', () => {
    const tw = visual({ animIn: { id: 'typewriter', duration: s(2) } });
    expect(applyAnimations(tw, s(1), state()).reveal).toBeCloseTo(0.5);
  });

  it('keeps every built-in animation finite at its edges', () => {
    const ids = {
      animIn: ['fade-in', 'zoom-in', 'zoom-out-in', 'slide-left-in', 'slide-right-in', 'slide-up-in', 'slide-down-in', 'rotate-in', 'pop-in', 'bounce-in', 'blur-in', 'typewriter'],
      animOut: ['fade-out', 'zoom-out', 'zoom-in-out', 'slide-left-out', 'slide-right-out', 'slide-up-out', 'slide-down-out', 'rotate-out', 'pop-out', 'blur-out'],
      animLoop: ['sway', 'pulse', 'float', 'spin', 'wobble', 'zoom-loop'],
    };
    for (const [key, list] of Object.entries(ids)) {
      for (const id of list) {
        const c = visual({ [key]: { id, duration: s(1) } });
        for (const t of [0, s(0.5), s(1), s(3), s(3.5), s(4)]) {
          const st = applyAnimations(c, t, state());
          for (const v of Object.values(st)) expect(Number.isFinite(v), `${id} at ${t}`).toBe(true);
          expect(st.scale, `${id} at ${t}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('starts from the keyframed transform and opacity', () => {
    const p = fixture();
    const c = clip('image', 0, 4, {
      keyframes: { x: [{ t: 0, v: 0, ease: 'linear' }, { t: s(2), v: 0.4, ease: 'linear' }], opacity: [{ t: 0, v: 0.2, ease: 'linear' }] },
      transform: { x: 0.9, y: 0.1, scale: 2, rotation: 15, flipH: true, flipV: false },
    });
    const layer = clipLayer(p, c, s(1), 0);
    expect(layer).toMatchObject({ x: 0.2, y: 0.1, scale: 2, rotation: 15, flipH: true, opacity: 0.2 });
  });
});

describe('binaryClipAt', () => {
  it('finds the clip covering t with start inclusive and end exclusive', () => {
    const clips = [clip('image', 0, 1), clip('image', 1, 1), clip('image', 5, 2)];
    expect(binaryClipAt(clips, 0)).toBe(clips[0]);
    expect(binaryClipAt(clips, s(1))).toBe(clips[1]);
    expect(binaryClipAt(clips, s(2))).toBe(null);
    expect(binaryClipAt(clips, s(6.9))).toBe(clips[2]);
    expect(binaryClipAt(clips, s(7))).toBe(null);
    expect(binaryClipAt([], 0)).toBe(null);
  });
});

describe('audio', () => {
  it('ramps gain through fades and volume keyframes', () => {
    const c = clip('audio', 1, 4, { volume: 0.8, fadeIn: s(1), fadeOut: s(2) });
    expect(gainAt(c, s(1))).toBe(0);
    expect(gainAt(c, s(1.5))).toBeCloseTo(0.4);
    expect(gainAt(c, s(2.5))).toBeCloseTo(0.8);
    expect(gainAt(c, s(4))).toBeCloseTo(0.4);
    expect(gainAt(c, s(5))).toBe(0);
    const keyed = clip('audio', 0, 4, { keyframes: { volume: [{ t: 0, v: 0, ease: 'linear' }, { t: s(2), v: 2, ease: 'linear' }] } });
    expect(gainAt(keyed, s(1))).toBeCloseTo(1);
    expect(gainAt({ ...keyed, muted: true }, s(1))).toBe(0);
  });

  it('plays audio clips and the sound of video clips that have it', () => {
    const p = fixture();
    const [withSound, silent, frozen, detached] = onMain(p,
      clip('video', 0, 1), clip('video', 1, 1, { assetId: 'silent' }), clip('video', 2, 1, { freeze: true }), clip('video', 3, 1, { audioDetached: true }));
    const music = clip('audio', 0, 4);
    const mutedClip = clip('audio', 0, 4, { muted: true });
    addClip(p, music, RIPPLE);
    addClip(p, mutedClip, RIPPLE);
    const ids = audibleClips(p).map((x) => x.clip.id);
    expect(ids).toEqual([withSound.id, music.id]);
    expect([silent, frozen, detached].some((c) => ids.includes(c.id))).toBe(false);
    mainTrack(p).muted = true;
    expect(audibleClips(p).map((x) => x.clip.id)).toEqual([music.id]);
  });
});

describe('upcomingVideoClips', () => {
  it('lists video clips that start within the look-ahead, including transition handles', () => {
    const p = fixture();
    const [a, b, c] = onMain(p, clip('video', 0, 2, { transition: { id: 'mix', duration: s(1) } }), clip('video', 2, 2), clip('video', 6, 2));
    expect(upcomingVideoClips(p, 0, s(0.5)).map((x) => x.id)).toEqual([a.id]);
    expect(upcomingVideoClips(p, s(1), s(0.1)).map((x) => x.id)).toEqual([a.id, b.id]);
    expect(upcomingVideoClips(p, s(3), s(3)).map((x) => x.id)).toEqual([b.id, c.id]);
    mainTrack(p).hidden = true;
    expect(upcomingVideoClips(p, 0, s(10))).toEqual([]);
  });
});
