import { it, expect, vi, afterEach } from 'vitest';
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
  vi.spyOn(console, 'error').mockImplementation(() => {}); const p = fixture(), ref = clip('video', 0, 2), mov = clip('video', 3, 2); onMain(p, ref); p.tracks.push(makeTrack('video', { clips: [mov] })); const store = new EditorStore(p); store.select([ref.id, mov.id]);
  const ctx = { store, library: { mediaBlob } }; ctx.actions = createActions(ctx); return { ctx, store, mov: mov.id };
}
it.each([[1, 'resolve'], [1, 'reject'], [2, 'resolve'], [2, 'reject']])('settles cancellation of multicam read %s before a late %s without opening another decoder', async (which, how) => {
  let finish, count = 0, settled = false;
  const { ctx, store } = setup(async () => {
    if (++count !== which) return new Blob();
    return new Promise((resolve, reject) => { finish = () => how === 'resolve' ? resolve(new Blob()) : reject(new Error('Obsolete camera read')); });
  });
  const before = JSON.stringify(store.projectForSave());
  const pending = ctx.actions.createMulticam().finally(() => { settled = true; });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  cancel(); await flush(); const early = settled;
  finish(); const made = await pending; await flush();
  expect(early).toBe(true); expect(made).toBeNull();
  expect(decode.constructed).toHaveBeenCalledTimes(which - 1);
  expect(JSON.stringify(store.projectForSave())).toBe(before);
  expect(store.history.undoStack).toHaveLength(0);
  expect(console.error).not.toHaveBeenCalled();
});
it.each(['track', 'capability', 'frame', 'end'])('releases canceled multicam %s waits promptly', async phase => {
  let finish, settled = false; decode.phase = phase; decode.pause = () => new Promise(r => { finish = r; });
  const { ctx, store } = setup(), before = JSON.stringify(store.projectForSave());
  const pending = ctx.actions.createMulticam().finally(() => { settled = true; });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  cancel(); await flush(); const early = { settled, closed: decode.disposed.mock.calls.length };
  decode.phase = ''; finish(); await pending;
  expect(early).toEqual({ settled: true, closed: phase === 'end' ? 2 : 1 });
  expect(JSON.stringify(store.projectForSave())).toBe(before);
  expect(store.history.undoStack).toHaveLength(0);
  expect(document.querySelector('.toast.success')).toBeNull();
});
it('does not create a multicam after cancellation during the final comparison repaint', async () => {
  const { ctx, store } = setup(), before = JSON.stringify(store.projectForSave()), timer = globalThis.setTimeout;
  let canceled = false;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay, ...args) => {
    if (delay === 0 && document.querySelector('dialog[open]')) { canceled = true; cancel(); }
    return timer(fn, delay, ...args);
  });
  const made = await ctx.actions.createMulticam();
  expect(canceled).toBe(true); expect(made).toBeNull();
  expect(JSON.stringify(store.projectForSave())).toBe(before);
  expect(store.history.undoStack).toHaveLength(0);
  expect(document.querySelector('.toast.success')).toBeNull();
});
it('honors immediate cancellation when none of the cameras has usable audio', async () => {
  const { ctx, store } = setup(); store.project.assets.vid.hasAudio = false;
  const before = JSON.stringify(store.projectForSave()), pending = ctx.actions.createMulticam();
  cancel(); expect(await pending).toBeNull();
  expect(JSON.stringify(store.projectForSave())).toBe(before);
  expect(store.history.undoStack).toHaveLength(0);
});
it('still creates aligned angles with undo, redo, and reopening', async () => {
  const { ctx, store } = setup(), made = await ctx.actions.createMulticam();
  expect(made?.multicam).toBeTruthy();
  expect(made.sequence.tracks.map(t => t.clips[0].start)).toEqual([0, 0]);
  expect(store.history.undoStack).toHaveLength(1);
  store.undo(); expect(store.project.tracks.flatMap(t => t.clips)).toHaveLength(2);
  store.redo(); const reopened = normalizeProject(store.projectForSave());
  expect(reopened.tracks.flatMap(t => t.clips).find(c => c.multicam)?.sequence.tracks.map(t => t.clips[0].start)).toEqual([0, 0]);
  expect(decode.disposed).toHaveBeenCalledTimes(2);
});
it('keeps the unsynced fallback available for a real audio-read failure', async () => {
  const { ctx, store } = setup(async () => { throw new Error('Unreadable recording'); });
  const made = await ctx.actions.createMulticam();
  expect(made?.multicam).toBeTruthy();
  expect(made.sequence.tracks.map(t => t.clips[0].start)).toEqual([0, 3000000]);
  expect(store.history.undoStack).toHaveLength(1);
  expect(document.body.textContent).toContain('keep their timeline positions');
});
