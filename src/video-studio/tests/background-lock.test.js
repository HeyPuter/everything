import { it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createCommands } from '../src/ui/commands.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { findClip } from '../src/model/timeline.js';
import { CUTOUT_DEFAULT } from '../src/model/cutout.js';
import { ready } from '../src/media/segmenter.js';
import { fixture, clip } from './helpers.js';
vi.mock('../src/media/segmenter.js', () => ({ ready: vi.fn() }));
afterEach(() => { document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); vi.restoreAllMocks(); ready.mockClear(); });
function setup(type = 'video') {
  const p = fixture(), locked = clip(type, 0, 3), editable = clip('image', 0, 3);
  p.tracks.push(makeTrack('video', { locked: true, clips: [locked] }), makeTrack('video', { clips: [editable] }));
  const store = new EditorStore(p), ctx = { store, inspector: { showVideoSub: vi.fn() } }; ctx.actions = createActions(ctx); ctx.commands = createCommands(ctx);
  store.select(locked.id); return { ctx, store, locked, editable };
}
it.each(['video', 'image'])('leaves locked %s clips and history unchanged without loading the model', type => {
  const { ctx, store } = setup(type), before = JSON.stringify(store.projectForSave());
  expect(ctx.actions.removeBackground()).toBe(false); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
  expect(ready).not.toHaveBeenCalled(); expect(ctx.inspector.showVideoSub).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('Unlock');
});
it('preserves existing cutout settings and brush work on a locked clip', () => {
  const { ctx, store, locked } = setup(); locked.cutout = { ...CUTOUT_DEFAULT, strokes: [{ keep: true, size: .1, pts: [[.5, .5]] }] };
  const before = JSON.stringify(store.projectForSave()); expect(ctx.actions.removeBackground(locked.id)).toBe(false);
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
});
it('toggles only editable clips in a mixed selection and preserves undo and reopening', () => {
  const { ctx, store, locked, editable } = setup(); editable.cutout = { ...CUTOUT_DEFAULT }; store.select([locked.id, editable.id]);
  expect(ctx.actions.removeBackground()).toBe(true); expect(locked.cutout).toBeUndefined(); expect(editable.cutout).toBeUndefined(); expect(ready).not.toHaveBeenCalled();
  expect(store.history.undoStack).toHaveLength(1); store.undo(); expect(findClip(store.project, editable.id).clip.cutout).toEqual(CUTOUT_DEFAULT);
  store.redo(); expect(findClip(normalizeProject(store.projectForSave()), editable.id).clip.cutout).toBeUndefined();
  expect(ctx.actions.removeBackground()).toBe(true); expect(findClip(store.project, locked.id).clip.cutout).toBeUndefined(); expect(findClip(store.project, editable.id).clip.cutout).toEqual(CUTOUT_DEFAULT); expect(ready).toHaveBeenCalledOnce();
});
it('does not fall back to the selection when an explicit target is locked', () => {
  const { ctx, store, locked } = setup(); const other = clip('image', 4, 3); store.project.tracks.at(-1).clips.push(other); store.select(other.id);
  const before = JSON.stringify(store.projectForSave()); expect(ctx.actions.removeBackground(locked.id)).toBe(false); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
});
it('disables the command for locked selections and updates with unlock, undo and mixed selections', () => {
  const { ctx, store, locked, editable } = setup(), command = ctx.commands.get('removeBackground');
  expect(command.enabled()).toBe(false); expect(ctx.commands.run('removeBackground')).toBe(false); expect(ready).not.toHaveBeenCalled();
  store.update('Unlock', p => { findClip(p, locked.id).track.locked = false; }); expect(command.enabled()).toBe(true);
  store.undo(); expect(command.enabled()).toBe(false); store.select([locked.id, editable.id]); expect(command.enabled()).toBe(true);
});
