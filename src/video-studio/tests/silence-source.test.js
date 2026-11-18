import { it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { findClip, mainTrack } from '../src/model/timeline.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';
const work = vi.hoisted(() => ({ pause: null }));
vi.mock('../src/media/transcribe.js', async original => ({ ...await original(), mixdown: async () => {
  if (work.pause) await work.pause(); const data = new Float32Array(32000);
  for (let i = 0; i < data.length; i++) if (i < 8000 || i >= 24000) data[i] = .5 * Math.sin(i * .3); return data;
} }));
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); work.pause = null; });
function setup() {
  const p = fixture(), [target] = onMain(p, clip('video', 0, 4)); p.assets.replacement = { ...p.assets.vid, id: 'replacement', name: 'Replacement' };
  const store = new EditorStore(p), ctx = { store, library: {} }; ctx.actions = createActions(ctx); return { ctx, store, target };
}
async function open(ctx) { await ctx.actions.removeSilences(); const dialog = document.querySelector('dialog[open]'), button = text => [...dialog.querySelectorAll('button')].find(b => b.textContent === text); return { dialog, find: button('Find silences'), cut: button('Cut them'), status: dialog.querySelector('[role=status]') }; }
const settled = async ui => vi.waitFor(() => expect(ui.find.disabled).toBe(false));
function change(env, how) {
  const { ctx, store, target } = env;
  if (how === 'replace') ctx.actions.replaceClip(target.id, store.project.assets.replacement);
  else if (how === 'project') { const p = fixture(); onMain(p, clip('video', 0, 4)); store.load(p); }
  else store.update(how, p => { const f = findClip(p, target.id); if (how === 'overlay') p.tracks.push(makeTrack('text', { clips: [clip('text', 1, 3)] })); if (how === 'move') f.clip.start = 5000000; if (how === 'trim') f.clip.duration = 2000000; if (how === 'lock') f.track.locked = true; if (how === 'asset') p.assets[f.clip.assetId].hash = 'different-media'; });
}
it.each(['replace', 'move', 'project', 'asset', 'overlay'])('discards results when %s changes during analysis', async how => {
  let finish; work.pause = () => new Promise(r => { finish = r; }); const env = setup(), ui = await open(env.ctx); ui.find.click(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  change(env, how); const before = JSON.stringify(env.store.projectForSave()), history = env.store.history.undoStack.length; finish(); await settled(ui); ui.cut.click();
  expect(JSON.stringify(env.store.projectForSave())).toBe(before); expect(env.store.history.undoStack).toHaveLength(history); expect(ui.cut.disabled).toBe(true); expect(ui.status.textContent).toContain('Timeline changed'); expect(ui.dialog.open).toBe(true);
});
it.each(['replace', 'trim', 'lock', 'project'])('rejects ready silence ranges after %s changes', async how => {
  const env = setup(), ui = await open(env.ctx); ui.find.click(); await settled(ui); expect(ui.cut.disabled).toBe(false); change(env, how);
  const before = JSON.stringify(env.store.projectForSave()), history = env.store.history.undoStack.length; ui.cut.click();
  expect(JSON.stringify(env.store.projectForSave())).toBe(before); expect(env.store.history.undoStack).toHaveLength(history); expect(ui.dialog.open).toBe(true); expect(ui.cut.disabled).toBe(true); expect(ui.status.textContent).toContain('Timeline changed');
});
it('allows unrelated project names, selection and playhead changes with undo and reopening', async () => {
  let finish; work.pause = () => new Promise(r => { finish = r; }); const { ctx, store } = setup(), ui = await open(ctx); ui.find.click(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  store.update('Rename project', p => { p.name = 'Renamed'; p.assets.unused = { ...p.assets.vid, id: 'unused' };  }); store.clearSelection(); store.seek(500000); finish(); await settled(ui); ui.cut.click();
  expect(store.history.undoStack).toHaveLength(2); expect(store.project.name).toBe('Renamed'); expect(mainTrack(store.project).clips.reduce((n,c) => n+c.duration,0)).toBe(2240000);
  store.undo(); expect(mainTrack(store.project).clips).toHaveLength(1); store.redo(); expect(mainTrack(normalizeProject(store.projectForSave())).clips.reduce((n,c) => n+c.duration,0)).toBe(2240000);
});
it('can find again and cut the replacement source after rejecting old ranges', async () => {
  const env = setup(), ui = await open(env.ctx); ui.find.click(); await settled(ui); change(env, 'replace'); ui.cut.click();
  expect(env.store.history.undoStack).toHaveLength(1); ui.find.click(); await settled(ui); ui.cut.click(); expect(env.store.history.undoStack).toHaveLength(2); expect(mainTrack(env.store.project).clips.map(c => c.assetId)).toEqual(['replacement','replacement']);
});
