import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from '../src/ui/editor.js';
import { openHighlights, openHighlightsDialog } from '../src/ui/highlights-dialog.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture, clip, onMain } from './helpers.js';

const parents = [], dialogs = [];
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const reply = '{"highlights":[{"title":"First","start":20,"end":59},{"title":"Second","start":100,"end":139}]}';
const select = (d, name, value) => { const el = d.el.querySelector(`[aria-label="${name}"]`); el.value = value; el.dispatchEvent(new Event('change')); };
const button = (d, text) => [...d.el.querySelectorAll('button')].find(b => b.textContent === text);
afterEach(() => { parents.splice(0).forEach(p => p.dispose()); dialogs.splice(0).forEach(d => d?.close()); delete globalThis.__vsAiStub; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); });
async function setup({ signedIn = true, empty = false } = {}) {
  setPref('highlights', { target: 'here', shape: 'keep', captions: 'yellow-caption' });
  const root = document.createElement('div'); root.id = 'app'; document.body.append(root);
  const project = fixture(); project.assets.vid.duration = 200e6; if (!empty) onMain(project, clip('video', 0, 120));
  project.transcript = { language: 'en', words: Array.from({ length: 240 }, (_, i) => ({ text: `w${i}${i % 10 === 9 ? '.' : ''}`, start: i * 500000, end: i * 500000 + 400000 })) };
  const library = new Library(memoryBackend(), { cache: null }); await library.saveProject(project);
  const parent = new Editor(root, { library, project, account: {}, onExit() {}, onNewProject() {} }); parents.push(parent);
  if (signedIn) globalThis.__vsAiStub = true;
  const chat = vi.fn(async () => reply); vi.stubGlobal('puter', { ai: { chat } });
  await new Promise(r => setTimeout(r, 20));
  const open = async () => { const d = await parent.ctx.openHighlights(); dialogs.push(d); return d; };
  return { parent, library, chat, open, store: parent.store };
}
it.each(['idle', 'results', 'preview'])('closes the %s dialog on editor disposal', async phase => {
  const e = await setup(), d = await e.open(); if (phase !== 'idle') await d.search(); if (phase === 'preview') button(d, 'Preview').click();
  e.parent.dispose(); const before = structuredClone(e.store.project.tracks), calls = e.chat.mock.calls.length; await d.search(); await d.make();
  expect(d.el.isConnected).toBe(false); expect(e.store.project.tracks).toEqual(before); expect(e.chat).toHaveBeenCalledTimes(calls); expect(e.parent.ctx.player.playing).toBe(false);
});
it('discards search results after disposal and prevents late insertion', async () => {
  const e = await setup(), d = await e.open(), pending = defer(); e.chat.mockReturnValueOnce(pending.promise);
  const run = d.search(); await vi.waitFor(() => expect(e.chat).toHaveBeenCalledOnce()); const before = structuredClone(e.store.project.tracks); e.parent.dispose();
  pending.resolve(reply); await run; await d.make(); expect(d.el.isConnected).toBe(false); expect(e.store.project.tracks).toEqual(before); expect(d.found).toEqual([]);
});
it('ignores a late search error after disposal', async () => {
  const e = await setup(), d = await e.open(), pending = defer(), errors = vi.spyOn(console, 'error').mockImplementation(() => {}); e.chat.mockReturnValueOnce(pending.promise);
  const run = d.search(); await vi.waitFor(() => expect(e.chat).toHaveBeenCalledOnce()); e.parent.dispose(); const html = d.el.innerHTML; pending.reject(new Error('Late failure')); await run;
  expect(d.el.innerHTML).toBe(html); expect(errors).not.toHaveBeenCalled();
});
it('does not save after a media read outlives the editor', async () => {
  const e = await setup(), d = await e.open(), pending = defer(); await d.search(); select(d, 'Make', 'projects'); select(d, 'Frame shape', '9:16');
  const read = vi.spyOn(e.library, 'mediaBlob').mockReturnValueOnce(pending.promise), save = vi.spyOn(e.library, 'saveProject');
  const run = d.make(); await vi.waitFor(() => expect(read).toHaveBeenCalled()); e.parent.dispose(); pending.resolve(null); await run;
  expect(d.el.isConnected).toBe(false); expect(save).not.toHaveBeenCalled();
});
it.each([false, true])('stops saving after disposal (final save: %s)', async last => {
  const e = await setup(), d = await e.open(), pending = defer(); await d.search(); select(d, 'Make', 'projects'); if (last) d.found[1].keep = false;
  const save = vi.spyOn(e.library, 'saveProject').mockReturnValueOnce(pending.promise); const run = d.make(); await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  e.parent.dispose(); pending.resolve(); await run; expect(save).toHaveBeenCalledOnce(); expect(d.el.isConnected).toBe(false); expect(document.querySelector('.toast.success')).toBeNull();
});
it('ignores a late save failure after disposal', async () => {
  const e = await setup(), d = await e.open(), pending = defer(), errors = vi.spyOn(console, 'error').mockImplementation(() => {}); await d.search(); select(d, 'Make', 'projects');
  const save = vi.spyOn(e.library, 'saveProject').mockReturnValueOnce(pending.promise); const run = d.make(); await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  e.parent.dispose(); pending.reject(new Error('Late save')); await run; expect(errors).not.toHaveBeenCalled(); expect(d.el.isConnected).toBe(false);
});
it('ignores module loading that finishes after disposal', async () => {
  const e = await setup(), opening = e.open(); e.parent.dispose(); const d = await opening; expect(d).toBeNull(); expect(document.querySelector('dialog')).toBeNull();
});
it('refuses a new launch from an already-disposed editor', async () => {
  const e = await setup(); e.parent.dispose(); expect(await e.open()).toBeNull(); expect(document.querySelector('dialog')).toBeNull();
});
it('shares simultaneous launches and can reopen after Close', async () => {
  const e = await setup(), [a, b] = await Promise.all([e.open(), e.open()]); expect(a).toBe(b); expect(document.querySelectorAll('dialog')).toHaveLength(1);
  expect(await e.open()).toBe(a); a.close(); const next = await e.open(); expect(next).not.toBe(a); expect(next.el.isConnected).toBe(true);
});
it('does not clear a newer dialog when the older result settles', async () => {
  const e = await setup(), first = openHighlights(e.parent.ctx); dialogs.push(first); first.close(); const next = openHighlights(e.parent.ctx); dialogs.push(next);
  await first.result; expect(openHighlights(e.parent.ctx)).toBe(next);
});
it('owns the sign-in explanation through editor disposal', async () => {
  const e = await setup({ signedIn: false }), d = await e.open(); expect(d.el.textContent).toContain('Sign in to use AI'); e.parent.dispose(); expect(d.el.isConnected).toBe(false);
});
it('can launch after an initially missing source is added', async () => {
  const e = await setup({ empty: true }); expect(await e.open()).toBeNull(); e.store.update('Add source', p => onMain(p, clip('video', 0, 120)));
  const d = await e.open(); expect(d.el.isConnected).toBe(true); await d.search(); expect(d.found).toHaveLength(2);
});
it.each(['here', 'projects'])('normal %s creation still completes and allows reopening', async target => {
  const e = await setup(), d = await e.open(); await d.search(); select(d, 'Make', target); const before = structuredClone(e.store.project.tracks), save = vi.spyOn(e.library, 'saveProject'); await d.make();
  expect(d.el.isConnected).toBe(false);
  if (target === 'here') { expect(e.store.selectedIds).toHaveLength(2); e.store.undo(); expect(e.store.project.tracks).toEqual(before); }
  else { expect(save).toHaveBeenCalledTimes(2); for (const [p] of save.mock.calls) expect((await e.library.openProject(p.id)).name).toBe(p.name); }
  const next = await e.open(); expect(next).not.toBe(d); expect(next.el.isConnected).toBe(true);
});
it('does not open a direct dialog with an already-aborted parent signal', async () => {
  const e = await setup(), controller = new AbortController(); controller.abort(); const d = openHighlightsDialog(e.parent.ctx, { signal: controller.signal, chat: e.chat }); dialogs.push(d); expect(d).toBeNull();
});
it('releases a direct dialog on its parent signal and removes the listener on Close', async () => {
  const e = await setup(), controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
  const d = openHighlightsDialog(e.parent.ctx, { signal: controller.signal, chat: e.chat }); dialogs.push(d); controller.abort();
  expect(d.el.isConnected).toBe(false); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
