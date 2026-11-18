import { it, expect } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createCompound, breakApart } from '../src/model/compound.js';
import { createMulticam, flattenMulticam } from '../src/model/multicam-edit.js';
import { addClip, setTransition } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { evaluate, audibleClips, gainAt, upcomingVideoStarts } from '../src/engine/scene.js';

const FREE = { ripple: false, linkOverlays: false };
const view = l => Object.fromEntries(['kind', 'x', 'y', 'scale', 'rotation', 'opacity', 'reveal', 'blur', 'local', 'fxTime', 'fxDur', 'textAnim', 'sourceTime'].filter(k => k in l).map(k => [k, l[k]]));
const compare = (a, b) => {
  expect(Object.keys(a)).toEqual(Object.keys(b));
  for (const k of Object.keys(a)) if (typeof b[k] === 'number') expect(a[k], k).toBeCloseTo(b[k], 6); else expect(a[k], k).toEqual(b[k]);
};

it.each(['float', 'fade-in', 'fade-out', 'typewriter', 'sticker', 'effect'])('keeps the child clock when a compound window clips %s', mode => {
  const p = fixture();
  const type = mode === 'typewriter' ? 'text' : mode === 'sticker' ? 'sticker' : 'video';
  const v = clip(type, 0, 4);
  if (type === 'video') onMain(p, v); else addClip(p, v, FREE);
  if (mode === 'float') v.animLoop = { id: 'float', duration: s(4) };
  if (mode === 'fade-in' || mode === 'typewriter') v.animIn = { id: mode, duration: s(2) };
  if (mode === 'fade-out') v.animOut = { id: mode, duration: s(2) };
  if (mode === 'effect') v.effects = [{ id: 'glitch', on: true, params: {} }];
  const times = [1.25, 1.75, 2.5].map(s);
  const expected = times.map(t => view(evaluate(p, t)[0]));
  const c = createCompound(p, [v.id], FREE);
  c.in = s(1); c.duration = s(2); c.start = s(3);
  const saved = normalizeProject(JSON.parse(JSON.stringify(p)));
  for (const q of [p, saved]) times.forEach((t, i) => compare(view(evaluate(q, t + s(2))[0]), expected[i]));
  expect(evaluate(p, s(2.999))).toEqual([]);
  expect(evaluate(p, s(5))).toEqual([]);
});

it('keeps sound fades and keyed gain in their original clock while bounding the scheduled sound', () => {
  const p = fixture(); const [v] = onMain(p, clip('video', 0, 4));
  v.fadeIn = s(2); v.fadeOut = s(2);
  v.keyframes.volume = [{ t: 0, v: 0.2, ease: 'easeIn' }, { t: s(4), v: 0.8, ease: 'linear' }];
  const expected = [1.25, 1.75, 2.5].map(t => gainAt(v, s(t)));
  const c = createCompound(p, [v.id], FREE); c.in = s(1); c.duration = s(2); c.start = s(3);
  const [{ clip: heard }] = audibleClips(p);
  expect([heard.start, heard.duration, heard.in]).toEqual([s(3), s(2), s(1)]);
  [3.25, 3.75, 4.5].forEach((t, i) => expect(gainAt(heard, s(t))).toBeCloseTo(expected[i], 8));
});

it('keeps both child and parent clocks through repeated nested windows', () => {
  const p = fixture(); const [v] = onMain(p, clip('video', 0, 4));
  v.animLoop = { id: 'float', duration: s(3) };
  const inner = createCompound(p, [v.id], FREE);
  inner.animIn = { id: 'zoom-in', duration: s(2) };
  inner.animOut = { id: 'fade-out', duration: s(2) };
  const expected = view(evaluate(p, s(1.5))[0]);
  const outer = createCompound(p, [inner.id], FREE);
  outer.in = s(1); outer.duration = s(2); outer.start = s(2);
  compare(view(evaluate(p, s(2.5))[0]), expected);
  const more = createCompound(p, [outer.id], FREE);
  more.in = s(0.25); more.duration = s(1.5); more.start = s(4);
  compare(view(evaluate(p, s(4.25))[0]), expected);
});

it.each([[1.6, 1.9], [2.1, 2.4], [1.7, 2.3]])('keeps a transition clipped to [%s, %s] including the off-window partner', (lo, hi) => {
  const p = fixture(); const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2, { assetId: 'silent' }));
  setTransition(p, a.id, 'mix', s(1));
  const c = createCompound(p, [a.id, b.id], FREE); c.in = s(lo); c.duration = s(hi - lo); c.start = s(3);
  const time = s((lo + hi) / 2), at = s(3) + time - s(lo);
  const [layer] = evaluate(p, at);
  expect(layer.kind).toBe('transition');
  expect(layer.progress).toBeCloseTo((time - s(1.5)) / s(1));
  expect(layer.from.sourceTime).toBe(time);
  expect(layer.to.sourceTime).toBe(Math.max(0, time - s(2)));
  expect(evaluate(p, s(3) - 1)).toEqual([]);
  expect(evaluate(p, s(3) + c.duration)).toEqual([]);
  expect(new Set(upcomingVideoStarts(p, s(2.9), s(0.5)).map(u => u.clip.assetId))).toEqual(new Set(['vid', 'silent']));
});

it.each([0, 1, 'follow'])('keeps partial transitions around a camera cutaway (audio %s)', audio => {
  const p = fixture(); const [a] = onMain(p, clip('video', 0, 2));
  const b = clip('video', 0, 4, { assetId: 'silent' }); addClip(p, b, FREE);
  const c = createMulticam(p, [a.id, b.id], FREE);
  c.sequence.tracks[0].clips.push(clip('video', 2, 2, { assetId: 'img' }));
  setTransition(c.sequence, a.id, 'mix', s(1));
  c.multicam.audio = audio; c.multicam.cuts = [{ t: 0, angle: 0 }, { t: s(1.9), angle: 1 }, { t: s(2.1), angle: 0 }];
  for (const [time, kind] of [[1.75, 'transition'], [1.95, 'media'], [2.05, 'media'], [2.25, 'transition']]) {
    const layers = evaluate(p, s(time)); expect(layers).toHaveLength(1);
    expect(layers[0].kind).toBe(kind);
    if (kind === 'transition') expect(layers[0].progress).toBeCloseTo(time - 1.5);
    else expect(layers[0].asset.id).toBe('silent');
  }
});

it('does not let a clipped transition bleed into the neighboring compound', () => {
  const p = fixture();
  const [a, b, c, d] = onMain(p, clip('video', 0, 2), clip('video', 2, 2), clip('video', 4, 2, { assetId: 'silent' }), clip('video', 6, 2, { assetId: 'silent' }));
  setTransition(p, a.id, 'mix', s(1)); setTransition(p, c.id, 'mix', s(1));
  const first = createCompound(p, [a.id, b.id], FREE), second = createCompound(p, [c.id, d.id], FREE);
  Object.assign(first, { start: 0, in: s(1.7), duration: s(0.6) });
  Object.assign(second, { start: s(0.6), in: s(1.7), duration: s(0.6) });
  const raw = JSON.stringify(p);
  for (const [time, asset, progress] of [[0, 'vid', 0.2], [0.5, 'vid', 0.7], [0.6, 'silent', 0.2], [1.1, 'silent', 0.7]]) {
    const layers = evaluate(p, s(time)); expect(layers).toHaveLength(1);
    expect(layers[0].kind).toBe('transition');
    expect(layers[0].from.asset.id).toBe(asset);
    expect(layers[0].progress).toBeCloseTo(progress);
  }
  expect(evaluate(p, s(1.2))).toEqual([]);
  expect(JSON.stringify(p)).toBe(raw);
});

it('preloads the first visible frame and retains continuity between ordinary split pieces', () => {
  const p = fixture(); const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2, { in: s(2) }));
  const c = createCompound(p, [a.id, b.id], FREE); c.in = s(1); c.duration = s(2); c.start = s(2);
  const upcoming = upcomingVideoStarts(p, s(1.9), s(2));
  expect(upcoming.map(u => [u.from, u.sourceTime])).toEqual([[s(2), s(1)], [s(3), s(2)]]);
  expect(upcoming[1].prev.id).toBe(upcoming[0].clip.id);
  setTransition(c.sequence, a.id, 'mix', s(1)); p.modified++;
  const withTransition = upcomingVideoStarts(p, s(1.9), s(2));
  expect(withTransition.map(u => [u.from, u.sourceTime])).toEqual([[s(2), s(1)], [s(2.5), s(1.5)]]);
});


it.each(['float', 'typewriter', 'effect', 'audio fade'])('keeps clipped %s timing after break apart and save', mode => {
  const p = fixture();
  const v = clip(mode === 'typewriter' ? 'text' : 'video', 0, 4);
  if (v.type === 'video') onMain(p, v); else addClip(p, v, FREE);
  if (mode === 'float') v.animLoop = { id: 'float', duration: s(4) };
  if (mode === 'typewriter') v.animIn = { id: 'typewriter', duration: s(2) };
  if (mode === 'effect') v.effects = [{ id: 'glitch', params: {} }];
  if (mode === 'audio fade') { v.fadeIn = s(2); v.fadeOut = s(2); }
  const c = createCompound(p, [v.id], FREE); c.in = s(1); c.duration = s(2);
  const times = [0.25, 0.75, 1.5].map(s);
  const before = times.map(t => view(evaluate(p, t)[0]));
  const gain = (q, t) => audibleClips(q).filter(({ clip: c }) => c.start <= t && t < c.start + c.duration).reduce((sum, { clip: c }) => sum + gainAt(c, t), 0);
  const sound = times.map(t => gain(p, t));
  breakApart(p, c.id, FREE);
  for (const q of [p, normalizeProject(JSON.parse(JSON.stringify(p)))]) times.forEach((t, i) => {
    compare(view(evaluate(q, t)[0]), before[i]);
    expect(gain(q, t)).toBeCloseTo(sound[i], 8);
  });
});

it.each([0, 1, 'follow'])('keeps both transition fragments after flattening a cutaway and save (audio %s)', audio => {
  const p = fixture(); const [a] = onMain(p, clip('video', 0, 2));
  const b = clip('video', 0, 4, { assetId: 'silent' }); addClip(p, b, FREE);
  const c = createMulticam(p, [a.id, b.id], FREE);
  c.sequence.tracks[0].clips.push(clip('video', 2, 2, { assetId: 'silent' }));
  setTransition(c.sequence, a.id, 'mix', s(1));
  c.multicam.audio = audio; c.multicam.cuts = [{ t: 0, angle: 0 }, { t: s(1.9), angle: 1 }, { t: s(2.1), angle: 0 }];
  const signature = l => l.kind === 'transition' ? { kind: l.kind, progress: l.progress, from: view(l.from), to: view(l.to) } : view(l);
  const times = [1.75, 1.95, 2.05, 2.25].map(s);
  const expected = times.map(t => evaluate(p, t).map(signature));
  flattenMulticam(p, c.id);
  for (const q of [p, normalizeProject(JSON.parse(JSON.stringify(p)))]) times.forEach((t, i) => expect(evaluate(q, t).map(signature)).toEqual(expected[i]));
});
