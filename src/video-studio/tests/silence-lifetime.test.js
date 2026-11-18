import { it, expect, vi, afterEach } from 'vitest';
import { Editor } from '../src/ui/editor.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { mainTrack } from '../src/model/timeline.js';
import { fixture, clip, onMain } from './helpers.js';
import { mixdown } from '../src/media/transcribe.js';
const work = vi.hoisted(() => ({ pause: null, signal: null }));
vi.mock('../src/media/transcribe.js', async original => ({ ...await original(), mixdown: vi.fn(async (_p, _l, { signal }) => {
  work.signal = signal; if (work.pause) await work.pause();
  const data = new Float32Array(32000); for (let i = 0; i < data.length; i++) if (i < 8000 || i >= 24000) data[i] = .5 * Math.sin(i * .3); return data;
}) }));
const owners = [], dispose = owner => Editor.prototype.dispose.call(owner);
afterEach(() => { owners.splice(0).forEach(dispose); document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); work.pause = null; work.signal = null; mixdown.mockClear(); });
function setup() {
  const p = fixture(); onMain(p, clip('video', 0, 4)); const store = new EditorStore(p), library = { releaseMedia() {} }, ctx = { store, library };
  const owner = { ctx, library, _cancelCover() {}, saver: { dispose() {} }, proxies: { dispose() {} }, media: { dispose() {} } }; ctx.editor = owner; ctx.actions = createActions(ctx); owners.push(owner); return { ctx, store, owner };
}
async function open(ctx) { await ctx.actions.removeSilences(); const dialog = document.querySelector('dialog[open]'), button = text => [...dialog.querySelectorAll('button')].find(b => b.textContent === text); return { dialog, find: button('Find silences'), cut: button('Cut them'), close: button('Close') }; }
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
it('does not open Remove silences for a disposed editor', async () => {
  const { ctx, owner } = setup(); dispose(owner); await ctx.actions.removeSilences(); expect(document.querySelector('dialog[open]')).toBeNull(); expect(mixdown).not.toHaveBeenCalled();
});
it.each(['close', 'dispose'])('discards a late silence result after %s', async how => {
  let finish; work.pause = () => new Promise(r => { finish = r; }); const { ctx, store, owner } = setup(), ui = await open(ctx); const before = JSON.stringify(store.projectForSave()); ui.find.click();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); if (how === 'close') ui.close.click(); else dispose(owner);
  const closed = !document.querySelector('dialog[open]'), aborted = work.signal.aborted; finish(); await flush(); ui.cut.click();
  expect(closed).toBe(true); expect(aborted).toBe(true); expect(ui.cut.disabled).toBe(true); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
});
it.each(['close', 'dispose'])('does not apply previously found silence cuts after %s', async how => {
  const { ctx, store, owner } = setup(), ui = await open(ctx); ui.find.click(); await vi.waitFor(() => expect(ui.cut.disabled).toBe(false)); const before = JSON.stringify(store.projectForSave());
  if (how === 'close') ui.close.click(); else dispose(owner); ui.cut.click();
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(document.querySelector('dialog[open]')).toBeNull();
});
it.each(['close', 'dispose'])('does not start a detached Find action after %s', async how => {
  const { ctx, owner } = setup(), ui = await open(ctx); if (how === 'close') ui.close.click(); else dispose(owner); ui.find.click(); await flush();
  expect(mixdown).not.toHaveBeenCalled(); expect(document.querySelector('dialog[open]')).toBeNull();
});
it('does not put late errors into a closed silence dialog', async () => {
  let fail; work.pause = () => new Promise((_, reject) => { fail = reject; }); const { ctx, owner } = setup(), ui = await open(ctx); ui.find.click(); await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
  dispose(owner); fail(new Error('Old silence read failed')); await flush(); expect(ui.dialog.textContent).not.toContain('Old silence read failed'); expect(document.querySelector('dialog[open]')).toBeNull();
});
it('lets a new editor find and cut silences while an old read remains pending', async () => {
  let finish; work.pause = () => new Promise(r => { finish = r; }); const old = setup(), oldUI = await open(old.ctx); oldUI.find.click(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); dispose(old.owner);
  work.pause = null; const fresh = setup(), ui = await open(fresh.ctx); ui.find.click(); await vi.waitFor(() => expect(ui.cut.disabled).toBe(false)); ui.cut.click();
  try { expect(fresh.store.history.undoStack).toHaveLength(1); expect(mainTrack(fresh.store.project).clips).toHaveLength(2); expect(document.querySelector('dialog[open]')).toBeNull(); }
  finally { finish(); await flush(); }
  expect(old.store.history.undoStack).toHaveLength(0);
});
