import { it, expect, vi, afterEach } from 'vitest';
import { openCropDialog } from '../src/ui/crop-dialog.js';
import { openCutoutRefine } from '../src/ui/cutout-refine.js';
import { EditorStore } from '../src/model/store.js';
import { fixture, clip, onMain, s } from './helpers.js';
const disposed = vi.hoisted(() => vi.fn());
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [], BlobSource: class {},
  Input: class { async getPrimaryVideoTrack() { return { canDecode: async () => true }; } dispose() { disposed(); } },
  CanvasSink: class { async getCanvas(sec) { let frame = 0; while (frame < 59 && Math.round((frame + 1) / 30 * 1000) / 1000 <= sec) frame++; return { canvas: { frame } }; } },
}));
vi.mock('../src/media/segmenter.js', () => ({ SEG_SIZE: 2, ready: async () => true, segment: () => ({ width: 2, height: 2, data: new Uint8ClampedArray(4).fill(255) }), segmenterError: () => null }));
const cancel = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Cancel')?.click();
afterEach(() => { cancel(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); disposed.mockClear(); });
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
