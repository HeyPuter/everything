import { it, expect, vi, afterEach } from 'vitest';
import { mixdown } from '../src/media/transcribe.js';
import { fixture, clip, onMain } from './helpers.js';
const decode = vi.hoisted(() => ({ phase: '', pause: null, constructed: vi.fn(), disposed: vi.fn(), returned: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class {
  constructor() { decode.constructed(); }
  async getPrimaryAudioTrack() { if (decode.phase === 'track') await decode.pause(); return { canDecode: async () => { if (decode.phase === 'capability') await decode.pause(); return true; } }; }
  dispose() { decode.disposed(); }
}, AudioBufferSink: class {
  async *buffers() { try { if (decode.phase === 'frame') await decode.pause(); const data = new Float32Array(32000); for (let i = 0; i < data.length; i++) if (i < 8000 || i >= 24000) data[i] = .5 * Math.sin(i * .3); yield { buffer: { sampleRate: 8000, length: data.length, numberOfChannels: 1, getChannelData: () => data }, timestamp: 0 }; if (decode.phase === 'end') await decode.pause(); } finally { decode.returned(); } }
} }));
afterEach(() => { decode.phase = ''; decode.pause = null; decode.constructed.mockClear(); decode.disposed.mockClear(); decode.returned.mockClear(); });
function setup() { const p = fixture(); onMain(p, clip('video', 0, 4)); return p; }
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
it.each(['resolve', 'reject'])('settles cancellation before a shared media read can %s', async how => {
  let finish, settled = false; const ac = new AbortController(), library = { mediaBlob: () => new Promise((resolve, reject) => { finish = () => how === 'resolve' ? resolve(new Blob()) : reject(new Error('Late read failed')); }) };
  const pending = mixdown(setup(), library, { signal: ac.signal }).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  ac.abort(); await flush(); const before = { settled, starts: decode.constructed.mock.calls.length }; finish(); const result = await pending;
  expect(before).toEqual({ settled: true, starts: 0 }); expect(result.error?.name).toBe('AbortError'); expect(decode.constructed).not.toHaveBeenCalled();
});
it.each(['track', 'capability', 'frame', 'end'])('disposes and settles a canceled %s wait before late completion', async phase => {
  let finish, settled = false; decode.phase = phase; decode.pause = () => new Promise(r => { finish = r; }); const ac = new AbortController();
  const pending = mixdown(setup(), { mediaBlob: async () => new Blob() }, { signal: ac.signal }).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); ac.abort(); await flush(); const before = { settled, disposed: decode.disposed.mock.calls.length }; decode.phase = ''; finish(); const result = await pending;
  expect(before).toEqual({ settled: true, disposed: 1 }); expect(result.error?.name).toBe('AbortError'); expect(decode.disposed).toHaveBeenCalledOnce();
});
it('handles a late decoder rejection after aborting its wait', async () => {
  let fail, settled = false; decode.phase = 'frame'; decode.pause = () => new Promise((_, reject) => { fail = reject; }); const ac = new AbortController();
  const pending = mixdown(setup(), { mediaBlob: async () => new Blob() }, { signal: ac.signal }).catch(error => error).finally(() => { settled = true; });
  await vi.waitFor(() => expect(fail).toBeTypeOf('function')); ac.abort(); await flush(); const before = settled; fail(new Error('Late decoder failed'));
  expect((await pending).name).toBe('AbortError'); expect(before).toBe(true); expect(decode.disposed).toHaveBeenCalledOnce();
});
it('does not start work for a pre-canceled mix', async () => {
  const ac = new AbortController(); ac.abort(); const library = { mediaBlob: vi.fn() };
  await expect(mixdown(setup(), library, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(library.mediaBlob).not.toHaveBeenCalled(); expect(decode.constructed).not.toHaveBeenCalled();
});
it('retains normalized speech and silence samples and closes normal decoding', async () => {
  const out = await mixdown(setup(), { mediaBlob: async () => new Blob() }, { sampleRate: 8000 });
  expect(out).toHaveLength(32000); expect(Math.max(...out)).toBeCloseTo(.9, 5); expect(out.slice(8000, 24000).every(x => x === 0)).toBe(true);
  expect(Math.abs(out[500])).toBeGreaterThan(.1); expect(Math.abs(out[30000])).toBeGreaterThan(.1); expect(decode.disposed).toHaveBeenCalledOnce(); expect(decode.returned).toHaveBeenCalledOnce();
});
