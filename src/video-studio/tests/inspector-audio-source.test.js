import { it, expect, vi, afterEach } from 'vitest';
import { createInspector } from '../src/ui/inspector/index.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { findClip } from '../src/model/timeline.js';
import { fixture, clip } from './helpers.js';
const work = vi.hoisted(() => ({ delayed: true, finish: null, fail: null }));
vi.mock('../src/media/audio-analysis.js', async original => ({
  ...await original(),
  decodeClipSound: async () => {
    if (work.delayed) await new Promise((r, j) => { work.finish = r; work.fail = j; });
    return { sampleRate: 8000, channels: [Float32Array.from({ length: 8000 }, (_, i) => .2 * Math.sin(i * .3))] };
  },
  detectBeats: () => ({ beats: [.1, .5], bpm: 150 }),
}));
const inspectors = [];
afterEach(() => {
  inspectors.splice(0).forEach(i => i.dispose());
  document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren();
  work.delayed = true; work.finish = work.fail = null; vi.restoreAllMocks();
});
const controls = ['Normalize loudness', 'Measure', 'Reduce noise', 'Learn noise again', 'Detect beats'];
const control = (x, name) => x.inspector.el.querySelector(`[role=switch][aria-label="${name}"]`) || [...x.inspector.el.querySelectorAll('button')].find(b => b.textContent.trim() === name);
function setup() {
  const p = fixture(), a = clip('audio', 0, 1);
  p.tracks.push(makeTrack('audio', { clips: [a] }));
  const store = new EditorStore(p), ctx = { store, library: {} };
  ctx.actions = createActions(ctx); store.select(a.id);
  const inspector = createInspector(ctx); inspectors.push(inspector); document.body.append(inspector.el);
  return { ctx, store, inspector, id: a.id };
}
async function start(x, name) {
  const btn = control(x, name); btn.click();
  await vi.waitFor(() => expect(work.finish).toBeTypeOf('function'));
  return btn;
}
async function rejectChanged(x, btn, fail = false) {
  const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length;
  if (fail) work.fail(new Error('Obsolete file failure')); else work.finish();
  await vi.waitFor(() => expect(btn.disabled).toBe(false));
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
  expect(x.store.history.undoStack).toHaveLength(history);
  expect(document.querySelector('.toast.error')?.textContent).toContain('Run audio analysis again');
  expect(document.body.textContent).not.toContain('Obsolete file failure');
}
it.each(controls)('rejects obsolete %s results after relinking, and allows retry', async name => {
  const x = setup(), btn = await start(x, name);
  x.store.update('Relink', p => { p.assets.aud.hash = 'replacement'; });
  await rejectChanged(x, btn);
  work.delayed = false; btn.click(); await vi.waitFor(() => expect(x.store.history.undoStack).toHaveLength(2));
  const result = structuredClone(findClip(x.store.project, x.id).clip);
  x.store.undo(); expect(findClip(x.store.project, x.id).clip).not.toEqual(result);
  x.store.redo(); expect(findClip(normalizeProject(x.store.projectForSave()), x.id).clip).toEqual(result);
});
const changes = {
  trim: (p, c) => { c.in = 500000; c.duration = 500000; },
  extend: (p, c) => { c.duration = 2000000; },
  speed: (p, c) => { c.speed = 2; },
  curve: (p, c) => { c.speedCurve = [{ t: 0, v: 1 }, { t: 1, v: 2 }]; },
  replace: (p, c) => { p.assets.other = { ...p.assets.aud, id: 'other' }; c.assetId = 'other'; },
};
it.each(Object.keys(changes))('rejects audio measured before %s changes its source range or media', async change => {
  const x = setup(), btn = await start(x, 'Measure');
  x.store.update(change, p => changes[change](p, findClip(p, x.id).clip));
  await rejectChanged(x, btn);
});
it('does not shift old beats onto a newly trimmed source range', async () => {
  const x = setup(), btn = await start(x, 'Detect beats');
  x.store.update('Trim', p => changes.trim(p, findClip(p, x.id).clip));
  await rejectChanged(x, btn);
});
it('reports a changed source instead of an obsolete file failure', async () => {
  const x = setup(), btn = await start(x, 'Measure');
  x.store.update('Relink', p => { p.assets.aud.hash = 'replacement'; });
  await rejectChanged(x, btn, true);
});
it('rejects a new project retaining the same selected clip', async () => {
  const x = setup(), btn = await start(x, 'Measure');
  x.store.load({ ...x.store.project, id: 'new-project' }); x.store.select(x.id);
  const before = JSON.stringify(x.store.projectForSave()); work.finish(); await vi.waitFor(() => expect(btn.disabled).toBe(false));
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(0);
});
it.each(controls)('preserves compatible edits during %s analysis', async name => {
  const x = setup(), btn = await start(x, name);
  x.store.update('Compatible edits', p => {
    const c = findClip(p, x.id).clip;
    c.start = 2000000; c.name = 'Renamed'; c.volume = .4; c.transform = { ...c.transform, x: .2 };
    p.name = 'Project rename'; p.fps = 60; p.assets.aud.name = 'New label';
  });
  work.finish(); await vi.waitFor(() => expect(btn.disabled).toBe(false));
  expect(x.store.history.undoStack).toHaveLength(2);
  expect(document.querySelector('.toast.error')).toBeNull();
  const c = findClip(x.store.project, x.id).clip; expect(c.start).toBe(2000000); expect(c.volume).toBe(.4);
});
it('does not enable cached normalization if media changes before the switch commits', async () => {
  const x = setup(); findClip(x.store.project, x.id).clip.audioFx = { normalize: { on: false, target: -14, loudness: -20 } };
  const btn = control(x, 'Normalize loudness'); btn.click();
  x.store.update('Relink', p => { p.assets.aud.hash = 'replacement'; });
  const before = JSON.stringify(x.store.projectForSave()); await vi.waitFor(() => expect(btn.disabled).toBe(false));
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(1);
  expect(document.querySelector('.toast.error')?.textContent).toContain('Run audio analysis again');
});
