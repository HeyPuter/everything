import { it, expect, vi, afterEach } from 'vitest';
import { openTrackingDialog } from '../src/ui/tracking-dialog.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { addClip } from '../src/model/timeline.js';
import { fixture, clip, onMain } from './helpers.js';

const decode = vi.hoisted(() => ({ missing: new Set(), dispose: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class { async getPrimaryVideoTrack() { return { canDecode: async () => true }; } dispose() { decode.dispose(); } }, CanvasSink: class {
  async getCanvas() { return { canvas: {} }; }
  async *canvasesAtTimestamps(times) { for (let i = 0; i < times.length; i++) yield decode.missing.has(i) ? null : { canvas: {} }; }
} }));
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); decode.missing.clear(); decode.dispose.mockClear(); });
function setup(reversed = false) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} });
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return { drawImage() {}, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(127) }) }; } });
  const p = fixture(); onMain(p, clip('video', 0, .2, { reversed }));
  const target = clip('text', 0, .2); addClip(p, target, { main: false }); target.keyframes.x = [{ t: 0, v: .1 }];
  const store = new EditorStore(p); store.select(target.id);
  const ctx = { store, library: { mediaBlob: async () => new Blob() } }; ctx.actions = createActions(ctx);
  return { ctx, store, target };
}
async function start(ctx) {
  await openTrackingDialog(ctx);
  const canvas = document.querySelector('.track-frame'); canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 768, height: 432 });
  const stage = document.querySelector('.track-stage');
  stage.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
  stage.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 160, clientY: 160 }));
  stage.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  const go = document.querySelector('.track-dialog .btn.primary'); go.click();
  await vi.waitFor(() => expect(go.disabled).toBe(false));
}
it.each([false, true])('keeps sample times when a leading frame cannot be read (reverse=%s)', async reversed => {
  decode.missing.add(0); const { ctx, target } = setup(reversed); await start(ctx);
  expect(target.keyframes.x.map(k => k.t)).toEqual([66667, 133333]);
  expect(target.keyframes.y.map(k => k.t)).toEqual([66667, 133333]);
  expect(decode.dispose).toHaveBeenCalledTimes(2);
});
it('keeps later sample times when a middle frame cannot be read', async () => {
  decode.missing.add(1); const { ctx, target } = setup(); await start(ctx);
  expect(target.keyframes.x.map(k => k.t)).toEqual([0, 133333]);
});
it('keeps existing motion and offers retry when no tracking frames can be read', async () => {
  decode.missing = new Set([0, 1, 2]); const { ctx, store, target } = setup(); const before = JSON.stringify(store.projectForSave()); await start(ctx);
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
  expect(document.querySelector('.track-dialog[open]')).toBeTruthy();
  expect(document.querySelector('.track-dialog [role=status]').textContent).toContain('Could not read');
  decode.missing.clear(); document.querySelector('.track-dialog .btn.primary').click();
  await vi.waitFor(() => expect(document.querySelector('.track-dialog')).toBeNull());
  expect(target.keyframes.x.map(k => k.t)).toEqual([0, 133333]); expect(store.history.undoStack).toHaveLength(1);
});
it.each([false, true])('keeps backward-pass samples when its anchor frame is unavailable (reverse=%s)', async reversed => {
  decode.missing.add(0); const { ctx, store, target } = setup(reversed); store.seek(100000); await start(ctx);
  expect(target.keyframes.x.map(k => k.t)).toEqual([33333, 166667]);
  expect(target.keyframes.y.map(k => k.t)).toEqual([33333, 166667]);
});
