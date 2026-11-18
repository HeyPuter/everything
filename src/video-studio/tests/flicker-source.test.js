import { it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { fixture, clip, onMain } from './helpers.js';
import { findClip } from '../src/model/timeline.js';
const decode = vi.hoisted(() => ({ pause: null, constructed: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class { constructor() { decode.constructed(); } async getPrimaryVideoTrack() { return { canDecode: async () => true }; } dispose() {} }, CanvasSink: class {
  async *canvasesAtTimestamps(times) { let i = 0; for (const _ of times) yield { canvas: { level: i++ % 2 ? 140 : 120 } }; if (decode.pause) await decode.pause(); }
} }));
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); decode.pause = null; decode.constructed.mockClear(); });
function setup(mediaBlob = async () => new Blob()) {
  vi.stubGlobal('OffscreenCanvas', class { getContext() { let level = 0; return { drawImage(c) { level = c.level; }, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(level) }) }; } });
  const p = fixture(); const [target] = onMain(p, clip('video', 0, .8)); target.keyframes.x = [{ t: 0, v: .1 }]; target.keyframes.scale = [{ t: 0, v: 1.2 }];
  const store = new EditorStore(p); store.select(target.id); const ctx = { store, library: { mediaBlob } }; ctx.actions = createActions(ctx); return { ctx, store, target };
}
const go = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Remove flicker').click();
async function start(ctx) { await ctx.actions.removeFlicker(); go(); }
const settled = async () => vi.waitFor(() => expect(document.querySelector('dialog[open]')).toBeNull());
it('rejects media replaced while the flicker removal settings dialog is open', async () => {
  const { ctx, store, target } = setup(); await ctx.actions.removeFlicker(); ctx.actions.replaceClip(target.id, store.project.assets.img);
  const before = JSON.stringify(store.projectForSave()), history = store.history.undoStack.length; go(); await settled();
  expect(decode.constructed).not.toHaveBeenCalled(); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(history);
  expect(document.body.textContent).toContain('Reopen Remove flicker');
});
it('discards an old media read without decoding a replacement clip', async () => {
  let finish; const { ctx, store, target } = setup(() => new Promise(r => { finish = r; })); await start(ctx);
  ctx.actions.replaceClip(target.id, store.project.assets.silent); const before = JSON.stringify(store.projectForSave()), history = store.history.undoStack.length;
  finish(new Blob()); await settled();
  expect(decode.constructed).not.toHaveBeenCalled(); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(history);
  expect(document.body.textContent).toContain('Reopen Remove flicker');
});
it.each(['replace', 'delete', 'lock'])('does not report success or alter a changed clip after analysis: %s', async change => {
  let finish; decode.pause = () => new Promise(r => { finish = r; });
  const { ctx, store, target } = setup(); await start(ctx); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  if (change === 'replace') ctx.actions.replaceClip(target.id, store.project.assets.silent);
  else store.update(change, p => { const f = findClip(p, target.id); if (change === 'lock') f.track.locked = true; else f.track.clips.splice(f.track.clips.indexOf(f.clip), 1); });
  const before = JSON.stringify(store.projectForSave()), history = store.history.undoStack.length; finish(); await settled();
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(history);
  expect(document.body.textContent).not.toContain('Flicker reduced'); expect(document.querySelector('.toast.error')).toBeTruthy();
});
it('does not report success when the flicker removal transaction is refused', async () => {
  const { ctx, store } = setup(); vi.spyOn(ctx.actions, 'editClip').mockReturnValue(false); await start(ctx); await settled();
  expect(store.history.undoStack).toHaveLength(0); expect(document.body.textContent).not.toContain('Flicker reduced');
  expect(document.body.textContent).toContain('could not be saved');
});
it('allows unrelated edits and keeps normal flicker removal undoable', async () => {
  let finish; decode.pause = () => new Promise(r => { finish = r; });
  const { ctx, store, target } = setup(); const original = structuredClone(target.keyframes); await start(ctx);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); store.update('Rename project', p => { p.name = 'Renamed'; });
  finish(); await settled(); expect(store.history.undoStack).toHaveLength(2); expect(store.project.name).toBe('Renamed');
  const result = structuredClone(target.keyframes); store.undo(); expect(findClip(store.project, target.id).clip.keyframes).toEqual(original);
  store.redo(); expect(findClip(store.project, target.id).clip.keyframes).toEqual(result);
});
it('can reopen and correct replacement media after rejecting an old result', async () => {
  let finish; decode.pause = () => new Promise(r => { finish = r; });
  const { ctx, store, target } = setup(); await start(ctx); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  ctx.actions.replaceClip(target.id, store.project.assets.silent); finish(); await settled();
  expect(store.history.undoStack).toHaveLength(1); decode.pause = null; await start(ctx); await settled();
  expect(store.history.undoStack).toHaveLength(2); expect(target.assetId).toBe('silent'); expect(target.keyframes['adjust.exposure'].length).toBeGreaterThan(1);
});
it('reports current-media errors while replacing obsolete read errors with source-change feedback', async () => {
  let fail; const { ctx, store, target } = setup(() => new Promise((_, reject) => { fail = reject; }));
  await start(ctx); fail(new Error('Current flicker removal read failed')); await settled();
  expect(document.body.textContent).toContain('Current flicker removal read failed');
  await start(ctx); ctx.actions.replaceClip(target.id, store.project.assets.silent); fail(new Error('Obsolete flicker removal read failed')); await settled();
  expect(document.body.textContent).not.toContain('Obsolete flicker removal read failed'); expect(document.body.textContent).toContain('Reopen Remove flicker');
});
