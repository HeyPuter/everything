import { it, expect, vi, afterEach } from 'vitest';
import { Editor } from '../src/ui/editor.js';
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
const owners = [], dispose = owner => Editor.prototype.dispose.call(owner);
afterEach(() => { owners.splice(0).forEach(dispose); document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); vi.restoreAllMocks(); decode.phase = ''; decode.pause = null; decode.constructed.mockClear(); decode.disposed.mockClear(); decode.returned.mockClear(); });
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function setup(mediaBlob = async () => new Blob()) {
  vi.spyOn(console, 'error').mockImplementation(() => {}); const p = fixture(), ref = clip('video', 0, 2), mov = clip('video', 3, 2); onMain(p, ref); p.tracks.push(makeTrack('video', { clips: [mov] })); const store = new EditorStore(p); store.select([ref.id, mov.id]);
  const library = { mediaBlob: vi.fn(mediaBlob), releaseMedia() {} }, ctx = { store, library };
  const owner = { ctx, library, _cancelCover() {}, saver: { dispose() {} }, proxies: { dispose() {} }, media: { dispose() {} } }; ctx.editor = owner; ctx.actions = createActions(ctx); owners.push(owner); return { ctx, store, owner, mov: mov.id };
}
it('does not start multi-camera creation after editor disposal', async () => {
  const { ctx, store, owner } = setup(); dispose(owner); await ctx.actions.createMulticam(); expect(ctx.library.mediaBlob).not.toHaveBeenCalled(); expect(decode.constructed).not.toHaveBeenCalled(); expect(store.history.undoStack).toHaveLength(0); expect(document.querySelector('dialog[open]')).toBeNull();
});
it.each(['resolve', 'reject'])('closes and settles sync before a disposed editor read can %s', async how => {
  let finish, settled = false, reads = 0; const { ctx, store, owner } = setup(() => ++reads > 1 ? Promise.resolve(new Blob()) : new Promise((resolve, reject) => { finish = () => how === 'resolve' ? resolve(new Blob()) : reject(new Error('Obsolete editor read')); })); const before = JSON.stringify(store.projectForSave()), pending = ctx.actions.createMulticam().finally(() => { settled = true; });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); dispose(owner); await flush(); const early = { settled, closed: !document.querySelector('dialog[open]') }; finish(); await pending;
  expect(early).toEqual({ settled: true, closed: true }); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(decode.constructed).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled(); expect(document.querySelector('.toast.success')).toBeNull();
});
it('releases active multi-camera decoding and discards its final result after disposal', async () => {
  let finish, settled = false; decode.phase = 'end'; decode.pause = () => new Promise(r => { finish = r; }); const { ctx, store, owner } = setup(), before = JSON.stringify(store.projectForSave()); const pending = ctx.actions.createMulticam().finally(() => { settled = true; });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); dispose(owner); await flush(); const early = { settled, closed: decode.disposed.mock.calls.length, dialogs: document.querySelectorAll('dialog[open]').length }; decode.phase = ''; finish(); await pending;
  expect(early).toEqual({ settled: true, closed: 2, dialogs: 0 }); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.success')).toBeNull();
});
it('lets a new editor create a multicam while an old editor read remains pending', async () => {
  let fail; const old = setup(() => new Promise((_, reject) => { fail = reject; })), pending = old.ctx.actions.createMulticam(); await vi.waitFor(() => expect(fail).toBeTypeOf('function')); dispose(old.owner);
  const fresh = setup(); await fresh.ctx.actions.createMulticam(); const noDialogs = !document.querySelector('dialog[open]'); fail(new Error('Obsolete old sync')); await pending;
  expect(noDialogs).toBe(true); expect(old.store.history.undoStack).toHaveLength(0); expect(fresh.store.history.undoStack).toHaveLength(1); const angles = p => p.tracks.flatMap(t => t.clips).find(c => c.multicam)?.sequence.tracks.map(t => t.clips[0].start);
  expect(angles(fresh.store.project)).toEqual([0, 0]); fresh.store.undo(); expect(fresh.store.project.tracks.flatMap(t => t.clips)).toHaveLength(2); fresh.store.redo(); expect(angles(normalizeProject(fresh.store.projectForSave()))).toEqual([0, 0]); expect(console.error).not.toHaveBeenCalled();
});
it('does not create a multicam if closing progress returns focus to an editor that leaves', async () => {
  const { ctx, store, owner } = setup(), before = JSON.stringify(store.projectForSave());
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const pending = ctx.actions.createMulticam();
  opener.addEventListener('focus', () => dispose(owner), { once: true });
  await pending;
  expect(owner._disposed).toBe(true);
  expect(JSON.stringify(store.projectForSave())).toBe(before);
  expect(store.history.undoStack).toHaveLength(0);
  expect(document.querySelector('.toast.success')).toBeNull();
});
