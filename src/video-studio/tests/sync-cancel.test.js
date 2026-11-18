import { it, expect, vi, afterEach } from 'vitest';
import { decodeClipSound } from '../src/media/audio-analysis.js';
import { mediabunnyOpener } from '../src/engine/audio-mix.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';
const decode = vi.hoisted(() => ({ phase: '', pause: null, constructed: vi.fn(), disposed: vi.fn(), returned: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class {
  constructor() { decode.constructed(); this.index = decode.constructed.mock.calls.length; }
  async getPrimaryAudioTrack() { if (decode.phase === 'track') await decode.pause(); return { index: this.index, sampleRate: 8000, canDecode: async () => { if (decode.phase === 'capability') await decode.pause(); return true; } }; }
  dispose() { decode.disposed(); }
}, AudioBufferSink: class {
  constructor(track) { this.index = track.index; }
  async *buffers() { try { if (decode.phase === 'frame') await decode.pause(); const data = Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i * .3) * (.15 + .1 * Math.sin(i / 350) + .05 * Math.cos(i / 141))); yield { buffer: { sampleRate: 8000, length: data.length, numberOfChannels: 1, getChannelData: () => data }, timestamp: 0 }; if (decode.phase === 'end' && this.index === 2) await decode.pause(); } finally { decode.returned(); } }
} }));
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); vi.restoreAllMocks(); decode.phase = ''; decode.pause = null; decode.constructed.mockClear(); decode.disposed.mockClear(); decode.returned.mockClear(); });
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const cancel = () => document.querySelector('dialog[open] .dialog-close').click();
function setup(mediaBlob = async () => new Blob()) {
  vi.spyOn(console, 'error').mockImplementation(() => {}); const p = fixture(), ref = clip('video', 0, 2), mov = clip('audio', 3, 2); onMain(p, ref); p.tracks.push(makeTrack('audio', { clips: [mov] })); const store = new EditorStore(p); store.select([ref.id, mov.id]);
  const ctx = { store, library: { mediaBlob } }; ctx.actions = createActions(ctx); return { ctx, store, mov: mov.id };
}
it.each([[1, 'resolve'], [1, 'reject'], [2, 'resolve'], [2, 'reject']])('settles cancellation of media read %s before late %s', async (which, how) => {
  let finish, count = 0, settled = false; const { ctx, store } = setup(async () => { if (++count !== which) return new Blob(); return new Promise((resolve, reject) => { finish = () => how === 'resolve' ? resolve(new Blob()) : reject(new Error('Obsolete sync read')); }); }); const before = JSON.stringify(store.projectForSave());
  const pending = ctx.actions.syncBySound().finally(() => { settled = true; }); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); cancel(); await flush(); const early = settled; finish(); await pending;
  expect(early).toBe(true); expect(decode.constructed).toHaveBeenCalledTimes(which - 1); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(console.error).not.toHaveBeenCalled();
});
it.each(['track', 'capability', 'frame', 'end'])('releases and settles canceled sync %s waits', async phase => {
  let finish, settled = false; decode.phase = phase; decode.pause = () => new Promise(r => { finish = r; }); const { ctx, store } = setup(), before = JSON.stringify(store.projectForSave()); const pending = ctx.actions.syncBySound().finally(() => { settled = true; });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); cancel(); await flush(); const early = { settled, closed: decode.disposed.mock.calls.length }; decode.phase = ''; finish(); await pending;
  expect(early).toEqual({ settled: true, closed: phase === 'end' ? 2 : 1 }); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(console.error).not.toHaveBeenCalled(); expect(document.querySelector('.toast.success')).toBeNull();
});
it('handles a late failed decoder after cancellation', async () => {
  let fail, settled = false; decode.phase = 'frame'; decode.pause = () => new Promise((_, reject) => { fail = reject; }); const { ctx } = setup(); const pending = ctx.actions.syncBySound().finally(() => { settled = true; });
  await vi.waitFor(() => expect(fail).toBeTypeOf('function')); cancel(); await flush(); const early = settled; fail(new Error('Obsolete decoder')); await pending;
  expect(early).toBe(true); expect(console.error).not.toHaveBeenCalled(); expect(decode.disposed).toHaveBeenCalledOnce();
});
it('rejects cancellation at final decoded progress', async () => {
  const ac = new AbortController(); await expect(decodeClipSound(mediabunnyOpener({ mediaBlob: async () => new Blob() }, { signal: ac.signal }), {}, clip('audio', 0, 1), { signal: ac.signal, onProgress: () => ac.abort() })).rejects.toMatchObject({ name: 'AbortError' }); expect(decode.disposed).toHaveBeenCalledOnce();
});
it('does not open already canceled sound decoding', async () => {
  const ac = new AbortController(); ac.abort(); const open = vi.fn(async () => null); await expect(decodeClipSound(open, {}, clip('audio', 0, 1), { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(open).not.toHaveBeenCalled();
});
it('closes an uncancelable source that arrives after cancellation without reading', async () => {
  let finish, settled = false; const ac = new AbortController(), src = { read: vi.fn(async function* () {}), close: vi.fn() }; const pending = decodeClipSound(() => new Promise(r => { finish = r; }), {}, clip('audio', 0, 1), { signal: ac.signal }).catch(e => e).finally(() => { settled = true; }); ac.abort(); await flush(); const early = settled; finish(src); const result = await pending; await flush();
  expect(early).toBe(true); expect(result.name).toBe('AbortError'); expect(src.read).not.toHaveBeenCalled(); expect(src.close).toHaveBeenCalledOnce();
});
it('still aligns matching sound with undo, redo, and reopening', async () => {
  const { ctx, store, mov } = setup(); await ctx.actions.syncBySound(); const start = p => p.tracks.flatMap(t => t.clips).find(c => c.id === mov).start;
  expect(start(store.project)).toBe(0); expect(store.history.undoStack).toHaveLength(1); store.undo(); expect(start(store.project)).toBe(3000000); store.redo(); expect(start(normalizeProject(store.projectForSave()))).toBe(0); expect(decode.disposed).toHaveBeenCalledTimes(2); expect(decode.returned).toHaveBeenCalledTimes(2);
});
