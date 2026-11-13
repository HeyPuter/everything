import { afterEach, expect, it, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { findClip } from '../src/model/timeline.js';
import { anchorWords } from '../src/media/transcript.js';
import { openHighlightsDialog } from '../src/ui/highlights-dialog.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture, clip, onMain } from './helpers.js';

const dialogs = [];
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const reply = '{"highlights":[{"title":"First","start":20,"end":59},{"title":"Second","start":100,"end":139}]}';
const select = (d, name, value) => { const el = d.el.querySelector(`[aria-label="${name}"]`); el.value = value; el.dispatchEvent(new Event('change')); };
const button = (d, text) => [...d.el.querySelectorAll('button')].find(b => b.textContent === text);
afterEach(() => { dialogs.splice(0).forEach(d => d.close()); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function setup({ curve = false } = {}) {
  setPref('highlights', { target: 'here', shape: 'keep', captions: 'yellow-caption' });
  const p = fixture(); p.assets.vid.duration = 300e6;
  const source = clip('video', 0, 120, curve ? { speedCurve: [{ t: 0, v: 1 }, { t: 1, v: 1 }] } : {}); onMain(p, source);
  p.transcript = { language: 'en', words: anchorWords(p, Array.from({ length: 240 }, (_, i) => ({ text: `w${i}${i % 10 === 9 ? '.' : ''}`, start: i * 500000, end: i * 500000 + 400000 }))) };
  const store = new EditorStore(p), library = { mediaBlob: vi.fn(async () => null), saveProject: vi.fn(async () => {}) }, chat = vi.fn(async () => reply), listeners = new Set();
  const player = { playing: false, play() { this.playing = true; }, pause() { this.playing = false; }, on(_, fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const ctx = { store, library, player }, d = openHighlightsDialog(ctx, { clipId: source.id, chat }); dialogs.push(d);
  return { d, store, source, library, chat, player, listeners, ctx };
}
const edits = {
  slip: (p, c) => { c.in += 20e6; }, trim: (p, c) => { c.duration -= 10e6; }, move: (p, c) => { c.start += 10e6; }, speed: (p, c) => { c.speed = 2; },
  curve: (p, c) => { c.speedCurve = [{ t: 0, v: .5 }, { t: 1, v: 1.5 }]; }, 'curve-point': (p, c) => { c.speedCurve[0].k = 2; }, freeze: (p, c) => { c.freeze = true; },
  replace: (p, c) => { p.assets.other = { ...p.assets.vid, id: 'other' }; c.assetId = 'other'; }, delete: (p, c) => { p.tracks[0].clips = p.tracks[0].clips.filter(x => x.id !== c.id); },
  'asset-delete': p => { delete p.assets.vid; }, 'asset-hash': p => { p.assets.vid.hash = 'new-media'; }, 'asset-ext': p => { p.assets.vid.ext = 'mp4'; }, 'asset-audio': p => { p.assets.vid.hasAudio = false; },
};
function edit(e, kind) { e.store.update(kind, p => { edits[kind](p, findClip(p, e.source.id).clip); }); }
it.each(Object.keys(edits))('discards pending results after changing the source: %s', async kind => {
  const e = setup({ curve: kind === 'curve-point' }), pending = defer(); e.chat.mockReturnValueOnce(pending.promise);
  const run = e.d.search(); await vi.waitFor(() => expect(e.chat).toHaveBeenCalledOnce()); edit(e, kind); const before = structuredClone(e.store.project.tracks);
  pending.resolve(reply); await run; await e.d.make();
  expect(e.store.project.tracks).toEqual(before); expect(e.d.el.isConnected).toBe(false); expect(e.d.found).toEqual([]);
});
it.each(['idle', 'results', 'preview'])('invalidates source edits during %s', async phase => {
  const e = setup(); if (phase !== 'idle') await e.d.search(); if (phase === 'preview') button(e.d, 'Preview').click(); edit(e, 'slip');
  const before = structuredClone(e.store.project.tracks), calls = e.chat.mock.calls.length; await e.d.search(); await e.d.make();
  expect(e.d.el.isConnected).toBe(false); expect(e.store.project.tracks).toEqual(before); expect(e.chat).toHaveBeenCalledTimes(calls); expect(e.player.playing).toBe(false); expect(e.listeners.size).toBe(0);
});
it('does not revive a pending job after a source edit is undone', async () => {
  const e = setup(), pending = defer(); e.chat.mockReturnValueOnce(pending.promise); const run = e.d.search(); await vi.waitFor(() => expect(e.chat).toHaveBeenCalledOnce());
  edit(e, 'slip'); e.store.undo(); const before = structuredClone(e.store.project.tracks); pending.resolve(reply); await run; await e.d.make();
  expect(e.store.project.tracks).toEqual(before); expect(e.d.el.isConnected).toBe(false);
});
it('ignores a late failure after the source is removed', async () => {
  const e = setup(), pending = defer(), errors = vi.spyOn(console, 'error').mockImplementation(() => {}); e.chat.mockReturnValueOnce(pending.promise); const run = e.d.search(); await vi.waitFor(() => expect(e.chat).toHaveBeenCalledOnce());
  edit(e, 'delete'); pending.reject(new Error('Old source failed')); await run; expect(errors).not.toHaveBeenCalled(); expect(document.querySelector('.toast.error')).toBeNull();
});
it('does not start saves after a source change during a media read', async () => {
  const e = setup(), pending = defer(); await e.d.search(); select(e.d, 'Make', 'projects'); select(e.d, 'Frame shape', '9:16'); e.library.mediaBlob.mockReturnValueOnce(pending.promise);
  const run = e.d.make(); await vi.waitFor(() => expect(e.library.mediaBlob).toHaveBeenCalledOnce()); edit(e, 'asset-hash'); pending.resolve(null); await run;
  expect(e.library.saveProject).not.toHaveBeenCalled(); expect(e.d.el.isConnected).toBe(false);
});
it('retains an already-started save but stops the batch after a source edit', async () => {
  const e = setup(), pending = defer(); await e.d.search(); select(e.d, 'Make', 'projects'); e.library.saveProject.mockReturnValueOnce(pending.promise);
  const run = e.d.make(); await vi.waitFor(() => expect(e.library.saveProject).toHaveBeenCalledOnce()); edit(e, 'slip'); pending.resolve(); await run;
  expect(e.library.saveProject).toHaveBeenCalledOnce(); expect(e.d.el.isConnected).toBe(false); expect(document.querySelector('.toast.success')).toBeNull();
});
it('reopening after a slip uses the newly placed anchored words', async () => {
  const e = setup(); await e.d.search(); edit(e, 'slip'); expect(e.d.el.isConnected).toBe(false);
  const d = openHighlightsDialog(e.ctx, { clipId: e.source.id, chat: e.chat }); dialogs.push(d); await d.search();
  expect(d.words[0].text).toBe('w40'); await d.make(); const comp = findClip(e.store.project, e.store.selectedIds[0]).clip;
  expect(comp.sequence.tracks.flatMap(t => t.clips).find(c => c.type === 'video').in).toBe(29.95e6);
  expect(comp.sequence.tracks.flatMap(t => t.clips).find(c => c.type === 'text').text).toContain('w60');
});
it('refreshes the clip reference after undo of a safe visual edit', async () => {
  const e = setup(); await e.d.search(); e.store.update('Opacity', p => { findClip(p, e.source.id).clip.opacity = .3; }); e.store.undo(); await e.d.make();
  const comp = findClip(e.store.project, e.store.selectedIds[0]).clip;
  expect(comp.sequence.tracks.flatMap(t => t.clips).find(c => c.type === 'video').opacity).toBe(1);
});
it.each(['rename', 'visual', 'lock', 'selection', 'equivalent-curve'])('preserves valid results during a safe edit: %s', async kind => {
  const e = setup({ curve: kind === 'equivalent-curve' }), pending = defer(); e.chat.mockReturnValueOnce(pending.promise); const run = e.d.search(); await vi.waitFor(() => expect(e.chat).toHaveBeenCalledOnce());
  if (kind === 'selection') e.store.select([]); else e.store.update(kind, p => {
    if (kind === 'rename') { p.name = 'Renamed'; p.assets.vid.name = 'Renamed source'; }
    if (kind === 'visual') { const c = findClip(p, e.source.id).clip; c.opacity = .6; c.transform.scale = 1.5; }
    if (kind === 'lock') p.tracks[0].locked = true;
    if (kind === 'equivalent-curve') findClip(p, e.source.id).clip.speedCurve = structuredClone(e.source.speedCurve);
  });
  pending.resolve(reply); await run; expect(e.d.el.isConnected).toBe(true); const before = structuredClone(e.store.project.tracks); await e.d.make(); expect(e.store.selectedIds).toHaveLength(2);
  if (kind === 'visual') { const c = findClip(e.store.project, e.store.selectedIds[0]).clip.sequence.tracks.flatMap(t => t.clips).find(c => c.type === 'video'); expect(c.opacity).toBe(.6); expect(c.transform.scale).toBe(1.5); }
  e.store.undo(); expect(e.store.project.tracks).toEqual(before);
});
