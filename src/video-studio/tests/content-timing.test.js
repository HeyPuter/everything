import { it, expect, afterEach } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createCompound, breakApart } from '../src/model/compound.js';
import { mainTrack, splitClip, trimClip, setSpeed, setSpeedCurve, detachAudio } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { sourceOffset, localAtSource } from '../src/model/speed-curve.js';
import { preserveMotionClock, contentTime } from '../src/model/inherited-motion.js';
import { evaluate, gainAt, audibleClips } from '../src/engine/scene.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';

const FREE = { ripple: false, linkOverlays: false };
function setup(type = 'video', curved = false) {
  const p = fixture(); const [v] = onMain(p, clip(type, 0, 4));
  v.animLoop = { id: 'float', duration: s(4) };
  v.animIn = { id: 'fade-in', duration: s(2) }; v.animOut = { id: 'fade-out', duration: s(2) };
  v.fadeIn = s(2); v.fadeOut = s(2);
  v.effects = [{ id: 'glitch', params: {} }];
  if (curved) setSpeedCurve(p, v.id, [{ t: 0, v: 0.5 }, { t: 1, v: 1.5 }], FREE);
  const c = createCompound(p, [v.id], FREE); c.in = s(1); c.duration = s(2);
  const expected = [0.25, 0.75, 1.5].map(t => frame(p, s(t)));
  const [child] = breakApart(p, c.id, FREE);
  return { p, child, expected };
}
function frame(p, time) {
  const l = evaluate(p, time)[0];
  const heard = audibleClips(p).filter(({ clip: c }) => c.start <= time && time < c.start + c.duration);
  return { x: l.x, y: l.y, opacity: l.opacity, fxTime: l.fxTime / s(1), fxDur: l.fxDur / s(1), gain: heard.reduce((sum, { clip: c }) => sum + gainAt(c, time), 0) };
}
const same = (a, b, precision = 7) => { for (const key of Object.keys(b)) expect(a[key], key).toBeCloseTo(b[key], precision); };
const saved = p => normalizeProject(JSON.parse(JSON.stringify(p)));

it.each(['video', 'image'])('retains %s clocks across split, trim, move and save', type => {
  const { p, child, expected } = setup(type);
  const right = splitClip(p, child.id, s(1));
  trimClip(p, right.id, 'start', s(1.1), FREE);
  for (const c of mainTrack(p).clips) c.start += s(2);
  const q = saved(p);
  [0.25, 0.75, 1.5].forEach((t, i) => same(frame(q, s(t + 2)), expected[i]));
});

it.each([false, true])('keeps clocks through speed changes and detached audio (curved %s)', curved => {
  const { p, child, expected } = setup('video', curved);
  const before = structuredClone(child);
  setSpeed(p, child.id, 2, FREE);
  detachAudio(p, child.id);
  const q = saved(p);
  [0.25, 0.75, 1.5].forEach((t, i) => same(frame(q, localAtSource(mainTrack(q).clips[0], sourceOffset(before, s(t)))), expected[i], 5));
});

it('keeps clocks through another curve, media replacement, and repeated save', () => {
  const { p, child } = setup('video', true);
  setSpeedCurve(p, child.id, [{ t: 0, v: 1.5 }, { t: 1, v: 0.5 }], FREE);
  const before = frame(p, s(0.5));
  p.assets.silent.hasAudio = true;
  preserveMotionClock(child, () => { child.in = 0; child.assetId = 'silent'; });
  same(frame(saved(p), s(0.5)), before, 5);
  const current = mainTrack(p).clips[0];
  preserveMotionClock(current, () => { current.in = s(3); current.assetId = 'vid'; });
  same(frame(saved(p), s(0.5)), before, 5);
});

let inspector;
afterEach(() => { inspector?.dispose(); inspector = null; document.body.replaceChildren(); });
it('lets users edit the visible clip, restart timing, and undo the restart', () => {
  const { p, child } = setup();
  const store = new EditorStore(p), ctx = { store }; ctx.actions = createActions(ctx);
  inspector = createInspector(ctx); document.body.append(inspector.el);
  store.select(child.id); store.seek(s(0.25));
  const before = frame(store.project, store.time);
  ctx.actions.setTransform(child.id, { x: 0.2 });
  expect(frame(store.project, store.time).x).toBeCloseTo(0.2);
  const reset = [...inspector.el.querySelectorAll('button')].find(b => b.textContent === 'Restart timing');
  expect(reset.closest('.insp-note').hidden).toBe(false);
  reset.click();
  expect(store.selected.clip.timing).toBeUndefined();
  expect(frame(store.project, store.time).y).not.toBeCloseTo(before.y);
  store.undo();
  expect(frame(store.project, store.time).y).toBeCloseTo(before.y);
  ctx.actions.applyAnimation('in', 'fade-in', s(1));
  expect(store.selected.clip.timing?.animIn).toBeUndefined();
  expect(evaluate(store.project, store.time)[0].opacity).toBeCloseTo(0.25);
});

it('does not use clocks or malformed fields from unsupported saved data', () => {
  const { p, child } = setup();
  child.timing.junk = child.timing.animIn;
  child.timing.animOut = { duration: Infinity, clock: [] };
  const q = saved(p), c = mainTrack(q).clips[0];
  expect(c.timing.junk).toBeUndefined(); expect(c.timing.animOut).toBeUndefined();
  expect(contentTime(c, s(0.5), 'animIn').local).toBe(s(1.5));
});
