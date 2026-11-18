import { it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { findClip, mainTrack } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';
const decode = vi.hoisted(() => ({ phase: '', pause: null, steady: false, constructed: vi.fn(), disposed: vi.fn(), returned: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class {
  constructor() { decode.constructed(); }
  async getPrimaryVideoTrack() { if (decode.phase === 'track') await decode.pause(); return { canDecode: async () => { if (decode.phase === 'capability') await decode.pause(); return true; } }; }
  dispose() { decode.disposed(); }
}, CanvasSink: class {
  async *canvasesAtTimestamps(times) { try { for (const t of times) { if (decode.phase === 'coarse') await decode.pause(); yield { canvas: { level: !decode.steady && t >= 1 ? 240 : 20 }, timestamp: t }; } } finally { decode.returned(); } }
  async *canvases(start, end) { try { for (let i = Math.floor(start * 30); i / 30 < end; i++) { if (decode.phase === 'fine') await decode.pause(); yield { canvas: { level: i >= 30 ? 240 : 20 }, timestamp: i / 30 }; } if (decode.phase === 'end') await decode.pause(); } finally { decode.returned(); } }
} }));
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); decode.phase = ''; decode.pause = null; decode.steady = false; decode.constructed.mockClear(); decode.disposed.mockClear(); decode.returned.mockClear(); });
function setup(mediaBlob = async () => new Blob()) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('OffscreenCanvas', class { getContext() { let level = 0; return { drawImage(c) { level = c.level; }, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(level) }) }; } });
  const p = fixture(); onMain(p, clip('video', 0, 3)); const store = new EditorStore(p); store.select(mainTrack(p).clips[0].id);
  const ctx = { store, library: { mediaBlob } }; ctx.actions = createActions(ctx); return { ctx, store, target: mainTrack(p).clips[0] };
}

it('discards old media before decoding when its clip is replaced during loading', async () => {
  let finish; const { ctx, store, target } = setup(() => new Promise(r => { finish = r; }));
  const pending = ctx.actions.splitScenes(); ctx.actions.replaceClip(target.id, store.project.assets.silent);
  const before = JSON.stringify(store.projectForSave()), history = store.history.undoStack.length;
  finish(new Blob()); await pending;
  expect(decode.constructed).not.toHaveBeenCalled(); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(history);
  expect(document.body.textContent).toContain('Run scene detection again');
});
it.each(['replace', 'delete', 'lock'])('rejects obsolete or unsaved scene results after %s', async change => {
  let finish; decode.phase = 'end'; decode.pause = () => new Promise(r => { finish = r; });
  const { ctx, store, target } = setup(); const pending = ctx.actions.splitScenes(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  if (change === 'replace') ctx.actions.replaceClip(target.id, store.project.assets.silent);
  else store.update(change, p => { const f = findClip(p, target.id); if (change === 'lock') f.track.locked = true; else f.track.clips.splice(f.track.clips.indexOf(f.clip), 1); });
  const before = JSON.stringify(store.projectForSave()), history = store.history.undoStack.length; finish(); await pending;
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(history);
  expect(document.body.textContent).not.toContain('Split into'); expect(document.querySelector('.toast.error')).toBeTruthy();
});
it('does not claim scene splits were saved when their transaction was refused', async () => {
  const { ctx, store } = setup(); vi.spyOn(store, 'update').mockReturnValue(false); await ctx.actions.splitScenes();
  expect(store.history.undoStack).toHaveLength(0); expect(document.body.textContent).not.toContain('Split into'); expect(document.body.textContent).toContain('could not be saved');
});
it('keeps unrelated edits and normal scene splits undoable and reopenable', async () => {
  let finish; decode.phase = 'end'; decode.pause = () => new Promise(r => { finish = r; });
  const { ctx, store } = setup(); const pending = ctx.actions.splitScenes(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  store.update('Rename project', p => { p.name = 'Renamed'; }); finish(); await pending;
  expect(store.history.undoStack).toHaveLength(2); expect(store.project.name).toBe('Renamed'); expect(mainTrack(store.project).clips.map(c => c.start)).toEqual([0, 1000000]);
  store.undo(); expect(mainTrack(store.project).clips).toHaveLength(1); store.redo(); expect(mainTrack(normalizeProject(store.projectForSave())).clips.map(c => c.start)).toEqual([0, 1000000]);
});
it('can analyze replacement media after rejecting obsolete cuts', async () => {
  let finish; decode.phase = 'end'; decode.pause = () => new Promise(r => { finish = r; });
  const { ctx, store, target } = setup(); const pending = ctx.actions.splitScenes(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  ctx.actions.replaceClip(target.id, store.project.assets.silent); finish(); await pending;
  expect(store.history.undoStack).toHaveLength(1); decode.phase = ''; await ctx.actions.splitScenes();
  expect(store.history.undoStack).toHaveLength(2); expect(mainTrack(store.project).clips.map(c => c.start)).toEqual([0, 1000000]); expect(target.assetId).toBe('silent');
});
it('reports current read errors and replaces obsolete errors with source-change feedback', async () => {
  let fail; const { ctx, store, target } = setup(() => new Promise((_, reject) => { fail = reject; }));
  let pending = ctx.actions.splitScenes(); fail(new Error('Current scene read failed')); await pending; expect(document.body.textContent).toContain('Current scene read failed');
  pending = ctx.actions.splitScenes(); ctx.actions.replaceClip(target.id, store.project.assets.silent); fail(new Error('Obsolete scene read failed')); await pending;
  expect(document.body.textContent).not.toContain('Obsolete scene read failed'); expect(document.body.textContent).toContain('Run scene detection again');
});
