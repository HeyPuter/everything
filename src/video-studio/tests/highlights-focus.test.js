import { afterEach, expect, it, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { openHighlightsDialog } from '../src/ui/highlights-dialog.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture, clip, onMain } from './helpers.js';
const dialogs = [], reply = '{"highlights":[{"title":"First","start":20,"end":59},{"title":"Second","start":100,"end":139}]}';
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const button = (d, text) => [...d.el.querySelectorAll('button')].find(b => b.textContent === text);
const field = (d, label) => d.el.querySelector(`[aria-label="${label}"]`);
const select = (d, label, value) => { const el = field(d, label); el.value = value; el.dispatchEvent(new Event('change')); };
afterEach(() => { dialogs.splice(0).forEach(d => d.close()); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function setup() {
  setPref('highlights', { target: 'projects', shape: 'keep' });
  const p = fixture(); p.assets.vid.duration = 200e6; onMain(p, clip('video', 0, 120));
  p.transcript = { words: Array.from({ length: 240 }, (_, i) => ({ text: `word${i}${i % 10 === 9 ? '.' : ''}`, start: i * 500000, end: i * 500000 + 400000 })) };
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const store = new EditorStore(p), library = { saveProject: vi.fn(async () => {}) }, chat = vi.fn(async () => reply), d = openHighlightsDialog({ store, library }, { chat }); dialogs.push(d);
  return { d, store, library, chat, opener };
}
it('retains initial focus on the first option', () => { const e = setup(); expect(document.activeElement).toBe(field(e.d, 'How many')); });
it.each(['Find highlights', 'How many'])('focuses Stop when search replaces %s', async from => {
  const e = setup(), pending = defer(); e.chat.mockReturnValueOnce(pending.promise);
  (button(e.d, from) || field(e.d, from)).focus(); const run = e.d.search();
  try { expect(document.activeElement).toBe(button(e.d, 'Stop')); } finally { pending.resolve(reply); await run; }
});
it('focuses the first highlight when search completes, then the options on Search again', async () => {
  const e = setup(); button(e.d, 'Find highlights').focus(); await e.d.search(); expect(document.activeElement).toBe(field(e.d, 'Use highlight 1'));
  button(e.d, 'Search again').focus(); button(e.d, 'Search again').click(); expect(document.activeElement).toBe(field(e.d, 'How many'));
});
it.each(['failure', 'stop'])('focuses Find highlights for retry after search %s', async kind => {
  const e = setup(), pending = defer(); vi.spyOn(console, 'error').mockImplementation(() => {}); e.chat.mockReturnValueOnce(pending.promise); button(e.d, 'Find highlights').focus(); const run = e.d.search();
  if (kind === 'stop') { button(e.d, 'Stop').focus(); button(e.d, 'Stop').click(); pending.resolve(reply); } else pending.reject(new Error('Search failed'));
  await run; expect(document.activeElement).toBe(button(e.d, 'Find highlights')); await e.d.search(); expect(e.d.found).toHaveLength(2);
});
it('focuses Stop while making projects', async () => {
  const e = setup(), pending = defer(); await e.d.search(); e.library.saveProject.mockReturnValueOnce(pending.promise); button(e.d, 'Make 2 clips').focus(); const run = e.d.make();
  try { expect(document.activeElement).toBe(button(e.d, 'Stop')); } finally { pending.resolve(); await run; }
  expect(document.activeElement).toBe(e.opener);
});
it.each(['failure', 'stop'])('focuses Make for retry after saving %s', async kind => {
  const e = setup(), pending = defer(); vi.spyOn(console, 'error').mockImplementation(() => {}); await e.d.search(); e.library.saveProject.mockReturnValueOnce(pending.promise); button(e.d, 'Make 2 clips').focus(); const run = e.d.make();
  await vi.waitFor(() => expect(e.library.saveProject).toHaveBeenCalledOnce());
  if (kind === 'stop') { button(e.d, 'Stop').focus(); button(e.d, 'Stop').click(); pending.resolve(); } else pending.reject(new Error('Save failed'));
  await run; expect(document.activeElement).toBe(button(e.d, 'Make 2 clips')); await e.d.make(); expect(document.activeElement).toBe(e.opener);
});
it.each(['success', 'failure', 'stop'])('preserves deliberate header focus after search %s', async kind => {
  const e = setup(), pending = defer(); vi.spyOn(console, 'error').mockImplementation(() => {}); e.chat.mockReturnValueOnce(pending.promise); const run = e.d.search();
  if (kind === 'stop') button(e.d, 'Stop').click(); const close = field(e.d, 'Close'); close.focus();
  if (kind === 'failure') pending.reject(new Error('Search failed')); else pending.resolve(reply);
  await run; expect(document.activeElement).toBe(close);
});
it.each(['failure', 'stop'])('preserves deliberate header focus after saving %s', async kind => {
  const e = setup(), pending = defer(); vi.spyOn(console, 'error').mockImplementation(() => {}); await e.d.search(); e.library.saveProject.mockReturnValueOnce(pending.promise); const run = e.d.make();
  await vi.waitFor(() => expect(e.library.saveProject).toHaveBeenCalledOnce());
  if (kind === 'stop') button(e.d, 'Stop').click(); const close = field(e.d, 'Close'); close.focus();
  if (kind === 'failure') pending.reject(new Error('Save failed')); else pending.resolve();
  await run; expect(document.activeElement).toBe(close);
});
it('does not steal focus after close when a search settles', async () => {
  const e = setup(), pending = defer(); e.chat.mockReturnValueOnce(pending.promise); const run = e.d.search(); e.d.close(); const other = document.createElement('input'); document.body.append(other); other.focus(); pending.resolve(reply); await run; expect(document.activeElement).toBe(other);
});
it('does not steal focus from another open dialog when search settles', async () => {
  const e = setup(), pending = defer(); e.chat.mockReturnValueOnce(pending.promise); const run = e.d.search(); const other = document.createElement('dialog'), input = document.createElement('input'); other.append(input); document.body.append(other); other.showModal(); input.focus(); pending.resolve(reply); await run; expect(document.activeElement).toBe(input); other.close(); other.remove();
});
it('retains title edits and normal focus restoration when creating compounds', async () => {
  const e = setup(); await e.d.search(); const title = field(e.d, 'Title of highlight 1'); title.focus(); title.value = 'Edited highlight'; title.dispatchEvent(new Event('input')); expect(document.activeElement).toBe(title);
  select(e.d, 'Make', 'here'); await e.d.make(); expect(document.activeElement).toBe(e.opener); expect(e.store.project.tracks.flatMap(t => t.clips).some(c => c.name === 'Edited highlight')).toBe(true);
});
it('keeps focus on the newly revealed language field after transcript removal', async () => {
  const e = setup(); e.store.update('Clear transcript', p => { delete p.transcript; }); button(e.d, 'Find highlights').focus(); await e.d.search(); expect(document.activeElement).toBe(field(e.d, 'Spoken language'));
});
