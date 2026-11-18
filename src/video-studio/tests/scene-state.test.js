import { it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { findClip, mainTrack } from '../src/model/timeline.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { fixture, clip } from './helpers.js';
const work = vi.hoisted(() => ({ pause: null, sampled: vi.fn() }));
vi.mock('../src/media/smart-edit.js', async original => ({
  ...await original(), detectScenes: async (_blob, from, to) => {
    work.sampled(from, to);
    const cuts = [1000000, 3000000].filter(t => t > from && t < to);
    if (work.pause) await work.pause();
    return cuts;
  },
}));
afterEach(() => {
  document.querySelectorAll('.dialog-close').forEach(b => b.click());
  document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren();
  work.pause = null; work.sampled.mockClear(); vi.restoreAllMocks();
});
function setup(duration = 2) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const p = fixture(), target = clip('video', 0, duration);
  p.tracks.push(makeTrack('video', { clips: [target] }));
  const store = new EditorStore(p), library = { mediaBlob: vi.fn(async () => new Blob()) };
  store.select(target.id);
  const ctx = { store, library }; ctx.actions = createActions(ctx);
  return { ctx, store, target, library, track: p.tracks.at(-1).id };
}
const changes = {
  extend: (p, c) => { c.duration = 4000000; },
  trim: (p, c) => { c.in = 500000; c.duration = 1500000; },
  speed: (p, c) => { c.speed = 2; },
  curve: (p, c) => { c.speedCurve = [{ t: 0, v: 1 }, { t: 1, v: 2 }]; },
  relink: (p, c) => { p.assets[c.assetId].hash = 'replacement'; },
};
it.each(Object.keys(changes))('does not split a clip using obsolete source analysis after %s', async change => {
  const x = setup(); let finish;
  work.pause = () => new Promise(r => { finish = r; });
  const pending = x.ctx.actions.splitScenes(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  x.store.update(change, p => changes[change](p, findClip(p, x.target.id).clip));
  const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length;
  finish(); await pending;
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
  expect(x.store.history.undoStack).toHaveLength(history);
  expect(document.querySelector('.toast.success')).toBeNull();
  expect(document.querySelector('.toast.error')?.textContent).toContain('Run scene detection again');
});
it('does not claim no cuts exist after a previously steady clip is extended', async () => {
  const x = setup(.8); let finish;
  work.pause = () => new Promise(r => { finish = r; });
  const pending = x.ctx.actions.splitScenes(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  x.store.update('Extend', p => { findClip(p, x.target.id).clip.duration = 4000000; });
  finish(); await pending;
  expect(document.body.textContent).not.toContain('No scene changes');
  expect(document.querySelector('.toast.error')?.textContent).toContain('Run scene detection again');
  work.pause = null; document.querySelector('.toasts')?.replaceChildren();
  await x.ctx.actions.splitScenes(x.target.id);
  const starts = p => p.tracks.find(t => t.id === x.track).clips.map(c => c.start);
  expect(starts(x.store.project)).toEqual([0, 1000000, 3000000]);
  expect(x.store.history.undoStack).toHaveLength(2);
  x.store.undo(); expect(starts(x.store.project)).toEqual([0]);
  x.store.redo(); expect(starts(normalizeProject(x.store.projectForSave()))).toEqual([0, 1000000, 3000000]);
});
it('discards a relinked file before beginning scene detection', async () => {
  const x = setup(); let finish;
  x.library.mediaBlob.mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const pending = x.ctx.actions.splitScenes();
  x.store.update('Relink', p => { p.assets.vid.hash = 'replacement'; });
  const before = JSON.stringify(x.store.projectForSave());
  finish(new Blob()); await pending;
  expect(work.sampled).not.toHaveBeenCalled();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
});
it('rejects a new project that retains the original clip object', async () => {
  const x = setup(); let finish;
  work.pause = () => new Promise(r => { finish = r; });
  const pending = x.ctx.actions.splitScenes(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  x.store.load({ ...x.store.project, id: 'another-project' });
  const before = JSON.stringify(x.store.projectForSave()); finish(); await pending;
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
  expect(x.store.history.undoStack).toHaveLength(0);
});
it('rejects relinking inside the save boundary before splitting anything', async () => {
  const x = setup(), update = x.store.update.bind(x.store);
  vi.spyOn(x.store, 'update').mockImplementation((label, fn, opts) => {
    if (label === 'Split scenes') update('Relink', p => { p.assets.vid.hash = 'replacement'; });
    return update(label, fn, opts);
  });
  await x.ctx.actions.splitScenes();
  expect(x.store.history.undoStack).toHaveLength(1);
  expect(x.store.project.tracks.find(t => t.id === x.track).clips).toHaveLength(1);
  expect(document.querySelector('.toast.success')).toBeNull();
});
it('replaces a failed old file read with current-source feedback', async () => {
  const x = setup(); let fail;
  x.library.mediaBlob.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  const pending = x.ctx.actions.splitScenes();
  x.store.update('Relink', p => { p.assets.vid.hash = 'replacement'; });
  fail(new Error('Old source failed')); await pending;
  expect(document.body.textContent).not.toContain('Old source failed');
  expect(document.body.textContent).toContain('Run scene detection again');
});
it('maps unchanged source cuts to a moved clip and current frame rate while preserving unrelated edits', async () => {
  const x = setup(); let finish;
  work.pause = () => new Promise(r => { finish = r; });
  const pending = x.ctx.actions.splitScenes(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  x.store.update('Move and grade', p => {
    const c = findClip(p, x.target.id).clip;
    p.name = 'Renamed'; p.settings.fps = 24; p.settings.width = 1080;
    c.start = 2000000; c.name = 'New name'; c.transform.x = .2; c.adjust.contrast = 10;
  });
  finish(); await pending;
  const clips = x.store.project.tracks.find(t => t.id === x.track).clips;
  expect(clips.map(c => c.start)).toEqual([2000000, 3000000]);
  expect(clips.every(c => c.transform.x === .2 && c.adjust.contrast === 10)).toBe(true);
  expect(x.store.history.undoStack).toHaveLength(2);
  expect(mainTrack(x.store.project).clips).toHaveLength(0);
});
