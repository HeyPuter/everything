import { it, expect, vi, afterEach } from 'vitest';
import { openCropDialog } from '../src/ui/crop-dialog.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { evaluate } from '../src/engine/scene.js';
import { fixture, clip, onMain } from './helpers.js';

const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
afterEach(() => { button('Cancel')?.click(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['clip', 'asset', 'ordinary'])('crops a picture to the chosen ratio using %s framing', async source => {
  vi.stubGlobal('Image', class { naturalWidth = 72; naturalHeight = 42; async decode() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} });
  const p = fixture(), size = { width: 72, height: 40.5 };
  p.assets.img.width = 72; p.assets.img.height = 42;
  const [c] = onMain(p, clip('image', 0, 4));
  if (source === 'clip') { c.pictureSize = size; p.assets.img.pictureSize = { width: 72, height: 30 }; }
  else if (source === 'asset') p.assets.img.pictureSize = size;
  const store = new EditorStore(p), ctx = { store, library: { mediaURL: async () => 'blob:picture' } };
  ctx.actions = createActions(ctx); store.select(c.id);
  await openCropDialog(ctx);
  const canvas = document.querySelector('.crop-stage canvas');
  expect([canvas.dataset.srcW, canvas.dataset.srcH]).toEqual(['72', source === 'ordinary' ? '42' : '40.5']);
  button('1:1').click(); button('Apply').click();
  const layer = evaluate(store.project, 0)[0], crop = layer.crop;
  expect(layer.width * (1 - crop.l - crop.r) / (layer.height * (1 - crop.t - crop.b))).toBeCloseTo(1, 3);
  store.undo(); expect(evaluate(store.project, 0)[0].crop).toEqual({ l: 0, r: 0, t: 0, b: 0 });
  store.redo(); expect(evaluate(store.project, 0)[0].crop).toEqual(crop);
});
