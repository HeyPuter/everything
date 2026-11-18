import { it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { fixture, clip, onMain } from './helpers.js';
import { mainTrack } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';

const decode = vi.hoisted(() => ({ missing: new Set(), dispose: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class { async getPrimaryVideoTrack() { return { canDecode: async () => true }; } dispose() { decode.dispose(); } }, CanvasSink: class {
  async *canvasesAtTimestamps(times) { for (let i = 0; i < times.length; i++) yield decode.missing.has(i) ? null : { canvas: {} }; }
} }));
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.body.replaceChildren(); vi.unstubAllGlobals(); decode.missing.clear(); decode.dispose.mockClear(); });
function setup(reversed = false) {
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return { drawImage() {}, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(127) }) }; } });
  const p = fixture(); const [target] = onMain(p, clip('video', 0, .2, { reversed }));
  target.keyframes.x = [{ t: 0, v: .1 }, { t: 100000, v: .2 }]; target.keyframes.scale = [{ t: 0, v: 1.2 }];
  const store = new EditorStore(p); store.select(target.id);
  const ctx = { store, library: { mediaBlob: async () => new Blob() } }; ctx.actions = createActions(ctx);
  return { ctx, store, target };
}
async function run(ctx) {
  await ctx.actions.stabilize();
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Stabilize').click();
  await vi.waitFor(() => expect(document.querySelector('dialog[open]')).toBeNull());
}
it.each([false, true])('keeps stabilization times when the first sample is unreadable (reverse=%s)', async reversed => {
  decode.missing.add(0); const { ctx, target } = setup(reversed); await run(ctx);
  expect(target.keyframes.x.map(k => k.t)).toEqual([66667, 133333]);
  expect(target.keyframes.y.map(k => k.t)).toEqual([66667, 133333]); expect(decode.dispose).toHaveBeenCalledOnce();
});
it('keeps later stabilization times when a middle sample is unreadable', async () => {
  decode.missing.add(1); const { ctx, target } = setup(); await run(ctx);
  expect(target.keyframes.x.map(k => k.t)).toEqual([0, 133333]);
});
it.each([{ missing: [0, 1, 2] }, { missing: [1, 2] }])('preserves motion when fewer than two samples can be decoded: %j', async ({ missing }) => {
  decode.missing = new Set(missing); const { ctx, store } = setup(); const before = JSON.stringify(store.projectForSave()); await run(ctx);
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
  expect(document.body.textContent).toContain('Could not read enough frames');
  decode.missing.clear(); await run(ctx); expect(store.history.undoStack).toHaveLength(1);
});
it('keeps complete-sample stabilization, undo/redo and reopening working', async () => {
  const { ctx, store, target } = setup(); const before = structuredClone(target.keyframes); await run(ctx);
  const after = structuredClone(target.keyframes); expect(after.x.map(k => k.t)).toEqual([0, 133333]);
  expect(after.scale).toBeUndefined(); expect(store.history.undoStack).toHaveLength(1);
  store.undo(); expect(mainTrack(store.project).clips[0].keyframes).toEqual(before);
  store.redo(); expect(mainTrack(normalizeProject(store.projectForSave())).clips[0].keyframes).toEqual(after);
});
