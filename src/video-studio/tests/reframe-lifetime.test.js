import { it, expect, vi, afterEach } from 'vitest';
import { Editor } from '../src/ui/editor.js';
import { EditorStore } from '../src/model/store.js';
import { createSmartActions } from '../src/ui/smart-actions.js';
import { normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';
const owners = [], dispose = owner => Editor.prototype.dispose.call(owner);
const button = text => [...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === text);
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
afterEach(() => { owners.splice(0).forEach(dispose); document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup(mediaBlob = async () => new Blob()) {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
  vi.stubGlobal('OffscreenCanvas', class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4).fill(128) }) }; } });
  const p = fixture(), c = clip('image', 0, 4); onMain(p, c); const store = new EditorStore(p); store.select(c.id); const library = { mediaBlob: vi.fn(mediaBlob), releaseMedia() {} }, ctx = { store, library };
  const owner = { ctx, library, _cancelCover() {}, saver: { dispose() {} }, proxies: { dispose() {} }, media: { dispose() {} } }; ctx.editor = owner; ctx.actions = createSmartActions(ctx); owners.push(owner); return { ctx, store, owner };
}
async function open(x) { await x.ctx.actions.autoReframe(); const dialog = document.querySelector('dialog[open]'); dialog.querySelector('select').value = '9:16'; return { dialog, go: button('Reframe'), cancel: button('Cancel') }; }
it('does not open Auto reframe for a disposed editor', async () => {
  const x = setup(); dispose(x.owner); await x.ctx.actions.autoReframe(); expect(document.querySelector('dialog[open]')).toBeNull(); expect(x.ctx.library.mediaBlob).not.toHaveBeenCalled();
});
it.each(['dispose', 'cancel'])('rejects the retained Reframe control after settings %s', async how => {
  const x = setup(), ui = await open(x), before = JSON.stringify(x.store.projectForSave()); if (how === 'dispose') dispose(x.owner); else ui.cancel.click(); const closed = !document.querySelector('dialog[open]'); ui.go.click(); await flush();
  expect(closed).toBe(true); expect(x.ctx.library.mediaBlob).not.toHaveBeenCalled(); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.success')).toBeNull();
});
it.each(['resolve', 'reject'])('closes pending analysis and discards an old media %s after disposal', async how => {
  let finish; const x = setup(() => new Promise((resolve, reject) => { finish = () => how === 'resolve' ? resolve(new Blob()) : reject(new Error('Obsolete reframe read')); })), ui = await open(x), before = JSON.stringify(x.store.projectForSave()); ui.go.click(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); dispose(x.owner); const closed = !document.querySelector('dialog[open]'); finish(); await flush();
  expect(closed).toBe(true); expect(createImageBitmap).not.toHaveBeenCalled(); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(0); expect(document.querySelector('.toast.success')).toBeNull(); expect(document.querySelector('.toast.error')).toBeNull();
});
it('closes a late bitmap without applying its reframe plan after disposal', async () => {
  let finish; const x = setup(), bitmap = { close: vi.fn() }; createImageBitmap.mockImplementation(() => new Promise(r => { finish = () => r(bitmap); })); const ui = await open(x), before = JSON.stringify(x.store.projectForSave()); ui.go.click(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); dispose(x.owner); finish(); await flush();
  expect(bitmap.close).toHaveBeenCalledOnce(); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(0); expect(document.querySelector('dialog[open]')).toBeNull(); expect(document.querySelector('.toast.success')).toBeNull();
});
it('does not restart analysis from the already accepted settings control', async () => {
  const x = setup(), ui = await open(x); ui.go.click(); ui.go.click(); await flush(); expect(x.ctx.library.mediaBlob).toHaveBeenCalledOnce(); expect(x.store.history.undoStack).toHaveLength(1);
});
it('lets a new editor reframe while an old media read is still pending', async () => {
  let finish; const old = setup(() => new Promise(r => { finish = () => r(new Blob()); })), oldUI = await open(old); oldUI.go.click(); dispose(old.owner); const fresh = setup(), ui = await open(fresh); ui.go.click(); await flush(); const noDialogs = !document.querySelector('dialog[open]'); finish(); await flush();
  expect(noDialogs).toBe(true); expect(old.store.history.undoStack).toHaveLength(0); expect(fresh.store.project.settings.ratio).toBe('9:16'); expect(fresh.store.history.undoStack).toHaveLength(1); fresh.store.undo(); expect(fresh.store.project.settings.ratio).not.toBe('9:16'); fresh.store.redo(); expect(normalizeProject(fresh.store.projectForSave()).settings.ratio).toBe('9:16');
});
