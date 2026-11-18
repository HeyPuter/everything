import { it, expect, vi, afterEach } from 'vitest';
import { openCropDialog } from '../src/ui/crop-dialog.js';
import { openCutoutRefine } from '../src/ui/cutout-refine.js';
import { openTrackingDialog } from '../src/ui/tracking-dialog.js';
import { Editor } from '../src/ui/editor.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { addClip } from '../src/model/timeline.js';
import { fixture, clip, onMain } from './helpers.js';
const decode = vi.hoisted(() => ({ frame: null, read: vi.fn(), dispose: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class { async getPrimaryVideoTrack() { return { canDecode: async () => true }; } dispose() { decode.dispose(); } }, CanvasSink: class { async getCanvas() { decode.read(); return decode.frame || { canvas: {} }; } } }));
vi.mock('../src/media/segmenter.js', () => ({ SEG_SIZE: 2, ready: async () => true, segment: () => ({ width: 2, height: 2, data: new Uint8ClampedArray(4).fill(255) }), segmenterError: () => null, segmenterState: () => 'ready', onSegmenterChange: () => () => {} }));
const tools = { crop: openCropDialog, cutout: openCutoutRefine, tracking: openTrackingDialog };
const tracking = vi.hoisted(() => ({ finish: null }));
vi.mock('../src/media/tracker.js', async original => ({ ...await original(), grayFrames: async function* () { await new Promise(r => { tracking.finish = r; }); } }));
const owners = [];
const dispose = owner => Editor.prototype.dispose.call(owner);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(async () => { owners.splice(0).forEach(dispose); document.querySelectorAll('.dialog-close').forEach(b => b.click()); await new Promise(requestAnimationFrame); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); decode.frame = null; decode.read.mockClear(); decode.dispose.mockClear(); });
function setup(tool, mediaBlob) {
  vi.stubGlobal('ImageData', class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {}, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, clearRect() {} });
  const p = fixture(); const [video] = onMain(p, clip('video', 0, 2)); let target = video;
  if (tool === 'tracking') { target = clip('text', 0, 2); addClip(p, target, { main: false }); }
  const store = new EditorStore(p); store.select(target.id);
  const ctx = { store, actions: {}, library: { mediaBlob: vi.fn(mediaBlob), releaseMedia() {} } };
  const owner = { ctx, library: ctx.library, _cancelCover() {}, saver: { dispose() {} }, proxies: { dispose() {} }, media: { dispose() {} } }; ctx.editor = owner; ctx.actions = createActions(ctx); owners.push(owner);
  return ctx;
}
it.each(Object.keys(tools))('does not open late %s after the editor is disposed', async tool => {
  let finish;
  const ctx = setup(tool, () => new Promise(r => { finish = r; }));
  const pending = tools[tool](ctx); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  dispose(ctx.editor); finish(new Blob()); await pending;
  expect(document.querySelector('dialog[open]')).toBeNull();
  expect(document.documentElement.classList.contains('opening-dialog')).toBe(false);
});
it.each(Object.keys(tools))('lets a new editor open %s while the old media read is pending', async tool => {
  let finish;
  const old = setup(tool, () => new Promise(r => { finish = r; }));
  const pending = tools[tool](old); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); dispose(old.editor);
  const fresh = setup(tool, async () => new Blob()), next = tools[tool](fresh);
  try { await flush(); expect(fresh.library.mediaBlob).toHaveBeenCalledOnce(); }
  finally { finish(new Blob()); await Promise.all([pending, next]); }
});

it.each(Object.keys(tools))('closes open %s on disposal and refuses to reopen it', async tool => {
  const ctx = setup(tool, async () => new Blob()); await tools[tool](ctx);
  expect(document.querySelector('dialog[open]')).toBeTruthy();
  dispose(ctx.editor); expect(document.querySelector('dialog[open]')).toBeNull();
  await tools[tool](ctx); expect(ctx.library.mediaBlob).toHaveBeenCalledOnce();
});
it.each(Object.keys(tools))('releases the %s opener immediately and ignores a late read failure', async tool => {
  let fail;
  const ctx = setup(tool, () => new Promise((_, reject) => { fail = reject; }));
  const pending = tools[tool](ctx); await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
  dispose(ctx.editor); await pending;
  expect(document.documentElement.classList.contains('opening-dialog')).toBe(false);
  fail(new Error('Obsolete frame failed')); await flush();
  expect(document.body.textContent).not.toContain('Obsolete frame failed');
});
it.each(Object.keys(tools))('disposes the %s video decoder during a pending frame decode', async tool => {
  let finish; decode.frame = new Promise(r => { finish = r; });
  const ctx = setup(tool, async () => new Blob()); const pending = tools[tool](ctx);
  await vi.waitFor(() => expect(decode.read).toHaveBeenCalled());
  dispose(ctx.editor); await pending; await flush();
  expect(decode.dispose).toHaveBeenCalledOnce();
  finish({ canvas: {} }); await flush();
  expect(document.querySelector('dialog[open]')).toBeNull();
});
it('closes a cutout bitmap that arrives after disposal', async () => {
  let finish; const bitmap = { close: vi.fn() };
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(r => { finish = r; })));
  const ctx = setup('cutout', async () => new Blob()); Object.assign(ctx.store.selected.clip, { type: 'image', assetId: 'img' });
  const pending = openCutoutRefine(ctx); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  dispose(ctx.editor); await pending; finish(bitmap); await flush();
  expect(bitmap.close).toHaveBeenCalledOnce(); expect(document.querySelector('dialog[open]')).toBeNull();
});
it('abandons an image crop decode when its editor leaves', async () => {
  let finish;
  vi.stubGlobal('Image', class { naturalWidth = 640; naturalHeight = 360; decode() { return new Promise(r => { finish = r; }); } });
  const ctx = setup('crop', async () => new Blob()); Object.assign(ctx.store.selected.clip, { type: 'image', assetId: 'img' }); ctx.library.mediaURL = async () => 'blob:picture';
  const pending = openCropDialog(ctx); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  dispose(ctx.editor); await pending; finish(); await flush();
  expect(document.querySelector('dialog[open]')).toBeNull();
});

it('does not apply tracking results after the editor closes during analysis', async () => {
  const ctx = setup('tracking', async () => new Blob()); await openTrackingDialog(ctx);
  const canvas = document.querySelector('.track-frame'); canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 768, height: 432 });
  const stage = document.querySelector('.track-stage');
  stage.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
  stage.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200, clientY: 200 }));
  stage.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  const before = JSON.stringify(ctx.store.projectForSave());
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Track').click();
  await vi.waitFor(() => expect(tracking.finish).toBeTypeOf('function'));
  dispose(ctx.editor); tracking.finish(); await flush();
  expect(JSON.stringify(ctx.store.projectForSave())).toBe(before);
  expect(ctx.store.history.undoStack).toHaveLength(0);
});
