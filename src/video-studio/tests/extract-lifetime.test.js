import { it, expect, vi, afterEach } from 'vitest';
import { Editor } from '../src/ui/editor.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { normalizeProject, normalizeAsset } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';
const work = vi.hoisted(() => ({ pause: null, signal: null, extract: vi.fn() }));
vi.mock('../src/media/extract-audio.js', async original => ({ ...await original(), extractClipAudio: async (_open, _asset, _clip, { signal }) => {
  work.extract(); work.signal = signal; if (work.pause) await work.pause(); return { file: new File(['audio'], 'Extracted.wav', { type: 'audio/wav' }) };
} }));
const owners = [], dispose = owner => Editor.prototype.dispose.call(owner);
afterEach(() => { owners.splice(0).forEach(dispose); document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); work.pause = null; work.signal = null; work.extract.mockClear(); vi.restoreAllMocks(); });
function setup(importFile = async () => normalizeAsset({ id: 'extracted', name: 'Extracted.wav', kind: 'audio', duration: 1000000 })) {
  vi.spyOn(console, 'error').mockImplementation(() => {}); const p = fixture(), c = clip('video', 0, 1); onMain(p, c); const store = new EditorStore(p); store.select(c.id);
  const library = { importFile: vi.fn(importFile), releaseMedia() {} }, ctx = { store, library };
  const owner = { ctx, library, _cancelCover() {}, saver: { dispose() {} }, proxies: { dispose() {} }, media: { dispose() {} } }; ctx.editor = owner; ctx.actions = createActions(ctx); owners.push(owner); return { ctx, store, owner };
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
it('does not start extraction after the editor is disposed', async () => {
  const { ctx, owner, store } = setup(); dispose(owner); await ctx.actions.extractAudio(); expect(work.extract).not.toHaveBeenCalled(); expect(ctx.library.importFile).not.toHaveBeenCalled(); expect(store.history.undoStack).toHaveLength(0); expect(document.querySelector('dialog[open]')).toBeNull();
});
it.each(['resolve', 'reject'])('closes and cancels extraction before an old result can %s', async how => {
  let finish; work.pause = () => new Promise((resolve, reject) => { finish = () => how === 'resolve' ? resolve() : reject(new Error('Obsolete extraction')); }); const { ctx, owner, store } = setup(), before = JSON.stringify(store.projectForSave()); const pending = ctx.actions.extractAudio();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); dispose(owner); const state = { closed: !document.querySelector('dialog[open]'), aborted: work.signal.aborted }; finish(); await pending;
  expect(state).toEqual({ closed: true, aborted: true }); expect(ctx.library.importFile).not.toHaveBeenCalled(); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(console.error).not.toHaveBeenCalled(); expect(document.querySelector('.toast.success')).toBeNull();
});
it.each(['resolve', 'reject'])('does not register an imported extraction after disposal and late %s', async how => {
  let finish; const { ctx, owner, store } = setup(() => new Promise((resolve, reject) => { finish = () => how === 'resolve' ? resolve(normalizeAsset({ id: 'late', name: 'Late.wav', kind: 'audio' })) : reject(new Error('Obsolete extracted import')); })); const before = JSON.stringify(store.projectForSave()), pending = ctx.actions.extractAudio();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); expect(ctx.imports.size).toBe(1); dispose(owner); finish(); await pending; await flush();
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(ctx.imports.size).toBe(0); expect(console.error).not.toHaveBeenCalled(); expect(document.querySelector('.toast.success')).toBeNull(); expect(document.querySelector('.toast.error')).toBeNull();
});
it('lets a fresh editor extract while an old extraction is still pending', async () => {
  let finish; work.pause = () => new Promise(r => { finish = r; }); const old = setup(), pending = old.ctx.actions.extractAudio(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); dispose(old.owner); work.pause = null; const fresh = setup(); const result = await fresh.ctx.actions.extractAudio(); const noDialogs = !document.querySelector('dialog[open]'); finish(); await pending;
  expect(result.kind).toBe('audio'); expect(noDialogs).toBe(true); expect(old.store.history.undoStack).toHaveLength(0); expect(fresh.store.history.undoStack).toHaveLength(1); fresh.store.undo(); expect(fresh.store.project.assets.extracted).toBeUndefined(); fresh.store.redo(); expect(normalizeProject(fresh.store.projectForSave()).assets.extracted.kind).toBe('audio');
});
it('keeps ordinary pending imports tracked and completes them before normal disposal', async () => {
  let finish; const { ctx, owner, store } = setup(() => new Promise(r => { finish = () => r(normalizeAsset({ id: 'normal', name: 'Normal.wav', kind: 'audio' })); })); const pending = ctx.actions.extractAudio(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); expect(ctx.imports.size).toBe(1); finish(); expect((await pending).id).toBe('normal'); expect(store.project.assets.normal).toBeDefined(); expect(store.history.undoStack).toHaveLength(1); expect(ctx.imports.size).toBe(0); dispose(owner);
});
