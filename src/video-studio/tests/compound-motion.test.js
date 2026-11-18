import { describe, it, expect } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createCompound, breakApart } from '../src/model/compound.js';
import { createMulticam, flattenMulticam } from '../src/model/multicam-edit.js';
import { addClip, mainTrack, splitClip, trimClip, setSpeed, setSpeedCurve, detachAudio, freezeFrame } from '../src/model/timeline.js';
import { sourceOffset, localAtSource } from '../src/model/speed-curve.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { normalizeProject } from '../src/model/project.js';
import { evaluate, audibleClips, gainAt, inheritedDelta } from '../src/engine/scene.js';

const FREE = { ripple: false, linkOverlays: false };
const keys = (a, b, ease = 'linear') => [{ t: 0, v: a, ease }, { t: s(4), v: b, ease: 'linear' }];
function frame(p, t) {
  const layer = evaluate(p, t).find(l => l.kind === 'media');
  const out = {};
  if (layer) for (const prop of ['x', 'y', 'scale', 'rotation', 'opacity', 'blur']) out[prop] = layer[prop];
  out.gain = audibleClips(p).filter(({ clip: c }) => c.start <= t && t < c.start + c.duration).reduce((sum, { clip: c }) => sum + gainAt(c, t), 0);
  return out;
}
function same(a, b) {
  expect(Object.keys(a)).toEqual(Object.keys(b));
  for (const key of Object.keys(b)) expect(a[key], key).toBeCloseTo(b[key], 8);
}
function setup(mode, multicam = false) {
  const p = fixture();
  const [v] = onMain(p, clip('video', 0, 4));
  if (mode === 'child keys') v.keyframes = { x: keys(0, 0.4), y: keys(0.2, -0.1, 'easeIn'), opacity: keys(0, 1, 'overshoot'), volume: keys(0.2, 1) };
  if (mode === 'child animations') { v.animIn = { id: 'slide-up-in', duration: s(2) }; v.animOut = { id: 'fade-out', duration: s(2) }; }
  let c;
  if (multicam) { const b = clip('video', 0, 4); addClip(p, b, FREE); c = createMulticam(p, [v.id, b.id], FREE); }
  else c = createCompound(p, [v.id], FREE);
  Object.assign(c.transform, { x: 0.1, y: 0.2, scale: 0.5, rotation: 35, flipH: true });
  c.opacity = 0.5; c.volume = 0.5;
  if (mode === 'parent keys') c.keyframes = { x: keys(0, 0.2), scale: keys(0.4, 0.8), rotation: keys(10, 90), opacity: keys(0, 1), volume: keys(0.2, 0.9) };
  if (mode === 'parent animations') { c.animIn = { id: 'blur-in', duration: s(2) }; c.animLoop = { id: 'float', duration: s(2) }; c.animOut = { id: 'fade-out', duration: s(1) }; c.fadeIn = s(1); c.fadeOut = s(1); }
  return { p, c };
}

describe('motion retained after flattening', () => {
  it.each(['child keys', 'child animations', 'parent keys', 'parent animations'].flatMap(mode => [false, true].map(multicam => ({ mode, multicam }))))('keeps $mode (multicam: $multicam) through flatten and reopen', ({ mode, multicam }) => {
    const { p, c } = setup(mode, multicam);
    const times = [0.25, 0.75, 1.5, 2.5, 3.75].map(s);
    const before = times.map(t => frame(p, t));
    if (multicam) flattenMulticam(p, c.id); else breakApart(p, c.id, FREE);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    for (let i = 0; i < times.length; i++) { same(frame(p, times[i]), before[i]); same(frame(loaded, times[i]), before[i]); }
  });

  it('keeps motion attached when a flattened clip moves, splits, and trims', () => {
    const { p, c } = setup('parent animations');
    const expected = [0.5, 1.5, 2.5, 3.5].map(t => frame(p, s(t)));
    breakApart(p, c.id, FREE);
    const child = mainTrack(p).clips[0];
    child.start = s(2);
    const right = splitClip(p, child.id, s(4));
    trimClip(p, right.id, 'start', s(4.25), FREE);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    for (let i = 0; i < expected.length; i++) same(frame(loaded, s(i + 2.5)), expected[i]);
  });

  it('keeps nested group motion when both levels are broken apart', () => {
    const { p, c } = setup('parent animations');
    const outer = createCompound(p, [c.id], FREE);
    outer.keyframes.x = keys(-0.2, 0.3, 'easeOut');
    outer.volume = 0.7;
    const times = [0.5, 1.5, 2.5, 3.5].map(s);
    const expected = times.map(t => frame(p, t));
    breakApart(p, outer.id, FREE);
    breakApart(p, mainTrack(p).clips[0].id, FREE);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    times.forEach((t, i) => same(frame(loaded, t), expected[i]));
  });

  it('retimes retained motion with speed and keeps it when sound is detached', () => {
    const { p, c } = setup('parent animations');
    const expected = [0.5, 1.5, 2.5, 3.5].map(t => frame(p, s(t)));
    breakApart(p, c.id, FREE);
    const v = mainTrack(p).clips[0];
    setSpeed(p, v.id, 2, FREE);
    detachAudio(p, v.id);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    expected.forEach((f, i) => same(frame(loaded, s((i + 0.5) / 2)), f));
  });

  it('maps preview moves through retained scaling, rotation, and flips', () => {
    const { p, c } = setup('parent animations');
    breakApart(p, c.id, FREE);
    const v = mainTrack(p).clips[0];
    const before = frame(p, s(1));
    const delta = inheritedDelta(v, s(1), 10 / p.settings.width, -5 / p.settings.height, p);
    v.transform.x += delta.x; v.transform.y += delta.y;
    const after = frame(p, s(1));
    expect((after.x - before.x) * p.settings.width).toBeCloseTo(10, 8);
    expect((after.y - before.y) * p.settings.height).toBeCloseTo(-5, 8);
  });

  it.each(['image', 'video'])('keeps animation on a frozen %s and through later trimming', type => {
    const p = fixture();
    const [v] = onMain(p, clip(type, 0, 4, { freeze: type === 'video', muted: true }));
    const c = createCompound(p, [v.id], FREE);
    c.animLoop = { id: 'float', duration: s(4) };
    const before = frame(p, s(1.5));
    breakApart(p, c.id, FREE);
    const restored = mainTrack(p).clips[0];
    trimClip(p, restored.id, 'start', s(1), FREE);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    same(frame(loaded, s(1.5)), before);
  });

  it('keeps the captured clock with an existing speed curve, trims, and a different curve', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4, { in: s(1) }));
    setSpeedCurve(p, v.id, [{ t: 0, v: 0.5 }, { t: 0.4, v: 2 }, { t: 1, v: 1 }], FREE);
    const c = createCompound(p, [v.id], FREE);
    c.keyframes.x = keys(0, 0.4, 'easeIn');
    c.fadeIn = s(2);
    const times = [0.25, 0.75, 1.25, 2].map(s);
    const expected = times.map(t => frame(p, t));
    const [child] = breakApart(p, c.id, FREE);
    const old = structuredClone(child);
    setSpeedCurve(p, child.id, [{ t: 0, v: 3 }, { t: 1, v: 0.2 }], FREE);
    const mapped = times.map(t => localAtSource(child, sourceOffset(old, t)));
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    mapped.forEach((t, i) => same(frame(loaded, t), expected[i]));
    trimClip(p, child.id, 'start', mapped[0] / 2, FREE);
    // Source positions are rounded to microseconds when trimming.
    mapped.forEach((t, i) => {
      const got = frame(p, t);
      for (const key of Object.keys(expected[i])) expect(got[key], key).toBeCloseTo(expected[i][key], 5);
    });
  });

  it.each([0.01, 50])('keeps a composed scale beyond the saved single-clip limits (%s)', scale => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    v.transform.scale = scale; v.volume = 5;
    const c = createCompound(p, [v.id], FREE);
    c.transform.scale = scale; c.volume = 5;
    const before = frame(p, s(1));
    breakApart(p, c.id, FREE);
    same(frame(normalizeProject(JSON.parse(JSON.stringify(p))), s(1)), before);
  });

  it('keeps motion blur samples in the same preview positions', () => {
    const { p, c } = setup('child keys');
    c.sequence.tracks.find(t => t.main).clips[0].motionBlur = { on: true, amount: 60 };
    const before = evaluate(p, s(1.5))[0].extras.motion;
    expect(before.length).toBeGreaterThan(1);
    breakApart(p, c.id, FREE);
    const after = evaluate(p, s(1.5))[0].extras.motion;
    expect(after.length).toBe(before.length);
    before.forEach((sample, i) => same(after[i], sample));
  });

  it('freezes the retained parent motion at the chosen source frame', () => {
    const { p, c } = setup('parent animations');
    breakApart(p, c.id, FREE);
    const child = mainTrack(p).clips[0];
    const before = frame(p, s(1.5));
    const still = freezeFrame(p, child.id, s(1.5), s(2), FREE);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    const held = frame(loaded, still.start + s(0.75));
    for (const key of ['x', 'y', 'scale', 'rotation', 'opacity', 'blur']) expect(held[key], key).toBeCloseTo(before[key], 8);
  });

  it('rejects malformed inherited records and terminates cyclic input', () => {
    const { p, c } = setup('parent keys');
    const [child] = breakApart(p, c.id, FREE);
    const record = child.inherited[0];
    record.parent.inherited = [record];
    child.inherited.push(null, {}, { ...record, offset: Infinity }, { ...record, source: { ...record.source, duration: -1 } });
    const loaded = normalizeProject(p);
    expect(mainTrack(loaded).clips[0].inherited).toHaveLength(1);
    expect(mainTrack(loaded).clips[0].inherited[0].parent.inherited).toEqual([]);
  });

  it.each(['replace', 'reverse'])('keeps retained motion through media %s and subsequent trimming', async action => {
    const { p, c } = setup('parent animations');
    const [child] = breakApart(p, c.id, FREE);
    setSpeedCurve(p, child.id, [{ t: 0, v: 0.5 }, { t: 1, v: 2 }], FREE);
    trimClip(p, child.id, 'start', s(0.5), FREE);
    p.assets.rev = { ...p.assets.vid, id: 'rev', reversedOf: 'vid' };
    const times = [0.75, 1, 1.5, 2].map(s);
    const expected = times.map(t => frame(p, t));
    const store = new EditorStore(p);
    const actions = createActions({ store });
    if (action === 'reverse') await actions.reverseClip(child.id);
    else actions.replaceClip(child.id, p.assets.rev);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(store.project)));
    times.forEach((t, i) => same(frame(loaded, t), expected[i]));
    trimClip(loaded, child.id, 'start', s(0.625), FREE);
    times.forEach((t, i) => {
      const got = frame(loaded, t);
      for (const key of Object.keys(expected[i])) expect(got[key], key).toBeCloseTo(expected[i][key], 5);
    });
  });

});
