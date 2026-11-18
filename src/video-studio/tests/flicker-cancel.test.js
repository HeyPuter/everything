import { it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { fixture, clip, onMain } from './helpers.js';

const decode = vi.hoisted(() => ({ pauseAt: '', pause: null, constructed: vi.fn(), disposed: vi.fn(), returned: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class {
  constructor() { decode.constructed(); }
  async getPrimaryVideoTrack() { if (decode.pauseAt === 'track') await decode.pause(); return { canDecode: async () => { if (decode.pauseAt === 'capability') await decode.pause(); return true; } }; }
  dispose() { decode.disposed(); }
}, CanvasSink: class {
  async *canvasesAtTimestamps(times) { try { let i = 0; for (const _ of times) { if (decode.pauseAt === 'frame') await decode.pause(); yield { canvas: { level: decode.pauseAt === 'steady' ? 130 : i++ % 2 ? 140 : 120 } }; } if (decode.pauseAt === 'end') await decode.pause(); } finally { decode.returned(); } }
} }));
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.body.replaceChildren(); vi.unstubAllGlobals(); decode.pauseAt = ''; decode.pause = null; decode.constructed.mockClear(); decode.disposed.mockClear(); decode.returned.mockClear(); });
function setup(mediaBlob = async () => new Blob()) {
  vi.stubGlobal('OffscreenCanvas', class { getContext() { let level = 0; return { drawImage(c) { level = c.level; }, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(level) }) }; } });
  const p = fixture(); const [target] = onMain(p, clip('video', 0, .8)); target.keyframes.x = [{ t: 0, v: .1 }]; target.keyframes.scale = [{ t: 0, v: 1.2 }];
  const store = new EditorStore(p); store.select(target.id); const ctx = { store, library: { mediaBlob } }; ctx.actions = createActions(ctx); return { ctx, store };
}
async function start(ctx) { await ctx.actions.removeFlicker(); [...document.querySelectorAll('button')].find(b => b.textContent === 'Remove flicker').click(); }
const cancel = () => document.querySelector('dialog[open] .dialog-close').click();
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
it('does not start a decoder after cancellation during a media read', async () => {
  let finish; const { ctx, store } = setup(() => new Promise(r => { finish = r; })); const before = JSON.stringify(store.projectForSave());
  await start(ctx); cancel(); finish(new Blob()); await flush();
  expect(decode.constructed).not.toHaveBeenCalled(); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
});
it('suppresses a late read failure after cancellation', async () => {
  let fail; const { ctx } = setup(() => new Promise((_, reject) => { fail = reject; }));
  await start(ctx); cancel(); fail(new Error('Canceled file read failed')); await flush();
  expect(document.body.textContent).not.toContain('Canceled file read failed');
});
it('does not save flicker removal when canceled while the sampler finishes', async () => {
  let finish; decode.pauseAt = 'end'; decode.pause = () => new Promise(r => { finish = r; });
  const { ctx, store } = setup(); const before = JSON.stringify(store.projectForSave()); await start(ctx);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); cancel(); finish(); await flush();
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
  expect(document.body.textContent).not.toContain('Flicker reduced');
});
it('releases a decoder immediately when canceled during a pending frame', async () => {
  let finish; decode.pauseAt = 'frame'; decode.pause = () => new Promise(r => { finish = r; });
  const { ctx } = setup(); await start(ctx); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); cancel(); await flush();
  try { expect(decode.disposed).toHaveBeenCalledOnce(); }
  finally { decode.pauseAt = ''; finish(); await flush(); }
  expect(decode.returned).toHaveBeenCalledOnce();
});
it.each(['track', 'capability', 'frame'])('settles canceled RGBA reads during %s and disposes their decoder', async phase => {
  setup(); const { rgbaFrames } = await import('../src/media/frame-sampler.js');
  let fail; decode.pauseAt = phase; decode.pause = () => new Promise((_, reject) => { fail = reject; });
  const ac = new AbortController(); let settled = false;
  const read = rgbaFrames(new Blob(), [0], { width: 2, height: 2, signal: ac.signal });
  const pending = read.next().then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  await vi.waitFor(() => expect(fail).toBeTypeOf('function')); ac.abort(); await flush();
  try { expect(settled).toBe(true); expect(decode.disposed).toHaveBeenCalledOnce(); }
  finally { fail(new Error('Late decoder error')); await flush(); }
  expect((await pending).error?.name).toBe('AbortError');
});
it('does not construct a RGBA decoder for an already canceled request', async () => {
  const { rgbaFrames } = await import('../src/media/frame-sampler.js'); const ac = new AbortController(); ac.abort();
  await expect(rgbaFrames(new Blob(), [0], { signal: ac.signal }).next()).rejects.toMatchObject({ name: 'AbortError' });
  expect(decode.constructed).not.toHaveBeenCalled();
});
it('closes the sampler and decoder when a consumer stops reading early', async () => {
  setup(); const { rgbaFrames } = await import('../src/media/frame-sampler.js');
  for await (const _ of rgbaFrames(new Blob(), [0, 66667], { width: 2, height: 2 })) break;
  expect(decode.disposed).toHaveBeenCalledOnce(); expect(decode.returned).toHaveBeenCalledOnce();
});
it('still reports failures from a current, uncanceled media read', async () => {
  const { ctx, store } = setup(async () => { throw new Error('Current flicker read failed'); });
  await start(ctx); await flush(); expect(document.body.textContent).toContain('Current flicker read failed');
  expect(document.querySelector('dialog[open]')).toBeNull(); expect(store.history.undoStack).toHaveLength(0);
});
it('leaves a steady clip unchanged and reports that no correction is needed', async () => {
  decode.pauseAt = 'steady'; const { ctx, store } = setup(); const before = JSON.stringify(store.projectForSave()); await start(ctx);
  await vi.waitFor(() => expect(document.querySelector('dialog[open]')).toBeNull());
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
  expect(document.body.textContent).toContain('No flicker was found');
});
