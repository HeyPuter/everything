import { it, expect, vi, afterEach } from 'vitest';
import { createActions } from '../src/ui/actions.js';
import { EditorStore } from '../src/model/store.js';
import { findClip } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';
const work = vi.hoisted(() => ({ pause: null, sampled: vi.fn() }));
vi.mock('../src/media/tracker.js', async original => ({
  ...await original(), grayFrames: async function* (_blob, times, { tw, th }) {
    work.sampled(times);
    const frame = new Float32Array(tw * th).fill(.5);
    for (const t of times) yield { t, frame };
    if (work.pause) await work.pause();
  },
}));
const go = () => [...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === 'Stabilize').click();
const settled = async () => vi.waitFor(() => expect(document.querySelector('dialog[open]')).toBeNull());
afterEach(() => {
  document.querySelectorAll('.dialog-close').forEach(b => b.click());
  document.querySelector('.toasts')?.replaceChildren();
  document.body.replaceChildren();
  work.pause = null; work.sampled.mockClear(); vi.restoreAllMocks();
});
function setup() {
  const p = fixture(), [target] = onMain(p, clip('video', 0, .8));
  target.keyframes.x = [{ t: 0, v: .1, ease: 'linear' }];
  target.keyframes.scale = [{ t: 0, v: 1.2, ease: 'linear' }];
  const store = new EditorStore(p), library = { mediaBlob: vi.fn(async () => new Blob()) };
  store.select(target.id);
  const ctx = { store, library };
  ctx.actions = createActions(ctx);
  return { ctx, store, target, library };
}
async function start(x) { await x.ctx.actions.stabilize(x.target.id); go(); }
const changes = {
  trim: (p, c) => { c.duration = 400000; },
  in: (p, c) => { c.in = 200000; },
  speed: (p, c) => { c.speed = 2; },
  curve: (p, c) => { c.speedCurve = [{ t: 0, v: 1 }, { t: 1, v: 2 }]; },
  relink: (p, c) => { p.assets[c.assetId].hash = 'new-content'; },
  mediaWidth: (p, c) => { p.assets[c.assetId].width = 1080; },
  mediaHeight: (p, c) => { p.assets[c.assetId].height = 1920; },
  frameWidth: p => { p.settings.width = 1080; },
  frameHeight: p => { p.settings.height = 1920; },
  x: (p, c) => { c.transform.x = .2; },
  y: (p, c) => { c.transform.y = .3; },
  scale: (p, c) => { c.transform.scale = 2; },
  xKeys: (p, c) => { c.keyframes.x = [{ t: 0, v: .3, ease: 'linear' }]; },
  yKeys: (p, c) => { c.keyframes.y = [{ t: 0, v: .4, ease: 'linear' }]; },
  scaleKeys: (p, c) => { c.keyframes.scale = [{ t: 0, v: 2, ease: 'linear' }]; },
};
it.each(Object.keys(changes))('rejects obsolete stabilization analysis after %s changes', async change => {
  const x = setup(); let finish;
  work.pause = () => new Promise(r => { finish = r; });
  await start(x); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  x.store.update(change, p => changes[change](p, findClip(p, x.target.id).clip));
  const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length;
  finish(); await settled();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
  expect(x.store.history.undoStack).toHaveLength(history);
  expect(document.querySelector('.toast.success')).toBeNull();
  expect(document.querySelector('.toast.error')?.textContent).toContain('Reopen Stabilize');
});
it('rejects a relinked media read before sampling and can retry with current timing', async () => {
  const x = setup(); let finish;
  x.library.mediaBlob.mockImplementationOnce(() => new Promise(r => { finish = r; }));
  await start(x);
  x.store.update('Relink and trim', p => { p.assets.vid.hash = 'replacement'; findClip(p, x.target.id).clip.duration = 400000; });
  const before = JSON.stringify(x.store.projectForSave());
  finish(new Blob()); await settled();
  expect(work.sampled).not.toHaveBeenCalled();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
  await start(x); await settled();
  expect(work.sampled.mock.calls[0][0]).toHaveLength(6);
  expect(x.store.history.undoStack).toHaveLength(2);
  const result = structuredClone(findClip(x.store.project, x.target.id).clip);
  expect(result.keyframes.x.every(k => k.t < 400000)).toBe(true);
  x.store.undo(); expect(JSON.stringify(x.store.projectForSave()).replace(/"modified":\d+/, '"modified":0')).toBe(before.replace(/"modified":\d+/, '"modified":0'));
  x.store.redo(); expect(findClip(normalizeProject(x.store.projectForSave()), x.target.id).clip).toEqual(result);
});
it('rejects changed settings inputs before reading media', async () => {
  const x = setup(); await x.ctx.actions.stabilize();
  x.store.update('Trim', p => { findClip(p, x.target.id).clip.duration = 400000; });
  const before = JSON.stringify(x.store.projectForSave()); go(); await settled();
  expect(x.library.mediaBlob).not.toHaveBeenCalled();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
});
it('rejects a new project even if it retains the same clip object', async () => {
  const x = setup(); let finish;
  work.pause = () => new Promise(r => { finish = r; }); await start(x);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  x.store.load({ ...x.store.project, id: 'another-project' });
  const before = JSON.stringify(x.store.projectForSave()); finish(); await settled();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
  expect(x.store.history.undoStack).toHaveLength(0);
});
it('rechecks source state inside the save callback', async () => {
  const x = setup(), edit = x.ctx.actions.editClip;
  x.ctx.actions.editClip = (id, label, fn) => {
    x.store.update('Position keys', p => changes.xKeys(p, findClip(p, id).clip));
    return edit(id, label, fn);
  };
  await start(x); await settled();
  expect(x.store.history.undoStack).toHaveLength(1);
  expect(findClip(x.store.project, x.target.id).clip.keyframes.x).toEqual([{ t: 0, v: .3, ease: 'linear' }]);
  expect(document.querySelector('.toast.success')).toBeNull();
});
it('replaces an obsolete read failure with current-source feedback', async () => {
  const x = setup(); let fail;
  x.library.mediaBlob.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  await start(x); x.store.update('Relink', p => { p.assets.vid.hash = 'replacement'; });
  fail(new Error('Old file failed')); await settled();
  expect(document.body.textContent).not.toContain('Old file failed');
  expect(document.body.textContent).toContain('Reopen Stabilize');
});
it('allows movement, names, unrelated grading and frame-rate edits while analysis is pending', async () => {
  const x = setup(); let finish;
  x.store.project.assets.vid.fps = 30;
  work.pause = () => new Promise(r => { finish = r; }); await start(x);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  x.store.update('Other edits', p => {
    const c = findClip(p, x.target.id).clip;
    p.name = 'Renamed'; p.settings.fps = 24;
    c.name = 'New name'; c.start = 2000000; c.adjust.contrast = 10;
    c.keyframes['adjust.exposure'] = [{ t: 0, v: 20, ease: 'linear' }];
  }, { structural: false });
  finish(); await settled();
  expect(x.store.history.undoStack).toHaveLength(2);
  expect(document.querySelector('.toast.success')).not.toBeNull();
  expect(x.target.start).toBe(2000000); expect(x.target.adjust.contrast).toBe(10);
  expect(x.target.keyframes['adjust.exposure']).toEqual([{ t: 0, v: 20, ease: 'linear' }]);
});
