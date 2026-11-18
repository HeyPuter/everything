import { it, expect, vi, afterEach } from 'vitest';
import { extractClipAudio } from '../src/media/extract-audio.js';
import { mediabunnyOpener } from '../src/engine/audio-mix.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { fixture, clip, onMain } from './helpers.js';
const decode = vi.hoisted(() => ({ phase: '', pause: null, constructed: vi.fn(), disposed: vi.fn(), returned: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class {
  constructor() { decode.constructed(); }
  async getPrimaryAudioTrack() { if (decode.phase === 'track') await decode.pause(); return { sampleRate: 8000, canDecode: async () => { if (decode.phase === 'capability') await decode.pause(); return true; } }; }
  dispose() { decode.disposed(); }
}, AudioBufferSink: class {
  async *buffers() { try { if (decode.phase === 'frame') await decode.pause(); yield { buffer: { sampleRate: 8000, length: 8000, numberOfChannels: 1, getChannelData: () => new Float32Array(8000).fill(.25) }, timestamp: 0 }; if (decode.phase === 'end') await decode.pause(); } finally { decode.returned(); } }
} }));
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); vi.restoreAllMocks(); decode.phase = ''; decode.pause = null; decode.constructed.mockClear(); decode.disposed.mockClear(); decode.returned.mockClear(); });
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const cancel = () => document.querySelector('dialog[open] .dialog-close').click();
function setup(mediaBlob = async () => new Blob()) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const p = fixture(), c = clip('video', 0, 2); onMain(p, c); const store = new EditorStore(p); store.select(c.id);
  const ctx = { store, library: { mediaBlob } }; ctx.actions = createActions(ctx); ctx.actions.importFiles = vi.fn(async () => [{ name: 'Extracted.wav' }]); return { ctx, store };
}
it.each(['resolve', 'reject'])('settles extraction before a canceled media read can %s', async how => {
  let finish, settled = false; const { ctx, store } = setup(() => new Promise((resolve, reject) => { finish = () => how === 'resolve' ? resolve(new Blob()) : reject(new Error('Obsolete extraction read')); })); const before = JSON.stringify(store.projectForSave());
  const pending = ctx.actions.extractAudio().finally(() => { settled = true; }); cancel(); await flush(); const early = settled; finish(); await pending;
  expect(early).toBe(true); expect(decode.constructed).not.toHaveBeenCalled(); expect(ctx.actions.importFiles).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled(); expect(JSON.stringify(store.projectForSave())).toBe(before);
});
it.each(['track', 'capability', 'frame', 'end'])('releases the decoder and settles canceled %s waits before late completion', async phase => {
  let finish, settled = false; decode.phase = phase; decode.pause = () => new Promise(r => { finish = r; }); const { ctx } = setup(); const pending = ctx.actions.extractAudio().finally(() => { settled = true; });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); cancel(); await flush(); const early = { settled, closed: decode.disposed.mock.calls.length }; decode.phase = ''; finish(); await pending;
  expect(early).toEqual({ settled: true, closed: 1 }); expect(ctx.actions.importFiles).not.toHaveBeenCalled(); expect(decode.disposed).toHaveBeenCalledOnce(); expect(console.error).not.toHaveBeenCalled();
});
it('handles a late rejected decoder read after canceling', async () => {
  let fail, settled = false; decode.phase = 'frame'; decode.pause = () => new Promise((_, reject) => { fail = reject; }); const { ctx } = setup(); const pending = ctx.actions.extractAudio().finally(() => { settled = true; });
  await vi.waitFor(() => expect(fail).toBeTypeOf('function')); cancel(); await flush(); const early = settled; fail(new Error('Obsolete decoder failure')); await pending;
  expect(early).toBe(true); expect(ctx.actions.importFiles).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled(); expect(decode.disposed).toHaveBeenCalledOnce();
});
it('rejects cancellation at the final progress callback instead of returning a WAV', async () => {
  const ac = new AbortController(), c = clip('video', 0, 1);
  await expect(extractClipAudio(mediabunnyOpener({ mediaBlob: async () => new Blob() }, { signal: ac.signal }), { id: 'vid' }, c, { signal: ac.signal, onProgress: () => ac.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  expect(decode.disposed).toHaveBeenCalledOnce();
});
it('does not open an already canceled extraction', async () => {
  const ac = new AbortController(); ac.abort(); const open = vi.fn(async () => null);
  await expect(extractClipAudio(open, { id: 'vid' }, clip('video', 0, 1), { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(open).not.toHaveBeenCalled();
});
it('closes a source supplied by an uncancelable opener after cancellation', async () => {
  let finish, settled = false; const ac = new AbortController(), src = { read: vi.fn(async function* () {}), close: vi.fn() };
  const pending = extractClipAudio(() => new Promise(r => { finish = r; }), { id: 'vid' }, clip('video', 0, 1), { signal: ac.signal }).catch(error => error).finally(() => { settled = true; });
  ac.abort(); await flush(); const early = settled; finish(src); const result = await pending; await flush(); expect(early).toBe(true); expect(result.name).toBe('AbortError'); expect(src.read).not.toHaveBeenCalled(); expect(src.close).toHaveBeenCalledOnce();
});
it('imports a normal extraction and closes its decoder', async () => {
  const { ctx } = setup(); const result = await ctx.actions.extractAudio(); expect(result.name).toBe('Extracted.wav'); expect(ctx.actions.importFiles).toHaveBeenCalledOnce(); const file = ctx.actions.importFiles.mock.calls[0][0][0]; expect(file.type).toBe('audio/wav'); expect(file.size).toBe(16044); expect(decode.disposed).toHaveBeenCalledOnce(); expect(decode.returned).toHaveBeenCalledOnce();
});
