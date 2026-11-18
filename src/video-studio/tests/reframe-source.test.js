import { it, expect, vi, afterEach } from 'vitest';
import { createSmartActions } from '../src/ui/smart-actions.js';
import { EditorStore } from '../src/model/store.js';
import { findClip } from '../src/model/timeline.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';
const video = vi.hoisted(() => ({ pause: null }));
vi.mock('../src/media/reframe.js', async original => ({ ...await original(), attentionPath: async (_blob, from) => { if (video.pause) await video.pause(); return [{ t: from, x: .75, y: .5 }]; } }));
const button = text => [...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === text);
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); video.pause = null; });
function setup(two = false) {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
  vi.stubGlobal('OffscreenCanvas', class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4).fill(128) }) }; } });
  const p = fixture(), first = clip('image', 0, 4); onMain(p, first); p.assets.replacement = { ...p.assets.img, id: 'replacement', hash: 'new', width: 400, height: 800 }; let second;
  if (two) { second = clip('image', 0, 4); p.tracks.push(makeTrack('video', { clips: [second] })); }
  const store = new EditorStore(p); store.select([first.id, ...(second ? [second.id] : [])]); const library = { mediaBlob: vi.fn(async () => new Blob()) }, ctx = { store, library }; ctx.actions = createSmartActions(ctx); return { ctx, store, first: first.id, second: second?.id };
}
async function open(x, all = false) { await x.ctx.actions.autoReframe(); const selects = document.querySelectorAll('dialog[open] select'); selects[0].value = '9:16'; if (all) selects[1].value = 'all'; return button('Reframe'); }
const changes = {
  replacement: (p, x) => { findClip(p, x.first).clip.assetId = 'replacement'; },
  media: p => { p.assets.img.hash = 'relinked'; },
  crop: (p, x) => { findClip(p, x.first).clip.crop = { l: .2, r: 0, t: 0, b: 0 }; },
  framing: (p, x) => { findClip(p, x.first).clip.pictureSize = { width: 400, height: 800 }; },
  position: (p, x) => { findClip(p, x.first).clip.transform.x = .3; },
  keys: (p, x) => { findClip(p, x.first).clip.keyframes.x = [{ t: 0, v: .2 }, { t: 1000000, v: .4 }]; },
  frame: p => { p.settings.width = 900; p.settings.height = 900; p.settings.ratio = '1:1'; },
  delete: (p, x) => { const f = findClip(p, x.first); f.track.clips.splice(f.index, 1); },
};
it.each(Object.keys(changes))('rejects stale reframe results after %s during bitmap decoding', async change => {
  let finish; const x = setup(); createImageBitmap.mockImplementation(() => new Promise(r => { finish = () => r({ close() {} }); })); (await open(x)).click(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); x.store.update(change, p => changes[change](p, x)); const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length; finish(); await flush();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(history); expect(document.querySelector('.toast.success')).toBeNull(); expect(document.querySelector('.toast.error')?.textContent).toContain('Run Auto reframe again');
});
it('does not decode media replaced while its file is loading', async () => {
  let finish; const x = setup(); x.ctx.library.mediaBlob.mockImplementation(() => new Promise(r => { finish = () => r(new Blob()); })); (await open(x)).click(); x.store.update('Replace', p => changes.replacement(p, x)); finish(); await flush(); expect(createImageBitmap).not.toHaveBeenCalled(); expect(x.store.history.undoStack).toHaveLength(1); expect(document.querySelector('.toast.error')).toBeTruthy();
});
it('does not partially apply a batch after an already analyzed input changes', async () => {
  let finish, reads = 0; const x = setup(true); x.ctx.library.mediaBlob.mockImplementation(() => ++reads === 2 ? new Promise(r => { finish = () => r(new Blob()); }) : Promise.resolve(new Blob())); (await open(x)).click(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); x.store.update('Replace first', p => changes.replacement(p, x)); const before = JSON.stringify(x.store.projectForSave()); finish(); await flush(); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(1); expect(document.querySelector('.toast.error')).toBeTruthy();
});
it.each(['project', 'frame', 'delete'])('rejects settings opened before a %s change', async change => {
  const x = setup(), go = await open(x); if (change === 'project') { const next = structuredClone(x.store.project); next.id = 'new'; x.store.load(next); } else x.store.update(change, p => changes[change](p, x)); const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length; go.click(); await flush(); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(history); expect(x.ctx.library.mediaBlob).not.toHaveBeenCalled(); expect(document.querySelector('.toast.error')).toBeTruthy();
});
it('rejects analysis after loading a new project with the same clip ids', async () => {
  let finish; const x = setup(); x.ctx.library.mediaBlob.mockImplementation(() => new Promise(r => { finish = () => r(new Blob()); })); (await open(x)).click(); const next = structuredClone(x.store.project); next.id = 'new'; x.store.load(next); const before = JSON.stringify(x.store.projectForSave()); finish(); await flush(); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.error')).toBeTruthy();
});
it('rejects an all-clips result if a new visual clip appeared during analysis', async () => {
  let finish; const x = setup(); x.ctx.library.mediaBlob.mockImplementation(() => new Promise(r => { finish = () => r(new Blob()); })); (await open(x, true)).click(); x.store.update('Add picture', p => { p.tracks.push(makeTrack('video', { clips: [clip('image', 0, 4)] })); }); const before = JSON.stringify(x.store.projectForSave()); finish(); await flush(); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(1); expect(document.querySelector('.toast.error')).toBeTruthy();
});
it.each([false, true])('preserves current errors and replaces obsolete errors with source feedback (changed=%s)', async changed => {
  let fail; const x = setup(); x.ctx.library.mediaBlob.mockImplementation(() => new Promise((_, reject) => { fail = reject; })); (await open(x)).click(); if (changed) x.store.update('Replace', p => changes.replacement(p, x)); fail(new Error('Read failed')); await flush();
  if (changed) { expect(document.body.textContent).not.toContain('Read failed'); expect(document.body.textContent).toContain('Run Auto reframe again'); } else expect(document.body.textContent).toContain('Read failed');
});
it('permits unrelated edits and preserves undo, redo and reopening', async () => {
  let finish; const x = setup(); x.ctx.library.mediaBlob.mockImplementationOnce(() => new Promise(r => { finish = () => r(new Blob()); })); (await open(x)).click(); x.store.update('Unrelated', p => { p.name = 'Renamed'; p.assets.unused = { ...p.assets.img, id: 'unused' }; findClip(p, x.first).clip.name = 'Renamed clip'; }); x.store.select([]); x.store.seek(100000); finish(); await flush(); expect(x.store.project.settings.ratio).toBe('9:16'); expect(x.store.history.undoStack).toHaveLength(2); x.store.undo(); expect(x.store.project.settings.ratio).not.toBe('9:16'); x.store.redo(); expect(normalizeProject(x.store.projectForSave()).settings.ratio).toBe('9:16'); expect(x.store.project.name).toBe('Renamed');
});
it('can retry against replacement media after rejecting an old plan', async () => {
  let finish; const x = setup(); x.ctx.library.mediaBlob.mockImplementationOnce(() => new Promise(r => { finish = () => r(new Blob()); })); (await open(x)).click(); x.store.update('Replace', p => changes.replacement(p, x)); finish(); await flush(); expect(x.store.history.undoStack).toHaveLength(1); (await open(x)).click(); await flush(); expect(x.store.history.undoStack).toHaveLength(2); expect(x.store.project.settings.ratio).toBe('9:16');
});

it('rejects video analysis after its source trim changes', async () => {
  let finish; const x = setup(), c = findClip(x.store.project, x.first).clip; c.type = 'video'; c.assetId = 'vid'; video.pause = () => new Promise(r => { finish = r; }); (await open(x)).click(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); x.store.update('Trim', p => { findClip(p, x.first).clip.in = 1000000; }); const before = JSON.stringify(x.store.projectForSave()); finish(); await flush(); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(1); expect(document.querySelector('.toast.error')).toBeTruthy();
});
