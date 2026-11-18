import { it, expect, vi, afterEach } from 'vitest';
import { createSmartActions } from '../src/ui/smart-actions.js';
import { EditorStore } from '../src/model/store.js';
import { findClip } from '../src/model/timeline.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';
const button = text => [...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === text);
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup({ two = false, locked = false } = {}) {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
  vi.stubGlobal('OffscreenCanvas', class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4).fill(128) }) }; } });
  const p = fixture(), first = clip('image', 0, 4); onMain(p, first); p.tracks[0].locked = locked; let second;
  if (two) { second = clip('image', 0, 4); p.tracks.push(makeTrack('video', { clips: [second] })); }
  const store = new EditorStore(p); store.select([first.id, ...(second ? [second.id] : [])]); const library = { mediaBlob: vi.fn(async () => new Blob()) }, ctx = { store, library }; ctx.actions = createSmartActions(ctx); return { ctx, store, first: first.id, second: second?.id };
}
async function start(x) { await x.ctx.actions.autoReframe(); document.querySelector('dialog[open] select').value = '9:16'; button('Reframe').click(); }
it.each(['media', 'bitmap'])('rejects the reframe and frame-shape edit after a late lock during %s', async stage => {
  let finish; const x = setup(); if (stage === 'media') x.ctx.library.mediaBlob.mockImplementation(() => new Promise(r => { finish = () => r(new Blob()); })); else createImageBitmap.mockImplementation(() => new Promise(r => { finish = () => r({ close() {} }); }));
  await start(x); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); x.store.update('Lock', p => { findClip(p, x.first).track.locked = true; }); const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length; finish(); await flush();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(history); expect(document.querySelector('.toast.success')).toBeNull(); expect(document.querySelector('.toast.error')?.textContent).toMatch(/lock/i);
  x.store.update('Unlock', p => { findClip(p, x.first).track.locked = false; }); x.ctx.library.mediaBlob.mockResolvedValue(new Blob()); createImageBitmap.mockResolvedValue({ close() {} }); const prevRatio = x.store.project.settings.ratio; await start(x); await flush(); expect(x.store.project.settings.ratio).toBe('9:16'); x.store.undo(); expect(x.store.project.settings.ratio).toBe(prevRatio); x.store.redo(); expect(normalizeProject(x.store.projectForSave()).settings.ratio).toBe('9:16');
});
it('does not partially apply a batch if a previously analyzed clip becomes locked', async () => {
  let finish, reads = 0; const x = setup({ two: true }); x.ctx.library.mediaBlob.mockImplementation(() => ++reads === 2 ? new Promise(r => { finish = () => r(new Blob()); }) : Promise.resolve(new Blob())); await start(x); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  x.store.update('Lock first', p => { findClip(p, x.first).track.locked = true; }); const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length; finish(); await flush();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(history); expect(document.querySelector('.toast.error')?.textContent).toMatch(/lock/i); expect(document.querySelector('.toast.success')).toBeNull();
});
it('reports a refused reframe transaction instead of success', async () => {
  const x = setup(), before = JSON.stringify(x.store.projectForSave()); vi.spyOn(x.store, 'update').mockReturnValue(false); await start(x); await flush(); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.success')).toBeNull(); expect(document.querySelector('.toast.error')?.textContent).toContain('could not be saved');
});
it('continues to skip initially locked clips while reframing editable selections', async () => {
  const x = setup({ two: true, locked: true }), before = JSON.stringify(findClip(x.store.project, x.first).clip); await start(x); await flush(); expect(x.ctx.library.mediaBlob).toHaveBeenCalledOnce(); expect(JSON.stringify(findClip(x.store.project, x.first).clip)).toBe(before); expect(findClip(x.store.project, x.second).clip.transform.scale).toBeGreaterThan(1); expect(x.store.project.settings.ratio).toBe('9:16'); expect(x.store.history.undoStack).toHaveLength(1); expect(document.querySelector('.toast.success')?.textContent).toContain('Reframed 1 clip');
});
it('keeps an explicitly requested frame-shape change available with locked clips', async () => {
  const x = setup({ locked: true }), before = JSON.stringify(findClip(x.store.project, x.first).clip); await start(x); await flush(); expect(x.ctx.library.mediaBlob).not.toHaveBeenCalled(); expect(JSON.stringify(findClip(x.store.project, x.first).clip)).toBe(before); expect(x.store.project.settings.ratio).toBe('9:16'); expect(x.store.history.undoStack).toHaveLength(1);
});
