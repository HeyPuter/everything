import { it, expect, vi, afterEach } from 'vitest';
import { captionsTab } from '../src/ui/panels/captions.js';
import { EditorStore } from '../src/model/store.js';
import { makeClip, makeTrack, normalizeProject } from '../src/model/project.js';
import { findClip } from '../src/model/timeline.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture, clip } from './helpers.js';
const tabs = [];
afterEach(() => { tabs.splice(0).forEach(t => t.dispose()); document.querySelectorAll('.dialog-close').forEach(b => b.click()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); delete globalThis.puter; vi.restoreAllMocks(); });
const button = (el, label) => [...el.querySelectorAll('button')].find(b => b.textContent.trim() === label);
const captions = p => p.tracks.flatMap(t => t.clips).filter(c => c.caption);
function setup(type = 'audio') {
  const p = fixture(), song = clip(type, 0, 2);
  p.tracks.push(makeTrack(type, { clips: [song] }), makeTrack('text', { clips: [makeClip('text', { text: 'Keep these captions', caption: true, duration: 1000000 })] }));
  const store = new EditorStore(p), work = { phase: 'transcribe', finish: null, fail: null, signal: null };
  const wait = () => new Promise((r, j) => { work.finish = r; work.fail = j; });
  const deps = {
    decode: vi.fn(async (_a, _c, o) => { work.signal = o.signal; if (work.phase === 'decode') await wait(); return { sampleRate: 8000, channels: [new Float32Array(16000)] }; }),
    transcribe: vi.fn(async () => { if (work.phase === 'transcribe') await wait(); return [{ text: 'Fresh', start: .25, end: .5 }]; }),
    beats: () => null,
  };
  globalThis.puter = { ai: {} }; setPref('captionOpts', { lyricsIsolate: false });
  const tab = captionsTab({ store, player: null, library: { backend: { kind: 'puter' } }, lyricsDeps: deps }); tabs.push(tab); document.body.append(tab.el); tab.el.querySelector('[data-cat=lyrics]').click();
  return { store, tab, work, deps, id: song.id, create: button(tab.el, 'Create lyrics') };
}
async function start(x) {
  x.create.click(); button(document.querySelector('dialog[open]'), 'Replace').click();
  await vi.waitFor(() => expect(x.work.finish).toBeTypeOf('function'));
}
const changes = {
  move: (p, c) => { c.start = 2000000; },
  trim: (p, c) => { c.in = 500000; c.duration = 1000000; },
  extend: (p, c) => { c.duration = 4000000; },
  speed: (p, c) => { c.speed = 2; },
  curve: (p, c) => { c.speedCurve = [{ t: 0, v: 1 }, { t: 1, v: 2 }]; },
  relink: (p, c) => { p.assets[c.assetId].hash = 'replacement'; },
  replace: (p, c) => { p.assets.other = { ...p.assets[c.assetId], id: 'other' }; c.assetId = 'other'; },
  delete: (p, c) => { const f = findClip(p, c.id); f.track.clips = []; },
  freeze: (p, c) => { c.freeze = true; },
  detach: (p, c) => { c.audioDetached = true; },
};
it.each(Object.keys(changes))('cancels obsolete lyrics after song %s without replacing existing captions', async change => {
  const x = setup(['freeze', 'detach'].includes(change) ? 'video' : 'audio'); await start(x);
  x.store.update(change, p => changes[change](p, findClip(p, x.id).clip));
  const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length, aborted = x.work.signal.aborted;
  x.work.finish(); await new Promise(r => setTimeout(r, 0));
  expect(aborted).toBe(true); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(history);
  expect(document.body.textContent).toContain('Lyrics cancelled because the song changed'); expect(document.querySelector('.toast.success')).toBeNull();
});
it.each(['resolve', 'reject'])('stops obsolete decoding before transcription after late %s', async how => {
  const x = setup(); x.work.phase = 'decode'; await start(x);
  x.store.update('Relink', p => { p.assets.aud.hash = 'replacement'; });
  const idle = !x.create.disabled;
  if (how === 'resolve') x.work.finish(); else x.work.fail(new Error('Obsolete audio failed'));
  await new Promise(r => setTimeout(r, 0));
  expect(idle).toBe(true); expect(x.deps.transcribe).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain('Obsolete audio failed');
  expect(captions(x.store.project)[0].text).toBe('Keep these captions');
});
it('closes the pending replacement prompt if its song changes', async () => {
  const x = setup(); x.create.click(); const dialog = document.querySelector('dialog[open]');
  x.store.update('Move', p => changes.move(p, findClip(p, x.id).clip));
  expect(dialog.open).toBe(false); await new Promise(r => setTimeout(r, 0)); expect(x.deps.decode).not.toHaveBeenCalled();
});
it('does not revive old lyrics when the same project is reloaded', async () => {
  const x = setup(); await start(x); x.store.load(structuredClone(x.store.project));
  x.work.finish(); await new Promise(r => setTimeout(r, 0)); expect(captions(x.store.project).map(c => c.text)).toEqual(['Keep these captions']); expect(x.store.history.undoStack).toHaveLength(0);
});
it('allows a fresh retry at the moved song time, with undo and reopening', async () => {
  const x = setup(); await start(x); x.store.update('Move', p => changes.move(p, findClip(p, x.id).clip));
  x.work.finish(); await new Promise(r => setTimeout(r, 0)); expect(x.store.history.undoStack).toHaveLength(1);
  x.work.phase = ''; x.create.click(); button(document.querySelector('dialog[open]'), 'Replace').click();
  await vi.waitFor(() => expect(captions(x.store.project)[0].text).toBe('Fresh'));
  expect(captions(x.store.project)[0].start).toBe(2250000);
  const saved = structuredClone(captions(x.store.project)); x.store.undo(); expect(captions(x.store.project)[0].text).toBe('Keep these captions');
  x.store.redo(); expect(captions(normalizeProject(x.store.projectForSave()))).toEqual(saved);
});
it('allows unrelated edits, raw-source mix changes, and selection changes', async () => {
  const x = setup(); await start(x); x.store.update('Compatible edits', p => {
    const c = findClip(p, x.id).clip; c.name = 'Song label'; c.volume = .3; c.muted = true; c.transform = { x: .2 }; p.assets[c.assetId].name = 'Media label'; p.name = 'Project label';
  }); x.store.clearSelection(); x.work.finish();
  await vi.waitFor(() => expect(captions(x.store.project)[0].text).toBe('Fresh')); expect(x.store.history.undoStack).toHaveLength(2); expect(findClip(x.store.project, x.id).clip.volume).toBe(.3);
});
