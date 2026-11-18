import { it, expect, vi, afterEach } from 'vitest';
import { Editor } from '../src/ui/editor.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { mainTrack } from '../src/model/timeline.js';
import { fixture, clip, onMain } from './helpers.js';
const work = vi.hoisted(() => ({ finish: null, delay: false, signal: null, detect: vi.fn() }));
vi.mock('../src/media/smart-edit.js', async original => ({ ...await original(), detectScenes: async (_blob, _from, _to, { signal }) => {
  work.detect(); work.signal = signal;
  if (work.delay) await new Promise(r => { work.finish = r; });
  return [1000000];
} }));
const owners = [];
const dispose = owner => Editor.prototype.dispose.call(owner);
afterEach(() => {
  owners.splice(0).forEach(dispose); document.querySelectorAll('.dialog-close').forEach(b => b.click());
  document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren();
  work.finish = null; work.delay = false; work.signal = null; work.detect.mockClear(); vi.restoreAllMocks();
});
function setup(mediaBlob = async () => new Blob()) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const p = fixture(); onMain(p, clip('video', 0, 3));
  const store = new EditorStore(p); store.select(mainTrack(p).clips[0].id);
  const library = { mediaBlob: vi.fn(mediaBlob), releaseMedia() {} };
  const ctx = { store, library }; const owner = { ctx, library, _cancelCover() {}, saver: { dispose() {} }, proxies: { dispose() {} }, media: { dispose() {} } };
  ctx.editor = owner; ctx.actions = createActions(ctx); owners.push(owner); return { ctx, store, owner };
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
it('never starts scene detection for a disposed editor', async () => {
  const { ctx, store, owner } = setup(); dispose(owner); await ctx.actions.splitScenes();
  expect(ctx.library.mediaBlob).not.toHaveBeenCalled(); expect(work.detect).not.toHaveBeenCalled(); expect(store.history.undoStack).toHaveLength(0);
  expect(document.querySelector('dialog[open]')).toBeNull();
});
it('closes progress and settles before a disposed editor media read finishes', async () => {
  let finish, settled = false; const { ctx, store, owner } = setup(() => new Promise(r => { finish = r; })); const before = JSON.stringify(store.projectForSave());
  const pending = ctx.actions.splitScenes().finally(() => { settled = true; }); dispose(owner); await flush();
  try { expect(document.querySelector('dialog[open]')).toBeNull(); expect(settled).toBe(true); }
  finally { finish(new Blob()); await pending; }
  expect(work.detect).not.toHaveBeenCalled(); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
});
it('ignores a media read failure after scene detection loses its editor', async () => {
  let fail; const { ctx, owner } = setup(() => new Promise((_, reject) => { fail = reject; })); const pending = ctx.actions.splitScenes();
  dispose(owner); fail(new Error('Old scene media failed')); await pending;
  expect(document.body.textContent).not.toContain('Old scene media failed'); expect(console.error).not.toHaveBeenCalled(); expect(document.querySelector('dialog[open]')).toBeNull();
});
it('aborts active analysis and discards its final cuts after editor disposal', async () => {
  work.delay = true; const { ctx, store, owner } = setup(); const before = JSON.stringify(store.projectForSave()); const pending = ctx.actions.splitScenes();
  await vi.waitFor(() => expect(work.finish).toBeTypeOf('function')); dispose(owner); const aborted = work.signal.aborted; work.finish(); await pending;
  expect(aborted).toBe(true); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
  expect(document.querySelector('dialog[open]')).toBeNull(); expect(document.body.textContent).not.toContain('Split into');
});
it('lets a new editor split scenes while an old media read remains pending', async () => {
  let fail; const old = setup(() => new Promise((_, reject) => { fail = reject; })); const pending = old.ctx.actions.splitScenes(); dispose(old.owner);
  const fresh = setup(); await fresh.ctx.actions.splitScenes();
  try { expect(mainTrack(fresh.store.project).clips.map(c => c.start)).toEqual([0, 1000000]); expect(fresh.store.history.undoStack).toHaveLength(1); expect(document.querySelector('dialog[open]')).toBeNull(); }
  finally { fail(new Error('Old scene media failed')); await pending; }
  expect(document.body.textContent).not.toContain('Old scene media failed'); expect(old.store.history.undoStack).toHaveLength(0);
});
