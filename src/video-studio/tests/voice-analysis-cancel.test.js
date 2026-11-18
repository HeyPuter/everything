import { it, expect, vi, afterEach } from 'vitest';
import { analyzeVoiceAsset } from '../src/ui/avatar-actions.js';
import { lyricsFromClip } from '../src/media/lyrics.js';
import { fixture, clip } from './helpers.js';
import { makeTrack } from '../src/model/project.js';
const decode = vi.hoisted(() => ({ phase: '', pause: null, constructed: vi.fn(), disposed: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class {
  constructor() { decode.constructed(); }
  async getPrimaryAudioTrack() {
    if (decode.phase === 'track') await decode.pause();
    return { sampleRate: 8000, canDecode: async () => { if (decode.phase === 'capability') await decode.pause(); return true; } };
  }
  dispose() { decode.disposed(); }
}, AudioBufferSink: class {
  async *buffers() {
    if (decode.phase === 'frame') await decode.pause();
    const data = Float32Array.from({ length: 8000 }, (_, i) => .2 * Math.sin(i * .3) * (.6 + .4 * Math.sin(i / 350)));
    yield { buffer: { sampleRate: 8000, length: data.length, numberOfChannels: 1, getChannelData: () => data }, timestamp: 0 };
    if (decode.phase === 'end') await decode.pause();
  }
} }));
afterEach(() => { decode.phase = ''; decode.pause = null; decode.constructed.mockClear(); decode.disposed.mockClear(); vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function setup(kind, mediaBlob = async () => new Blob()) {
  const p = fixture(), c = clip('audio', 0, 2); p.tracks.push(makeTrack('audio', { clips: [c] })); p.assets.aud.duration = 2000000;
  const ac = new AbortController(), transcribe = vi.fn(async () => [{ text: 'Hello', start: .1, end: .4 }]);
  const run = () => kind === 'avatar' ? analyzeVoiceAsset({ mediaBlob }, p.assets.aud, { signal: ac.signal })
    : lyricsFromClip(p, c.id, { library: { mediaBlob }, signal: ac.signal, isolate: false, transcribe, beats: () => null });
  return { ac, run, transcribe };
}
for (const kind of ['avatar', 'lyrics']) {
  it.each(['resolve', 'reject'])(`${kind} cancellation prevents late decoder startup after media %s`, async how => {
    let finish, settled = false;
    const x = setup(kind, () => new Promise((r, j) => { finish = () => how === 'resolve' ? r(new Blob()) : j(new Error('Obsolete file')); }));
    const pending = x.run().catch(e => e).finally(() => { settled = true; });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    x.ac.abort(); await flush(); const early = settled; finish(); const result = await pending; await flush();
    expect(early).toBe(true); expect(result.name).toBe('AbortError'); expect(decode.constructed).not.toHaveBeenCalled(); expect(x.transcribe).not.toHaveBeenCalled();
  });
  it.each(['track', 'capability', 'frame', 'end'])(`${kind} cancellation releases the decoder during %s waits`, async phase => {
    let finish, settled = false; decode.phase = phase; decode.pause = () => new Promise(r => { finish = r; });
    const x = setup(kind), pending = x.run().catch(e => e).finally(() => { settled = true; });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    x.ac.abort(); await flush(); const early = { settled, closed: decode.disposed.mock.calls.length };
    decode.phase = ''; finish(); const result = await pending; await flush();
    expect(early).toEqual({ settled: true, closed: 1 }); expect(result.name).toBe('AbortError'); expect(decode.disposed).toHaveBeenCalledOnce(); expect(x.transcribe).not.toHaveBeenCalled();
  });
  it(`${kind} skips an already canceled media request`, async () => {
    const mediaBlob = vi.fn(), x = setup(kind, mediaBlob); x.ac.abort(); await expect(x.run()).rejects.toMatchObject({ name: 'AbortError' });
    expect(mediaBlob).not.toHaveBeenCalled(); expect(decode.constructed).not.toHaveBeenCalled();
  });
  it(`${kind} reports a current media failure`, async () => {
    const x = setup(kind, async () => { throw new Error('Current file failed'); }); await expect(x.run()).rejects.toThrow('Current file failed');
  });
  it(`${kind} retains normal analysis after a canceled attempt`, async () => {
    const canceled = setup(kind); canceled.ac.abort(); await expect(canceled.run()).rejects.toMatchObject({ name: 'AbortError' });
    const x = setup(kind), result = await x.run();
    if (kind === 'avatar') { expect(result.rate).toBe(50); expect(result.data.length).toBeGreaterThan(0); }
    else { expect(result.cues).toHaveLength(1); expect(result.cues[0].text).toBe('Hello'); expect(x.transcribe).toHaveBeenCalledOnce(); }
    expect(decode.constructed).toHaveBeenCalledOnce(); expect(decode.disposed).toHaveBeenCalledOnce();
  });
}
