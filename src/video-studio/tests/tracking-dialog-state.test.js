import { it, expect, vi, afterEach } from 'vitest';
import { openTrackingDialog } from '../src/ui/tracking-dialog.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { addClip, findClip } from '../src/model/timeline.js';
import { fixture, clip, onMain } from './helpers.js';

const work = vi.hoisted(() => ({ wait: null, started: vi.fn() }));
vi.mock('mediabunny', () => ({ ALL_FORMATS: [], BlobSource: class {}, Input: class { async getPrimaryVideoTrack() { return {}; } dispose() {} }, CanvasSink: class { async getCanvas() { return { canvas: {} }; } } }));
vi.mock('../src/media/tracker.js', async original => ({ ...await original(), grayFrames: async function* (_blob, times) {
  work.started(); await work.wait;
  const frame = Float32Array.from({ length: 256 * 144 }, (_, i) => (i * 17 % 31) / 31);
  for (const time of times) yield { frame, time };
} }));
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.body.replaceChildren(); vi.restoreAllMocks(); work.wait = null; work.started.mockClear(); });
function setup(mediaBlob = async () => new Blob()) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} });
  const p = fixture(); const [source] = onMain(p, clip('video', 0, .2));
  const target = clip('text', 0, .2); addClip(p, target, { main: false });
  target.keyframes.x = [{ t: 0, v: .1 }];
  const store = new EditorStore(p); store.select(target.id);
  const ctx = { store, library: { mediaBlob: vi.fn(mediaBlob) } }; ctx.actions = createActions(ctx);
  return { ctx, store, source, target, track: findClip(p, target.id).track };
}
function selectBox() {
  const canvas = document.querySelector('.track-frame'); canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 768, height: 432 });
  const stage = document.querySelector('.track-stage');
  stage.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
  stage.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 160, clientY: 160 }));
  stage.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  return [...document.querySelectorAll('button')].find(b => b.textContent === 'Track');
}
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

it('does not load tracking for a locked target', async () => {
  const { ctx, track } = setup(); track.locked = true;
  await openTrackingDialog(ctx);
  expect(ctx.library.mediaBlob).not.toHaveBeenCalled();
  expect(document.querySelector('dialog[open]')).toBeNull();
  expect(document.body.textContent).toContain('Unlock');
});
it('does not open tracking if its target becomes locked while loading', async () => {
  let finish; const { ctx, track } = setup(() => new Promise(r => { finish = r; }));
  const pending = openTrackingDialog(ctx); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  track.locked = true; finish(new Blob()); await pending;
  expect(document.querySelector('dialog[open]')).toBeNull();
});
it('keeps tracking open without success feedback when its target locks during analysis, then retries', async () => {
  let finish; work.wait = new Promise(r => { finish = r; });
  const { ctx, track, store, target } = setup(); await openTrackingDialog(ctx); const go = selectBox(); go.click();
  await vi.waitFor(() => expect(work.started).toHaveBeenCalledOnce());
  track.locked = true; const before = JSON.stringify(store.projectForSave()); finish(); await flush();
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
  expect(document.querySelector('dialog[open]')).toBeTruthy();
  expect(document.body.textContent).not.toContain('now follows the object');
  expect(document.querySelector('[role=status]').textContent).toContain('Unlock');
  track.locked = false; work.wait = null; go.click(); await flush();
  expect(document.querySelector('dialog[open]')).toBeNull(); expect(store.history.undoStack).toHaveLength(1);
  expect(target.keyframes.x.length).toBeGreaterThan(1);
  store.undo(); expect(findClip(store.project, target.id).clip.keyframes.x).toEqual([{ t: 0, v: .1 }]);
  store.redo(); expect(findClip(store.project, target.id).clip.keyframes.x.length).toBeGreaterThan(1);
});
it('does not announce success when a tracking edit is refused', async () => {
  const { ctx, store } = setup(); await openTrackingDialog(ctx); const go = selectBox();
  vi.spyOn(ctx.actions, 'editClip').mockReturnValue(false); go.click(); await flush();
  expect(document.querySelector('dialog[open]')).toBeTruthy(); expect(store.history.undoStack).toHaveLength(0);
  expect(document.body.textContent).not.toContain('now follows the object');
  expect(document.querySelector('[role=status]').textContent).toContain('could not be saved');
});
it('disables the tracking command for locked targets and restores it after unlocking', async () => {
  const { createCommands } = await import('../src/ui/commands.js');
  const { ctx, track } = setup(); const command = createCommands(ctx).list.find(c => c.id === 'trackMotion');
  expect(command.enabled()).toBe(true); track.locked = true; expect(command.enabled()).toBe(false);
  track.locked = false; expect(command.enabled()).toBe(true);
});
it('does not start analysis when the target locks after choosing the box', async () => {
  const { ctx, track } = setup(); await openTrackingDialog(ctx); const go = selectBox(); track.locked = true; go.click(); await flush();
  expect(work.started).not.toHaveBeenCalled(); expect(document.querySelector('dialog[open]')).toBeTruthy();
  expect(document.querySelector('[role=status]').textContent).toContain('Unlock');
});
