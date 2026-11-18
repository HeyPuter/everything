import { it, expect, afterEach } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createCompound, breakApart, allClipsDeep, removeAssetClips } from '../src/model/compound.js';
import { setTransition, mainTrack, splitClip, trimClip, setSpeed, setSpeedCurve, freezeFrame } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { preserveMotionClock } from '../src/model/inherited-motion.js';
import { evaluate, upcomingVideoStarts } from '../src/engine/scene.js';
import { unusedAssets, swapAsset } from '../src/ui/media-actions.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { sourceOffset, localAtSource } from '../src/model/speed-curve.js';

const FREE = { ripple: false, linkOverlays: false };
const saved = p => normalizeProject(JSON.parse(JSON.stringify(p)));
const signature = l => l.kind === 'transition' ? { kind: l.kind, id: l.id, progress: l.progress, from: signature(l.from), to: signature(l.to) }
  : Object.fromEntries(['kind', 'x', 'y', 'scale', 'rotation', 'sx', 'sy', 'skew', 'opacity', 'sourceTime', 'fxTime', 'fxDur', 'crop', 'adjust'].filter(k => k in l).map(k => [k, typeof l[k] === 'number' && /Time|Dur/.test(k) ? l[k] / s(1) : l[k]]));
function same(a, b) {
  if (typeof b === 'number') { expect(a).toBeCloseTo(b, 6); return; }
  if (b && typeof b === 'object') {
    expect(Object.keys(a)).toEqual(Object.keys(b));
    for (const k of Object.keys(b)) same(a[k], b[k]);
  } else expect(a).toEqual(b);
}
const frame = (p, t) => evaluate(p, t).map(signature);
function setup(lo = 1.6, hi = 1.9, type = 'video') {
  const p = fixture(); const [a, b] = onMain(p, clip(type, 0, 2), clip(type, 2, 2, { assetId: 'silent', in: s(1) }));
  a.animLoop = { id: 'float', duration: s(2) }; a.animOut = { id: 'fade-out', duration: s(1) };
  b.animIn = { id: 'fade-in', duration: s(1) }; b.effects = [{ id: 'glitch', params: {} }];
  a.transform.rotation = 20; b.transform.rotation = -15;
  b.keyframes.x = [{ t: 0, v: 0, ease: 'easeIn' }, { t: s(2), v: 0.2 }];
  setTransition(p, a.id, 'mix', s(1));
  const c = createCompound(p, [a.id, b.id], FREE);
  Object.assign(c, { start: s(3), in: s(lo), duration: s(hi - lo) });
  Object.assign(c.transform, { sx: 1.6, sy: 0.6, rotation: 30, flipH: true });
  c.animLoop = { id: 'float', duration: s(3) };
  return { p, c };
}

it.each([[1.6, 1.9], [2.1, 2.4], [1.7, 2.3]])('keeps both rendered sources, motion, effects and progress for window %s–%s', (lo, hi) => {
  const { p, c } = setup(lo, hi), times = [0.01, (hi - lo) / 2, hi - lo - 0.01].map(t => s(3 + t));
  const expected = times.map(t => frame(p, t));
  breakApart(p, c.id);
  for (const q of [p, saved(p)]) times.forEach((t, i) => same(frame(q, t), expected[i]));
  expect(evaluate(p, s(3) - 1)).toEqual([]);
  expect(evaluate(p, s(3 + hi - lo))).toEqual([]);
  expect(new Set(upcomingVideoStarts(p, s(2.9), s(0.5)).map(u => u.clip.assetId))).toEqual(new Set(['vid', 'silent']));
});

it.each(['video', 'image'])('keeps %s fragments through splits, trims and moving', type => {
  const { p, c } = setup(1.6, 1.9, type);
  const expected = [3.04, 3.24].map(t => frame(p, s(t)));
  const [child] = breakApart(p, c.id);
  const right = splitClip(p, child.id, s(3.15));
  trimClip(p, right.id, 'start', s(3.2), FREE);
  for (const v of mainTrack(p).clips) v.start += s(2);
  [5.04, 5.24].forEach((t, i) => same(frame(saved(p), s(t)), expected[i]));
});

it('keeps fragments through repeated grouping, outer windows, flattening and saving', () => {
  const { p, c } = setup(); const [child] = breakApart(p, c.id);
  const outer = createCompound(p, [child.id], FREE);
  Object.assign(outer.transform, { sx: 0.5, sy: 1.8, rotation: 70 });
  outer.animIn = { id: 'fade-in', duration: s(0.3) };
  outer.in = s(0.02); outer.duration = s(0.25);
  const expected = [3.05, 3.2].map(t => frame(p, s(t)));
  breakApart(p, outer.id);
  for (const q of [p, saved(p)]) [3.05, 3.2].forEach((t, i) => same(frame(q, s(t)), expected[i]));
});

it.each([false, true])('retimes each source and transition progress together (curve %s)', curve => {
  const { p, c } = setup(); const [child] = breakApart(p, c.id);
  const before = structuredClone(child), expected = frame(p, s(3.2));
  if (curve) setSpeedCurve(p, child.id, [{ t: 0, v: 0.5 }, { t: 1, v: 2 }], FREE);
  else setSpeed(p, child.id, 2, FREE);
  const at = child.start + localAtSource(child, sourceOffset(before, s(0.2)));
  same(frame(saved(p), at), expected);
  const layer = evaluate(p, at)[0].to;
  const dt = 100;
  const derivative = (evaluate(p, at + dt)[0].to.sourceTime - evaluate(p, at - dt)[0].to.sourceTime) / (2 * dt);
  expect(layer.playbackRate).toBeCloseTo(derivative, 5);
  preserveMotionClock(child, () => { child.in = s(0.5); });
  const after = frame(saved(p), at)[0];
  expect(after.progress).toBeCloseTo(expected[0].progress, 6);
  same(after.to, expected[0].to);
});

it('keeps required partner media through cleanup, relinking and explicit deletion on every timeline', () => {
  const { p, c } = setup(); const [child] = breakApart(p, c.id);
  expect(allClipsDeep(p).map(c => c.assetId)).toContain('silent');
  expect(unusedAssets(p).map(a => a.id)).not.toContain('silent');
  const replacement = { ...p.assets.silent, id: 'replacement', name: 'Relinked' };
  expect(swapAsset(p, 'silent', replacement)).toBe(1);
  expect(evaluate(p, s(3.2))[0].to.asset.id).toBe('replacement');
  p.timelines = [{ id: 'other', tracks: structuredClone(p.tracks) }];
  removeAssetClips(p, ['replacement']);
  expect(child.transitionSlices).toBeUndefined();
  expect(allClipsDeep(p).some(c => c.assetId === 'replacement')).toBe(false);
  expect(evaluate(p, s(3.2))[0].kind).toBe('media');
});

it('freezes the selected source frame without carrying its transition into the still', () => {
  const { p, c } = setup(); const [child] = breakApart(p, c.id);
  const still = freezeFrame(p, child.id, s(3.15), s(1), FREE);
  expect(still.transitionSlices).toBeUndefined();
  expect(still.timing).toBeUndefined();
  expect(evaluate(p, s(3.5))[0].kind).toBe('media');
});

it('keeps the visible source editable without overwriting the other side', () => {
  const { p, c } = setup(); const [child] = breakApart(p, c.id);
  const before = evaluate(p, s(3.2))[0];
  child.crop = { l: 0.2, t: 0, r: 0, b: 0 }; child.opacity = 0.5;
  const after = evaluate(saved(p), s(3.2))[0];
  expect(after.from.crop.l).toBe(0.2); expect(after.from.opacity).toBeCloseTo(before.from.opacity / 2);
  same(signature(after.to), signature(before.to));
});

it('does not revive transitions whose other source is disabled', () => {
  const { p, c } = setup(); c.sequence.tracks[0].clips[1].disabled = true;
  const expected = frame(p, s(3.2)); breakApart(p, c.id);
  same(frame(saved(p), s(3.2)), expected);
});

let inspector;
afterEach(() => { inspector?.dispose(); inspector = null; document.body.replaceChildren(); });
it('exposes fragment style and removal, respects locks and supports undo', () => {
  const { p, c } = setup(); const [child] = breakApart(p, c.id);
  const store = new EditorStore(p), ctx = { store }; ctx.actions = createActions(ctx);
  inspector = createInspector(ctx); document.body.append(inspector.el); store.select(child.id);
  inspector.showTab('transitionFragments');
  const select = inspector.el.querySelector('select[aria-label="Transition 1 style"]');
  expect(select).not.toBeNull(); select.value = 'wipe-left'; select.dispatchEvent(new Event('change'));
  expect(evaluate(store.project, s(3.2))[0].id).toBe('wipe-left');
  store.update('Lock', p => { mainTrack(p).locked = true; });
  expect(select.disabled).toBe(true); select.value = 'mix'; select.dispatchEvent(new Event('change'));
  expect(store.selected.clip.transitionSlices[0].id).toBe('wipe-left');
  store.undo();
  [...inspector.el.querySelectorAll('button')].find(b => b.textContent === 'Remove transition').click();
  expect(evaluate(store.project, s(3.2))[0].kind).toBe('media');
  store.undo(); expect(evaluate(store.project, s(3.2))[0].id).toBe('wipe-left');
});

it('keeps retained timing when Replace file changes the visible video to a photo', () => {
  const { p, c } = setup(); const [child] = breakApart(p, c.id);
  const before = frame(p, s(3.2))[0];
  swapAsset(p, 'vid', { ...p.assets.img, id: 'photo', kind: 'image' });
  const after = frame(saved(p), s(3.2))[0];
  expect(after.kind).toBe('transition');
  expect(after.progress).toBeCloseTo(before.progress);
  same(after.to, before.to);
  const { sourceTime: _beforeTime, ...beforeSelf } = before.from;
  const { sourceTime: _afterTime, ...afterSelf } = after.from;
  same(afterSelf, beforeSelf);
  expect(child.type).toBe('image');
});

it('keeps a newly added transition ahead of an older retained fragment when clipped again', () => {
  const { p, c } = setup(); const [child] = breakApart(p, c.id);
  const [next] = onMain(p, clip('video', 3.3, 1, { assetId: 'img', in: s(2) }));
  setTransition(p, child.id, 'wipe-left', s(0.2));
  const outer = createCompound(p, [child.id, next.id], FREE);
  outer.in = s(0.2); outer.duration = s(0.08);
  const expected = frame(p, s(3.05));
  expect(expected[0].id).toBe('wipe-left');
  breakApart(p, outer.id);
  same(frame(saved(p), s(3.05)), expected);
});

it('rejects malformed saved fragments without normalizing recursive partner transitions', () => {
  const { p, c } = setup(); const [child] = breakApart(p, c.id);
  const valid = structuredClone(child.transitionSlices[0]);
  valid.partner.transitionSlices = [structuredClone(valid)];
  child.transitionSlices = [null, { ...valid, end: valid.start }, { ...valid, clock: [] }, valid];
  const normalized = mainTrack(saved(p)).clips[0];
  expect(normalized.transitionSlices).toHaveLength(1);
  expect(normalized.transitionSlices[0].partner.transitionSlices).toBeUndefined();
  expect(evaluate(saved(p), s(3.2))[0].kind).toBe('transition');
});
