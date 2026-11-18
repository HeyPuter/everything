import { it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { fixture, clip, onMain } from './helpers.js';
import { findClip } from '../src/model/timeline.js';
const decode = vi.hoisted(() => ({ pause: null, constructed: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class { constructor() { decode.constructed(); } async getPrimaryVideoTrack() { return { canDecode: async () => true }; } dispose() {} }, CanvasSink: class {
  async *canvasesAtTimestamps(times) { for (const _ of times) yield { canvas: {} }; if (decode.pause) await decode.pause(); }
} }));
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); decode.pause = null; decode.constructed.mockClear(); });
function setup(mediaBlob = async () => new Blob()) {
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return { drawImage() {}, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(127) }) }; } });
  const p = fixture(); const [target] = onMain(p, clip('video', 0, .2)); target.keyframes.x = [{ t: 0, v: .1 }]; target.keyframes.scale = [{ t: 0, v: 1.2 }];
  const store = new EditorStore(p); store.select(target.id); const ctx = { store, library: { mediaBlob } }; ctx.actions = createActions(ctx); return { ctx, store, target };
}
const go = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Stabilize').click();
async function start(ctx) { await ctx.actions.stabilize(); go(); }
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
it('rejects media replaced while the stabilization settings dialog is open', async () => {
  const { ctx, store, target } = setup(); await ctx.actions.stabilize(); ctx.actions.replaceClip(target.id, store.project.assets.img);
  const before = JSON.stringify(store.projectForSave()), history = store.history.undoStack.length; go(); await flush();
  expect(decode.constructed).not.toHaveBeenCalled(); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(history);
  expect(document.body.textContent).toContain('Reopen Stabilize');
});
it('discards an old media read without decoding a replacement clip', async () => {
  let finish; const { ctx, store, target } = setup(() => new Promise(r => { finish = r; })); await start(ctx);
  ctx.actions.replaceClip(target.id, store.project.assets.silent); const before = JSON.stringify(store.projectForSave()), history = store.history.undoStack.length;
  finish(new Blob()); await flush();
  expect(decode.constructed).not.toHaveBeenCalled(); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(history);
  expect(document.body.textContent).toContain('Reopen Stabilize');
});
it.each(['replace', 'delete', 'lock'])('does not report success or alter a changed clip after analysis: %s', async change => {
  let finish; decode.pause = () => new Promise(r => { finish = r; });
  const { ctx, store, target } = setup(); await start(ctx); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  if (change === 'replace') ctx.actions.replaceClip(target.id, store.project.assets.silent);
  else store.update(change, p => { const f = findClip(p, target.id); if (change === 'lock') f.track.locked = true; else f.track.clips.splice(f.track.clips.indexOf(f.clip), 1); });
  const before = JSON.stringify(store.projectForSave()), history = store.history.undoStack.length; finish(); await flush();
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(history);
  expect(document.body.textContent).not.toContain('Stabilized,'); expect(document.querySelector('.toast.error')).toBeTruthy();
});
it('does not report success when the stabilization transaction is refused', async () => {
  const { ctx, store } = setup(); vi.spyOn(ctx.actions, 'editClip').mockReturnValue(false); await start(ctx); await flush();
  expect(store.history.undoStack).toHaveLength(0); expect(document.body.textContent).not.toContain('Stabilized,');
  expect(document.body.textContent).toContain('could not be saved');
});
it('allows unrelated edits and keeps normal stabilization undoable', async () => {
  let finish; decode.pause = () => new Promise(r => { finish = r; });
  const { ctx, store, target } = setup(); const original = structuredClone(target.keyframes); await start(ctx);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); store.update('Rename project', p => { p.name = 'Renamed'; });
  finish(); await flush(); expect(store.history.undoStack).toHaveLength(2); expect(store.project.name).toBe('Renamed');
  const result = structuredClone(target.keyframes); store.undo(); expect(findClip(store.project, target.id).clip.keyframes).toEqual(original);
  store.redo(); expect(findClip(store.project, target.id).clip.keyframes).toEqual(result);
});
it('can reopen and stabilize replacement media after rejecting an old result', async () => {
  let finish; decode.pause = () => new Promise(r => { finish = r; });
  const { ctx, store, target } = setup(); await start(ctx); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  ctx.actions.replaceClip(target.id, store.project.assets.silent); finish(); await flush();
  expect(store.history.undoStack).toHaveLength(1); decode.pause = null; await start(ctx); await flush();
  expect(store.history.undoStack).toHaveLength(2); expect(target.assetId).toBe('silent'); expect(target.keyframes.scale).toBeUndefined();
});
it('reports current-media errors while replacing obsolete read errors with source-change feedback', async () => {
  let fail; const { ctx, store, target } = setup(() => new Promise((_, reject) => { fail = reject; }));
  await start(ctx); fail(new Error('Current stabilization read failed')); await flush();
  expect(document.body.textContent).toContain('Current stabilization read failed');
  await start(ctx); ctx.actions.replaceClip(target.id, store.project.assets.silent); fail(new Error('Obsolete stabilization read failed')); await flush();
  expect(document.body.textContent).not.toContain('Obsolete stabilization read failed'); expect(document.body.textContent).toContain('Reopen Stabilize');
});
