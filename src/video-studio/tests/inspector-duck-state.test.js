import { it, expect, vi, afterEach } from 'vitest';
import { createInspector } from '../src/ui/inspector/index.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { findClip } from '../src/model/timeline.js';
import { createCompound } from '../src/model/compound.js';
import { retainMotion, retainContentTiming } from '../src/model/inherited-motion.js';
import { fixture, clip } from './helpers.js';
const work = vi.hoisted(() => ({ hold: true, finish: null, fail: null, signal: null }));
vi.mock('../src/engine/audio-mix.js', async original => ({ ...await original(), renderAudio: async (_p, _l, opts) => {
  work.signal = opts.signal;
  const data = new Float32Array(16000); data.fill(.2, 2000, 8000);
  if (work.hold) await new Promise((r, j) => { work.finish = r; work.fail = j; });
  return { channels: [data], sampleRate: 8000 };
} }));
const inspectors = [];
afterEach(() => { inspectors.splice(0).forEach(i => i.dispose()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); work.hold = true; work.finish = work.fail = work.signal = null; vi.restoreAllMocks(); });
function setup(nested = false) {
  const p = fixture(); p.assets.bed = { ...p.assets.aud, id: 'bed' };
  const target = clip('audio', 0, 2, { assetId: 'bed' }), speech = clip('audio', .25, .75), distant = clip('audio', 10, 1);
  p.tracks.push(makeTrack('audio', { clips: [target] }), makeTrack('audio', { clips: [speech, distant] }));
  let compound;
  if (nested) compound = createCompound(p, [speech.id]);
  else retainMotion(speech, { start: 0, duration: 2000000, volume: .8 });
  const store = new EditorStore(p), ctx = { store, library: {} }; ctx.actions = createActions(ctx); store.select(target.id);
  const inspector = createInspector(ctx); inspectors.push(inspector); document.body.append(inspector.el);
  const button = [...inspector.el.querySelectorAll('button')].find(b => b.textContent.trim() === 'Lower under speech');
  return { store, ctx, inspector, button, target: target.id, speech: speech.id, distant: distant.id, compound: compound?.id };
}
async function start(x) { x.button.click(); await vi.waitFor(() => expect(work.finish).toBeTypeOf('function')); }
const changes = {
  'target move': (p, x) => { findClip(p, x.target).clip.start = 1000000; },
  'target duration': (p, x) => { findClip(p, x.target).clip.duration = 1000000; },
  'speech move': (p, x) => { findClip(p, x.speech).clip.start = 1200000; },
  'speech trim': (p, x) => { findClip(p, x.speech).clip.in = 300000; },
  'speech speed': (p, x) => { findClip(p, x.speech).clip.speed = 2; },
  'speech curve': (p, x) => { findClip(p, x.speech).clip.speedCurve = [{ t: 0, v: 1 }, { t: 1, v: 2 }]; },
  'speech gain': (p, x) => { findClip(p, x.speech).clip.volume = .1; },
  'speech keys': (p, x) => { findClip(p, x.speech).clip.keyframes.volume = [{ t: 0, v: 0 }, { t: 500000, v: 1 }]; },
  'speech fade': (p, x) => { findClip(p, x.speech).clip.fadeIn = 600000; },
  'speech effect': (p, x) => { findClip(p, x.speech).clip.audioFx = { normalize: { on: true, loudness: -20, target: -14 } }; },
  'speech mute': (p, x) => { findClip(p, x.speech).clip.muted = true; },
  'track mute': (p, x) => { findClip(p, x.speech).track.muted = true; },
  'track solo': (p, x) => { findClip(p, x.target).track.solo = true; },
  'file relink': p => { p.assets.aud.hash = 'replacement'; },
  'speech deletion': (p, x) => { const f = findClip(p, x.speech); f.track.clips = f.track.clips.filter(c => c.id !== x.speech); },
  'new overlapping audio': p => { p.tracks.push(makeTrack('audio', { clips: [clip('audio', .5, .5)] })); },
  'retained parent gain': (p, x) => { findClip(p, x.speech).clip.inherited[0].parent.volume = .1; },
};
it.each(Object.keys(changes))('discards obsolete ducking after %s', async change => {
  const x = setup(); await start(x); x.store.update(change, p => changes[change](p, x));
  const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length, aborted = work.signal.aborted;
  work.finish(); await vi.waitFor(() => expect(x.button.disabled).toBe(false));
  expect(aborted).toBe(true); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(history);
  expect(document.querySelector('.toast.error')?.textContent).toContain('Run auto ducking again');
});
it.each(['parent gain', 'inner mute', 'inner keys'])('detects compound %s changes in the heard mix', async change => {
  const x = setup(true); await start(x); x.store.update(change, p => {
    const c = findClip(p, x.compound).clip, inner = c.sequence.tracks.find(t => t.clips.length);
    if (change === 'parent gain') c.volume = .2;
    else if (change === 'inner mute') inner.muted = true;
    else inner.clips[0].keyframes.volume = [{ t: 0, v: 0 }, { t: 500000, v: 1 }];
  });
  const before = JSON.stringify(x.store.projectForSave()); work.finish(); await vi.waitFor(() => expect(x.button.disabled).toBe(false));
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(document.querySelector('.toast.error')?.textContent).toContain('Run auto ducking again');
});
it('does not accept a hybrid mix when a source edit is changed back during processing', async () => {
  const x = setup(); await start(x); x.store.update('Mute', p => { findClip(p, x.speech).clip.muted = true; }); x.store.update('Unmute', p => { findClip(p, x.speech).clip.muted = false; });
  const before = JSON.stringify(x.store.projectForSave()); work.finish(); await vi.waitFor(() => expect(x.button.disabled).toBe(false));
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
});
it('keeps unrelated visual, name, out-of-range, and target-volume edits compatible', async () => {
  const x = setup(); await start(x); x.store.update('Compatible edits', p => {
    const target = findClip(p, x.target).clip, speech = findClip(p, x.speech).clip;
    target.volume = .5; target.keyframes.volume = [{ t: 0, v: .5 }, { t: 1000000, v: .7 }]; target.in = 200000; target.speed = 2;
    p.assets.bed.hash = 'new-bed-file'; speech.name = 'Speech label'; speech.transform = { x: .2 }; speech.keyframes.x = [{ t: 0, v: .2 }]; speech.inherited[0].parent.transform = { x: .3 };
    findClip(p, x.distant).clip.volume = .1; p.assets.aud.name = 'Media label'; p.name = 'Project label';
  }); work.finish(); await vi.waitFor(() => expect(x.button.disabled).toBe(false));
  expect(document.querySelector('.toast.error')).toBeNull(); expect(x.store.history.undoStack).toHaveLength(2);
  expect(findClip(x.store.project, x.target).clip.keyframes.volume.some(k => k.v < .5)).toBe(true);
  const saved = structuredClone(findClip(x.store.project, x.target).clip); x.store.undo(); expect(findClip(x.store.project, x.target).clip.keyframes.volume).toHaveLength(2);
  x.store.redo(); expect(findClip(normalizeProject(x.store.projectForSave()), x.target).clip).toEqual(saved);
});
it('replaces obsolete mix errors with rerun feedback and allows a fresh retry', async () => {
  const x = setup(); await start(x); x.store.update('Relink', p => { p.assets.aud.hash = 'replacement'; });
  work.fail(new Error('Obsolete mix failure')); await vi.waitFor(() => expect(x.button.disabled).toBe(false));
  expect(document.body.textContent).not.toContain('Obsolete mix failure'); expect(document.querySelector('.toast.error')?.textContent).toContain('Run auto ducking again');
  work.hold = false; x.button.click(); await vi.waitFor(() => expect(x.store.history.undoStack).toHaveLength(2));
});
it('detects a changed retained fade clock', async () => {
  const x = setup(); const speech = findClip(x.store.project, x.speech).clip; speech.fadeIn = 600000; retainContentTiming(speech);
  await start(x); x.store.update('Fade clock', p => { findClip(p, x.speech).clip.timing.fadeIn.clock[0].offset += 200000; });
  const before = JSON.stringify(x.store.projectForSave()); work.finish(); await vi.waitFor(() => expect(x.button.disabled).toBe(false)); expect(JSON.stringify(x.store.projectForSave())).toBe(before);
});
it('releases its observer after a current error and a successful retry', async () => {
  const x = setup(), on = x.store.on.bind(x.store); let live = 0;
  vi.spyOn(x.store, 'on').mockImplementation((type, fn) => { const off = on(type, fn); if (type === 'change') live++; return () => { if (type === 'change') live--; off(); }; });
  await start(x); work.fail(new Error('Current mix failed')); await vi.waitFor(() => expect(x.button.disabled).toBe(false));
  expect(document.body.textContent).toContain('Current mix failed'); expect(live).toBe(0);
  work.hold = false; x.button.click(); await vi.waitFor(() => expect(x.store.history.undoStack).toHaveLength(1)); expect(live).toBe(0);
});
it('releases its observer when its panel is disposed during mixing', async () => {
  const x = setup(), on = x.store.on.bind(x.store); let live = 0;
  vi.spyOn(x.store, 'on').mockImplementation((type, fn) => { const off = on(type, fn); if (type === 'change') live++; return () => { if (type === 'change') live--; off(); }; });
  await start(x); x.inspector.dispose(); expect(live).toBe(0); work.finish(); await vi.waitFor(() => expect(x.button.disabled).toBe(false));
  expect(live).toBe(0); expect(x.store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.error')).toBeNull();
});
