import { it, expect, vi, afterEach } from 'vitest';
import { openCropDialog } from '../src/ui/crop-dialog.js';
import { openCutoutRefine } from '../src/ui/cutout-refine.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { fixture, clip, onMain, s } from './helpers.js';
const disposed = vi.hoisted(() => vi.fn());
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [], BlobSource: class {},
  Input: class { async getPrimaryVideoTrack() { return { canDecode: async () => true }; } dispose() { disposed(); } },
  CanvasSink: class { async getCanvas(sec) { let frame = 0; while (frame < 59 && Math.round((frame + 1) / 30 * 1000) / 1000 <= sec) frame++; return { canvas: { frame } }; } },
}));
vi.mock('../src/media/segmenter.js', () => ({ SEG_SIZE: 2, ready: async () => true, segment: () => ({ width: 2, height: 2, data: new Uint8ClampedArray(4).fill(255) }), segmenterError: () => null }));
const cancel = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Cancel')?.click();
afterEach(async () => { cancel(); await new Promise(requestAnimationFrame); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); disposed.mockClear(); });
it.each([['crop', false], ['crop', true], ['cutout', false], ['cutout', true]])('shows the player frame in %s with freeze=%s', async (tool, freeze) => {
  vi.stubGlobal('ImageData', class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () { return { drawImage: src => { this.frame = src.frame; }, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, clearRect() {} }; });
  const p = fixture(), at = Math.round(8e6 / 30);
  const [c] = onMain(p, clip('video', 0, 2, { freeze, in: freeze ? at : 0 }));
  const store = new EditorStore(p); store.time = at; store.select(c.id);
  const ctx = { store, actions: {}, library: { mediaBlob: async () => new Blob(['video']) } };
  await (tool === 'crop' ? openCropDialog(ctx) : openCutoutRefine(ctx));
  const canvas = document.querySelector(tool === 'crop' ? '.crop-stage canvas' : '.refine-frame');
  expect(canvas).toBeTruthy();
  expect(canvas.frame).toBe(8);
  expect(disposed).toHaveBeenCalledOnce();
});

it.each(['crop', 'cutout'])('does not open stale %s media after the clip is replaced during loading', async tool => {
  vi.stubGlobal('ImageData', class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () { return { drawImage: src => { this.frame = src.frame; }, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, clearRect() {} }; });
  const p = fixture(); const [c] = onMain(p, clip('video', 0, 2)); const store = new EditorStore(p); store.select(c.id);
  let finish;
  const ctx = { store, library: { mediaBlob: () => new Promise(r => { finish = r; }) } }; ctx.actions = createActions(ctx);
  const pending = tool === 'crop' ? openCropDialog(ctx) : openCutoutRefine(ctx);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(ctx.actions.replaceClip(c.id, p.assets.silent)).toBe(true);
  finish(new Blob(['old video'])); await pending;
  expect(document.querySelector(tool === 'crop' ? '.crop-stage' : '.refine-stage')).toBeNull();
  expect(store.selected.clip.assetId).toBe('silent');
});

it.each(['crop', 'cutout'])('ignores a stale %s loading error but reports errors for current media', async tool => {
  const p = fixture(); const [c] = onMain(p, clip('video', 0, 2)); const store = new EditorStore(p); store.select(c.id);
  let fail;
  const ctx = { store, library: { mediaBlob: () => new Promise((_, reject) => { fail = reject; }) } }; ctx.actions = createActions(ctx);
  const open = tool === 'crop' ? openCropDialog : openCutoutRefine;
  const stale = open(ctx); await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
  ctx.actions.replaceClip(c.id, p.assets.silent); fail(new Error('Old source failed')); await stale;
  expect(document.body.textContent).not.toContain('Old source failed');
  const previous = fail, live = open(ctx); await vi.waitFor(() => expect(fail).not.toBe(previous)); fail(new Error('Current source failed')); await live;
  expect(document.body.textContent).toContain('Current source failed');
});

it.each(['before', 'during'])('does not refine a cutout locked %s loading', async when => {
  vi.stubGlobal('ImageData', class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {}, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, clearRect() {} });
  const p = fixture(); const [c] = onMain(p, clip('video', 0, 2)); const store = new EditorStore(p); store.select(c.id);
  let finish;
  const ctx = { store, library: { mediaBlob: vi.fn(() => when === 'before' ? Promise.resolve(new Blob()) : new Promise(r => { finish = r; })) } }; ctx.actions = createActions(ctx);
  if (when === 'before') p.tracks[0].locked = true;
  const pending = openCutoutRefine(ctx);
  if (when === 'during') { await vi.waitFor(() => expect(finish).toBeTypeOf('function')); store.update('Lock', p => { p.tracks[0].locked = true; }); finish(new Blob()); }
  await pending;
  expect(document.querySelector('.refine-stage')).toBeNull();
  if (when === 'before') expect(ctx.library.mediaBlob).not.toHaveBeenCalled();
});

it('keeps painted cutout work available if the track is locked before saving', async () => {
  vi.stubGlobal('ImageData', class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {}, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, clearRect() {} });
  const p = fixture(); const [c] = onMain(p, clip('video', 0, 2)); const store = new EditorStore(p); store.select(c.id);
  const ctx = { store, library: { mediaBlob: async () => new Blob() } }; ctx.actions = createActions(ctx);
  await openCutoutRefine(ctx);
  const stage = document.querySelector('.refine-stage');
  stage.querySelector('canvas').getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360 });
  stage.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 320, clientY: 180, button: 0 }));
  stage.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  store.update('Lock', p => { p.tracks[0].locked = true; });
  const done = [...document.querySelectorAll('button')].find(b => b.textContent === 'Done'); done.click();
  expect(document.querySelector('.refine-stage')).toBe(stage);
  expect(store.selected.clip.cutout).toBeUndefined();
  expect(document.body.textContent).toContain('could not be saved');
  store.update('Unlock', p => { p.tracks[0].locked = false; }); done.click();
  expect(document.querySelector('.refine-stage')).toBeNull();
  expect(store.selected.clip.cutout.strokes).toHaveLength(1);
  store.undo(); expect(store.selected.clip.cutout).toBeUndefined();
});

it.each(['crop', 'cutout'])('does not apply old %s work after media changes while the dialog is open', async tool => {
  vi.stubGlobal('ImageData', class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {}, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, clearRect() {} });
  const p = fixture(); const [c] = onMain(p, clip('video', 0, 2)); const store = new EditorStore(p); store.select(c.id);
  const ctx = { store, library: { mediaBlob: async () => new Blob() } }; ctx.actions = createActions(ctx);
  await (tool === 'crop' ? openCropDialog(ctx) : openCutoutRefine(ctx));
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent === text);
  if (tool === 'crop') button('1:1').click();
  else {
    const stage = document.querySelector('.refine-stage');
    stage.querySelector('canvas').getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360 });
    stage.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 320, clientY: 180, button: 0 }));
    stage.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  }
  ctx.actions.replaceClip(c.id, p.assets.silent);
  const before = JSON.stringify(store.projectForSave()), history = store.history.undoStack.length;
  button(tool === 'crop' ? 'Apply' : 'Done').click();
  expect(JSON.stringify(store.projectForSave())).toBe(before);
  expect(store.history.undoStack).toHaveLength(history);
  expect(document.body.textContent).toContain('media changed');
});
