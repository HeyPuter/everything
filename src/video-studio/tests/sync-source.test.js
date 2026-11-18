import { it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { findClip } from '../src/model/timeline.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';
const work = vi.hoisted(() => ({ at: 2, pause: null, calls: 0 }));
vi.mock('../src/media/audio-analysis.js', async original => ({ ...await original(), decodeClipSound: async () => {
  if (++work.calls === work.at && work.pause) await work.pause();
  return { sampleRate: 8000, channels: [Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i * .3) * (.15 + .1 * Math.sin(i / 350) + .05 * Math.cos(i / 141)))] };
} }));
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); work.at = 2; work.pause = null; work.calls = 0; vi.restoreAllMocks(); });
function setup() {
  vi.spyOn(console, 'error').mockImplementation(() => {}); const p = fixture(), ref = clip('video', 0, 2), mov = clip('audio', 3, 2); onMain(p, ref); p.tracks.push(makeTrack('audio', { clips: [mov] })); p.assets.replacement = { ...p.assets.aud, id: 'replacement', hash: 'new' }; const store = new EditorStore(p); store.select([ref.id, mov.id]); const ctx = { store, library: {} }; ctx.actions = createActions(ctx); return { ctx, store, ref: ref.id, mov: mov.id };
}
const changes = {
  replace: (p, x) => { findClip(p, x.mov).clip.assetId = 'replacement'; },
  reference: (p, x) => { findClip(p, x.ref).clip.assetId = 'replacement'; },
  move: (p, x) => { findClip(p, x.mov).clip.start = 5000000; },
  trim: (p, x) => { findClip(p, x.ref).clip.in = 500000; },
  speed: (p, x) => { findClip(p, x.mov).clip.speed = 2; },
  media: p => { p.assets.aud.hash = 'relinked'; },
  lock: (p, x) => { findClip(p, x.mov).track.locked = true; },
  delete: (p, x) => { const f = findClip(p, x.ref); f.track.clips.splice(f.index, 1); },
};
it.each(Object.keys(changes))('rejects stale or unsaved sync after %s', async change => {
  let finish; work.pause = () => new Promise(r => { finish = r; }); const x = setup(), pending = x.ctx.actions.syncBySound(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); x.store.update(change, p => changes[change](p, x)); const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length; finish(); await pending;
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(history); expect(document.querySelector('.toast.success')).toBeNull(); expect(document.querySelector('.toast.error')).toBeTruthy();
});
it('rejects old sound after loading a different project with the same clip ids', async () => {
  let finish; work.pause = () => new Promise(r => { finish = r; }); const x = setup(), pending = x.ctx.actions.syncBySound(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); const next = structuredClone(x.store.project); next.id = 'other'; x.store.load(next); const before = JSON.stringify(x.store.projectForSave()); finish(); await pending;
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.error')).toBeTruthy();
});
it('stops before reading the second clip if the first input changes', async () => {
  let finish; work.at = 1; work.pause = () => new Promise(r => { finish = r; }); const x = setup(), pending = x.ctx.actions.syncBySound(); x.store.update('Replace', p => changes.reference(p, x)); finish(); await pending;
  expect(work.calls).toBe(1); expect(x.store.history.undoStack).toHaveLength(1); expect(document.querySelector('.toast.error')).toBeTruthy();
});
it('reports a refused alignment transaction', async () => {
  const x = setup(); vi.spyOn(x.store, 'update').mockReturnValue(false); await x.ctx.actions.syncBySound(); expect(x.store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.success')).toBeNull(); expect(document.body.textContent).toContain('could not be saved');
});
it('keeps unrelated edits and successful alignment undoable and reopenable', async () => {
  let finish; work.pause = () => new Promise(r => { finish = r; }); const x = setup(), pending = x.ctx.actions.syncBySound(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); x.store.update('Unrelated', p => { p.name = 'Renamed'; p.assets.unused = { ...p.assets.img, id: 'unused' }; }); x.store.select([]); x.store.seek(100000); finish(); await pending;
  const start = p => findClip(p, x.mov).clip.start; expect(start(x.store.project)).toBe(0); expect(x.store.project.name).toBe('Renamed'); expect(x.store.history.undoStack).toHaveLength(2); x.store.undo(); expect(start(x.store.project)).toBe(3000000); x.store.redo(); expect(start(normalizeProject(x.store.projectForSave()))).toBe(0);
});
it('can retry with replacement sound after rejecting an obsolete result', async () => {
  let finish; work.pause = () => new Promise(r => { finish = r; }); const x = setup(), pending = x.ctx.actions.syncBySound(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); x.store.update('Replace', p => changes.replace(p, x)); finish(); await pending; expect(x.store.history.undoStack).toHaveLength(1); work.pause = null; await x.ctx.actions.syncBySound(); expect(x.store.history.undoStack).toHaveLength(2); expect(findClip(x.store.project, x.mov).clip.start).toBe(0);
});
it.each([false, true])('reports current errors but replaces obsolete errors with source feedback (changed=%s)', async changed => {
  let fail; work.pause = () => new Promise((_, reject) => { fail = reject; }); const x = setup(), pending = x.ctx.actions.syncBySound(); await vi.waitFor(() => expect(fail).toBeTypeOf('function')); if (changed) x.store.update('Replace', p => changes.replace(p, x)); fail(new Error('Read failure')); await pending;
  if (changed) { expect(document.body.textContent).not.toContain('Read failure'); expect(document.body.textContent).toContain('Run sync again'); } else expect(document.body.textContent).toContain('Read failure');
});
