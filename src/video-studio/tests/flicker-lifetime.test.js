import { it, expect, vi, afterEach } from 'vitest';
import { Editor } from '../src/ui/editor.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { fixture, clip, onMain } from './helpers.js';
const work = vi.hoisted(() => ({ finish: null, delay: false }));
vi.mock('../src/media/flicker.js', async original => ({ ...await original(), frameLumas: async (_blob, times) => {
  if (work.delay) await new Promise(r => { work.finish = r; });
  return times.map((_, i) => i % 2 ? .55 : .45);
} }));
const owners = [];
const dispose = owner => Editor.prototype.dispose.call(owner);
afterEach(() => { owners.splice(0).forEach(dispose); document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.body.replaceChildren(); work.finish = null; work.delay = false; });
function setup(mediaBlob = async () => new Blob()) {
  const p = fixture(); const [target] = onMain(p, clip('video', 0, .8)); target.keyframes.x = [{ t: 0, v: .1 }];
  const store = new EditorStore(p); store.select(target.id); const library = { mediaBlob: vi.fn(mediaBlob), releaseMedia() {} };
  const ctx = { store, library }; const owner = { ctx, library, _cancelCover() {}, saver: { dispose() {} }, proxies: { dispose() {} }, media: { dispose() {} } }; ctx.editor = owner; ctx.actions = createActions(ctx); owners.push(owner);
  return { ctx, store, owner };
}
const go = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Remove flicker').click();
async function start(ctx) { await ctx.actions.removeFlicker(); go(); }
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
it('closes flicker removal settings when the editor is disposed', async () => {
  const { ctx, owner } = setup(); await ctx.actions.removeFlicker(); expect(document.querySelector('dialog[open]')).toBeTruthy();
  dispose(owner); expect(document.querySelector('dialog[open]')).toBeNull();
});
it('never opens flicker removal for a disposed editor', async () => {
  const { ctx, owner } = setup(); dispose(owner); await ctx.actions.removeFlicker();
  expect(document.querySelector('dialog[open]')).toBeNull(); expect(ctx.library.mediaBlob).not.toHaveBeenCalled();
});
it('closes progress and ignores a media read that finishes after disposal', async () => {
  let finish; const { ctx, owner, store } = setup(() => new Promise(r => { finish = r; })); const before = JSON.stringify(store.projectForSave());
  await start(ctx); dispose(owner);
  try { expect(document.querySelector('dialog[open]')).toBeNull(); }
  finally { finish(new Blob()); await flush(); }
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
});
it('does not save flicker removal results after the editor is disposed', async () => {
  work.delay = true; const { ctx, owner, store } = setup(); const before = JSON.stringify(store.projectForSave()); await start(ctx);
  await vi.waitFor(() => expect(work.finish).toBeTypeOf('function')); dispose(owner); work.finish(); await flush();
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
  expect(document.querySelector('dialog[open]')).toBeNull(); expect(document.body.textContent).not.toContain('Flicker reduced');
});
it('allows a new editor to remove flicker while an old read remains pending', async () => {
  let fail; const old = setup(() => new Promise((_, reject) => { fail = reject; })); await start(old.ctx); dispose(old.owner);
  const fresh = setup(); await start(fresh.ctx); await flush();
  try { expect(fresh.store.history.undoStack).toHaveLength(1); expect(document.querySelector('dialog[open]')).toBeNull(); }
  finally { fail(new Error('Old project read failed')); await flush(); }
  expect(document.body.textContent).not.toContain('Old project read failed');
});
