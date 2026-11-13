import { afterEach, expect, it, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { addTimeline } from '../src/model/timelines.js';
import { createProject } from '../src/model/project.js';
import { createCompound } from '../src/model/compound.js';
import { openHighlightsDialog } from '../src/ui/highlights-dialog.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture, clip, onMain } from './helpers.js';

const dialogs = [];
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const reply = '{"highlights":[{"title":"First","start":20,"end":59},{"title":"Second","start":100,"end":139}]}';
const select = (d, name, value) => { const el = d.el.querySelector(`[aria-label="${name}"]`); el.value = value; el.dispatchEvent(new Event('change')); };
afterEach(() => { dialogs.splice(0).forEach(d => d.close()); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function setup() {
  setPref('highlights', { target: 'here', captions: 'yellow-caption' });
  const p = fixture(); p.assets.vid.duration = 200e6;
  const source = clip('video', 0, 120), nested = clip('text', 0, 1);
  onMain(p, source, nested); const compound = createCompound(p, [nested.id]);
  p.transcript = { language: 'en', words: Array.from({ length: 240 }, (_, i) => ({ text: `w${i}${i % 10 === 9 ? '.' : ''}`, start: i * 500000, end: i * 500000 + 400000 })) };
  const target = addTimeline(p), original = p.timelineId, store = new EditorStore(p);
  const library = { mediaBlob: vi.fn(async () => null), saveProject: vi.fn(async () => {}) }, chat = vi.fn(async () => reply);
  const listeners = new Set();
  const player = { playing: false, play: vi.fn(() => { player.playing = true; }), pause: vi.fn(() => { player.playing = false; }), on: vi.fn((_, fn) => { listeners.add(fn); return () => listeners.delete(fn); }) };
  const d = openHighlightsDialog({ store, library, player }, { chat, clipId: source.id }); dialogs.push(d);
  return { d, store, library, player, listeners, chat, target, original, compound, source };
}
function change(e, kind) {
  if (kind === 'timeline' || kind === 'return') { e.store.openTimeline(e.target); if (kind === 'return') e.store.openTimeline(e.original); }
  if (kind === 'compound') e.store.openCompound(e.compound.id);
  if (kind === 'project') e.store.load(createProject());
}
it.each(['timeline', 'return', 'compound', 'project'])('discards pending search after changing context: %s', async kind => {
  const e = setup(), pending = defer(); e.chat.mockReturnValue(pending.promise);
  const run = e.d.search(); await vi.waitFor(() => expect(e.chat).toHaveBeenCalledOnce());
  change(e, kind); const before = structuredClone(e.store.project), html = e.d.el.innerHTML;
  pending.resolve(reply); await run; await e.d.make();
  expect(e.store.project).toEqual(before); expect(e.d.el.isConnected).toBe(false); expect(e.d.found).toEqual([]);
  expect(e.d.el.innerHTML).toBe(html);
});
it.each(['idle', 'results', 'preview'])('closes %s on timeline change and prevents subsequent actions', async phase => {
  const e = setup(); if (phase !== 'idle') await e.d.search();
  if (phase === 'preview') [...e.d.el.querySelectorAll('button')].find(b => b.textContent === 'Preview').click();
  e.store.openTimeline(e.target); const before = structuredClone(e.store.project), calls = e.chat.mock.calls.length;
  await e.d.search(); await e.d.make();
  expect(e.d.el.isConnected).toBe(false); expect(e.store.project).toEqual(before); expect(e.chat).toHaveBeenCalledTimes(calls);
  expect(e.player.playing).toBe(false); expect(e.listeners.size).toBe(0);
});
it.each(['close', 'context'])('suppresses a late chat error after %s', async how => {
  const e = setup(), pending = defer(), errors = vi.spyOn(console, 'error').mockImplementation(() => {}); e.chat.mockReturnValue(pending.promise);
  const run = e.d.search(); await vi.waitFor(() => expect(e.chat).toHaveBeenCalledOnce());
  if (how === 'close') e.d.close(); else e.store.openTimeline(e.target);
  pending.reject(new Error('Late chat failure')); await run;
  expect(errors).not.toHaveBeenCalled(); expect(document.querySelector('.toast.error')).toBeNull();
});
it.each(['close', 'context'])('does not save after a pending media read outlives %s', async how => {
  const e = setup(), pending = defer(); await e.d.search(); select(e.d, 'Make', 'projects'); select(e.d, 'Frame shape', '9:16');
  e.library.mediaBlob.mockReturnValue(pending.promise); const run = e.d.make(); await vi.waitFor(() => expect(e.library.mediaBlob).toHaveBeenCalledOnce());
  if (how === 'close') e.d.close(); else e.store.openTimeline(e.target);
  pending.resolve(null); await run; expect(e.library.saveProject).not.toHaveBeenCalled();
});
it.each(['close', 'context', 'stop'])('stops after an already-started project save on %s', async how => {
  const e = setup(), pending = defer(); await e.d.search(); select(e.d, 'Make', 'projects'); select(e.d, 'Frame shape', 'keep');
  e.library.saveProject.mockReturnValueOnce(pending.promise); const run = e.d.make(); await vi.waitFor(() => expect(e.library.saveProject).toHaveBeenCalledOnce());
  if (how === 'close') e.d.close(); else if (how === 'context') e.store.openTimeline(e.target); else [...e.d.el.querySelectorAll('button')].find(b => b.textContent === 'Stop').click();
  pending.resolve(); await run; expect(e.library.saveProject).toHaveBeenCalledOnce(); expect(document.querySelector('.toast.success')).toBeNull();
});
it('suppresses errors from an already-started save after closing', async () => {
  const e = setup(), pending = defer(), errors = vi.spyOn(console, 'error').mockImplementation(() => {}); await e.d.search(); select(e.d, 'Make', 'projects'); select(e.d, 'Frame shape', 'keep');
  e.library.saveProject.mockReturnValueOnce(pending.promise); const run = e.d.make(); await vi.waitFor(() => expect(e.library.saveProject).toHaveBeenCalledOnce()); e.d.close();
  pending.reject(new Error('Late save failure')); await run; expect(errors).not.toHaveBeenCalled(); expect(document.querySelector('.toast.error')).toBeNull();
});
it('rejects search and make after manual close', async () => {
  const e = setup(); e.d.close(); await e.d.search(); await e.d.make(); expect(e.chat).not.toHaveBeenCalled(); expect(e.library.saveProject).not.toHaveBeenCalled();
});
it('keeps same-context edits and inserts compounds in one undo step', async () => {
  const e = setup(), pending = defer(); e.chat.mockReturnValueOnce(pending.promise); const run = e.d.search(); await vi.waitFor(() => expect(e.chat).toHaveBeenCalledOnce());
  e.store.update('Rename', p => { p.name = 'Renamed'; }); pending.resolve(reply); await run;
  expect(e.d.el.isConnected).toBe(true); expect(e.d.found).toHaveLength(2); const before = structuredClone(e.store.project.tracks);
  select(e.d, 'Make', 'here'); await e.d.make(); expect(e.store.selectedIds).toHaveLength(2); expect(e.store.project.name).toBe('Renamed');
  e.store.undo(); expect(e.store.project.tracks).toEqual(before); expect(e.store.project.name).toBe('Renamed');
});
it('saves both normal projects with their source asset and captions', async () => {
  const e = setup(); await e.d.search(); select(e.d, 'Make', 'projects'); select(e.d, 'Frame shape', 'keep'); await e.d.make();
  expect(e.library.saveProject).toHaveBeenCalledTimes(2);
  for (const [p] of e.library.saveProject.mock.calls) { expect(p.assets.vid).toEqual(e.store.project.assets.vid); expect(p.tracks.some(t => t.clips.some(c => c.type === 'text'))).toBe(true); }
  expect(e.d.el.isConnected).toBe(false);
});
it('preview stops at its endpoint and removes its player listener', async () => {
  const e = setup(); await e.d.search(); const btn = [...e.d.el.querySelectorAll('button')].find(b => b.textContent === 'Preview'); btn.click();
  expect(e.player.playing).toBe(true); e.store.seek(e.d.found[0].end); expect(e.player.playing).toBe(false); expect(e.listeners.size).toBe(0); expect(btn.getAttribute('aria-pressed')).toBe('false');
});
it.each(['close', 'context', 'stop'])('does not report success when the final save outlives %s', async how => {
  const e = setup(), pending = defer(); await e.d.search(); e.d.found[1].keep = false; select(e.d, 'Make', 'projects'); select(e.d, 'Frame shape', 'keep');
  e.library.saveProject.mockReturnValueOnce(pending.promise); const run = e.d.make(); await vi.waitFor(() => expect(e.library.saveProject).toHaveBeenCalledOnce());
  if (how === 'close') e.d.close(); else if (how === 'context') e.store.openTimeline(e.target); else [...e.d.el.querySelectorAll('button')].find(b => b.textContent === 'Stop').click();
  pending.resolve(); await run; expect(e.library.saveProject).toHaveBeenCalledOnce(); expect(document.querySelector('.toast.success')).toBeNull();
  if (how === 'stop') { expect(e.d.el.isConnected).toBe(true); expect(document.querySelector('.toast.info')?.textContent).toContain('Stopped after 1 project'); }
});
it('reports active search failures and allows retry', async () => {
  const e = setup(); vi.spyOn(console, 'error').mockImplementation(() => {}); e.chat.mockRejectedValueOnce(new Error('Search failed'));
  await e.d.search(); expect(document.querySelector('.toast.error')).not.toBeNull(); expect(e.d.el.dataset.step).toBe('options');
  await e.d.search(); expect(e.d.found).toHaveLength(2); expect(e.d.el.dataset.step).toBe('results');
});
