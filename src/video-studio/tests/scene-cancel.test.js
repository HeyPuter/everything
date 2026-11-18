import { it, expect, vi, afterEach } from 'vitest';
import { detectScenes } from '../src/media/smart-edit.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { mainTrack } from '../src/model/timeline.js';
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
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); decode.phase = ''; decode.pause = null; decode.steady = false; decode.constructed.mockClear(); decode.disposed.mockClear(); decode.returned.mockClear(); });
function setup(mediaBlob = async () => new Blob()) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('OffscreenCanvas', class { getContext() { let level = 0; return { drawImage(c) { level = c.level; }, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(level) }) }; } });
  const p = fixture(); onMain(p, clip('video', 0, 3)); const store = new EditorStore(p); store.select(mainTrack(p).clips[0].id);
  const ctx = { store, library: { mediaBlob } }; ctx.actions = createActions(ctx); return { ctx, store };
}
const cancel = () => document.querySelector('dialog[open] .dialog-close').click();
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
it('does not decode a scene read that completes after cancellation', async () => {
  let finish; const { ctx, store } = setup(() => new Promise(r => { finish = r; })); const before = JSON.stringify(store.projectForSave());
  const pending = ctx.actions.splitScenes(); cancel(); finish(new Blob()); await pending;
  expect(decode.constructed).not.toHaveBeenCalled(); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
});
it('ignores a late scene-file failure after cancellation', async () => {
  let fail; const { ctx } = setup(() => new Promise((_, reject) => { fail = reject; })); const pending = ctx.actions.splitScenes(); cancel(); fail(new Error('Canceled scene read failed')); await pending;
  expect(document.body.textContent).not.toContain('Canceled scene read failed'); expect(console.error).not.toHaveBeenCalled();
});
it('does not split a clip when canceled during final scene refinement completion', async () => {
  let finish; decode.phase = 'end'; decode.pause = () => new Promise(r => { finish = r; }); const { ctx, store } = setup(); const before = JSON.stringify(store.projectForSave());
  const pending = ctx.actions.splitScenes(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); cancel(); finish(); await pending;
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(document.body.textContent).not.toContain('Split into');
});
it('disposes the scene decoder before a canceled coarse frame read finishes', async () => {
  let finish; decode.phase = 'coarse'; decode.pause = () => new Promise(r => { finish = r; }); const { ctx } = setup(); const pending = ctx.actions.splitScenes();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); cancel(); await flush();
  try { expect(decode.disposed).toHaveBeenCalledOnce(); }
  finally { decode.phase = ''; finish(); await pending; }
});
it.each(['track', 'capability', 'coarse', 'fine'])('settles cancellation during scene %s reads and handles their late rejection', async phase => {
  setup(); let fail; decode.phase = phase; decode.pause = () => new Promise((_, reject) => { fail = reject; }); const ac = new AbortController(); let settled = false;
  const pending = detectScenes(new Blob(), 0, 3000000, { signal: ac.signal }).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  await vi.waitFor(() => expect(fail).toBeTypeOf('function')); ac.abort(); await flush();
  try { expect(settled).toBe(true); expect(decode.disposed).toHaveBeenCalledOnce(); }
  finally { fail(new Error('Late scene decoder failure')); await flush(); }
  expect((await pending).error?.name).toBe('AbortError');
});
it('does not construct a decoder for already canceled scene detection', async () => {
  const ac = new AbortController(); ac.abort(); await expect(detectScenes(new Blob(), 0, 3000000, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(decode.constructed).not.toHaveBeenCalled();
});
it('still splits the detected frame with undo, redo and reopening', async () => {
  const { ctx, store } = setup(); await ctx.actions.splitScenes(); expect(mainTrack(store.project).clips.map(c => c.start)).toEqual([0, 1000000]); expect(store.history.undoStack).toHaveLength(1);
  store.undo(); expect(mainTrack(store.project).clips).toHaveLength(1); store.redo(); expect(mainTrack(normalizeProject(store.projectForSave())).clips.map(c => c.start)).toEqual([0, 1000000]);
  expect(decode.disposed).toHaveBeenCalledOnce();
});
it('leaves a single scene unchanged and reports no cuts', async () => {
  decode.steady = true; const { ctx, store } = setup(); const before = JSON.stringify(store.projectForSave()); await ctx.actions.splitScenes();
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(document.body.textContent).toContain('No scene changes');
});
