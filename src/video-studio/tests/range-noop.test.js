import { it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { removeRanges } from '../src/ui/panels/transcript.js';
import { removeRange, mainTrack } from '../src/model/timeline.js';
import { fixture, clip, onMain, s } from './helpers.js';
vi.mock('../src/media/transcribe.js', async original => ({ ...await original(), mixdown: async () => {
  const data = new Float32Array(32000); for (let i = 0; i < data.length; i++) if (i < 8000 || i >= 24000) data[i] = .5 * Math.sin(i * .3); return data;
} }));
afterEach(() => { document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); vi.restoreAllMocks(); });
it.each(['locked', 'past-end', 'tiny'])('does not create history for a %s range that changes nothing', how => {
  const p = fixture(); onMain(p, clip('video', 0, 4)); if (how === 'locked') mainTrack(p).locked = true;
  const store = new EditorStore(p), before = JSON.stringify(store.projectForSave());
  const range = how === 'past-end' ? { start: s(5), end: s(6) } : how === 'tiny' ? { start: s(1), end: s(1) + 10 } : { start: s(1), end: s(3) };
  expect(removeRanges(store, [range], 'Cut')).toBe(false); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(store.revision).toBe(0);
});
it.each(['clip', 'marker', 'range', 'word'])('preserves undoable %s movement when no clip is removed', kind => {
  const p = fixture(); if (kind === 'clip') onMain(p, clip('video', 5, 2));
  if (kind === 'marker') p.markers.push({ id: 'm', time: s(5), label: 'Marker', color: '#ffffff' });
  if (kind === 'range') p.range = { in: s(5), out: s(6) };
  if (kind === 'word') p.transcript = { words: [{ text: 'Later', start: s(5), end: s(6) }] };
  const store = new EditorStore(p), value = () => kind === 'clip' ? mainTrack(store.project).clips[0].start : kind === 'marker' ? store.project.markers[0].time : kind === 'range' ? store.project.range.in : store.project.transcript.words[0].start;
  expect(removeRanges(store, [{ start: s(1), end: s(3) }], 'Close gap')).toBe(true); expect(value()).toBe(s(3)); expect(store.history.undoStack).toHaveLength(1); store.undo(); expect(value()).toBe(s(5)); store.redo(); expect(value()).toBe(s(3));
});
it('keeps the existing removed-clip count while reporting marker-only changes', () => {
  const p = fixture(); p.markers.push({ id: 'm', time: s(2) }); const changed = vi.fn();
  expect(removeRange(p, s(1), s(3), { onChange: changed })).toBe(0); expect(changed).toHaveBeenCalledOnce(); expect(p.markers).toHaveLength(0);
});
it('retains splits that alter a boundary even when no whole clip is removed', () => {
  const p = fixture(); onMain(p, clip('video', 0, 4)); const store = new EditorStore(p);
  expect(removeRanges(store, [{ start: s(2), end: s(2) + 1000 }], 'Small cut')).toBe(true); expect(mainTrack(store.project).clips.length).toBeGreaterThan(1); expect(store.history.undoStack).toHaveLength(1);
});
async function openLocked(locked = true) {
  const p = fixture(); onMain(p, clip('video', 0, 4)); mainTrack(p).locked = locked;
  const store = new EditorStore(p), ctx = { store, library: {} }; ctx.actions = createActions(ctx); await ctx.actions.removeSilences(); const dialog = document.querySelector('dialog[open]'), button = text => [...dialog.querySelectorAll('button')].find(b => b.textContent === text);
  button('Find silences').click(); await vi.waitFor(() => expect(button('Find silences').disabled).toBe(false)); return { store, dialog, button };
}
it('keeps the silence dialog open without history or success when all affected clips are locked', async () => {
  const { store, dialog, button } = await openLocked(), before = JSON.stringify(store.projectForSave()); button('Cut them').click();
  expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0); expect(dialog.open).toBe(true); expect(document.body.textContent).not.toContain('Removed 1'); expect(dialog.textContent).toContain('No silence cuts were applied');
  store.update('Unlock', p => { mainTrack(p).locked = false; }); button('Find silences').click(); await vi.waitFor(() => expect(button('Find silences').disabled).toBe(false)); button('Cut them').click();
  expect(store.history.undoStack).toHaveLength(2); expect(mainTrack(store.project).clips.reduce((n,c) => n+c.duration,0)).toBe(2240000); expect(dialog.open).toBe(false);
});
it('does not announce success or close when a silence transaction is refused', async () => {
  const { store, dialog, button } = await openLocked(false); vi.spyOn(store, 'update').mockReturnValue(false); button('Cut them').click();
  expect(store.history.undoStack).toHaveLength(0); expect(dialog.open).toBe(true); expect(document.body.textContent).not.toContain('Removed 1'); expect(dialog.textContent).toContain('No silence cuts were applied');
});

it('does not record unchanged markers, ranges or anchored transcript words', () => {
  const p = fixture(); onMain(p, clip('video', 0, 4)); mainTrack(p).locked = true;
  p.markers.push({ id: 'm', time: 0 }); p.range = { in: 0, out: s(.5) };
  p.transcript = { words: [{ text: 'Before', start: 0, end: s(.5) }, { text: 'Anchored', start: s(5), end: s(6), a: { clipId: mainTrack(p).clips[0].id } }] };
  const store = new EditorStore(p), before = JSON.stringify(store.projectForSave());
  expect(removeRanges(store, [{ start: s(1), end: s(3) }], 'Cut')).toBe(false); expect(JSON.stringify(store.projectForSave())).toBe(before); expect(store.history.undoStack).toHaveLength(0);
});
it.each(['range', 'word'])('preserves a %s deletion even with no editable clips', kind => {
  const p = fixture(); if (kind === 'range') p.range = { in: s(1.2), out: s(1.5) }; else p.transcript = { words: [{ text: 'Inside', start: s(1.2), end: s(1.5) }] };
  const store = new EditorStore(p); expect(removeRanges(store, [{ start: s(1), end: s(3) }], 'Cut')).toBe(true);
  if (kind === 'range') expect(store.project.range).toBeUndefined(); else expect(store.project.transcript.words).toHaveLength(0);
  expect(store.history.undoStack).toHaveLength(1); store.undo(); if (kind === 'range') expect(store.project.range.in).toBe(s(1.2)); else expect(store.project.transcript.words).toHaveLength(1);
});
