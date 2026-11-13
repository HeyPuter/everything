import { afterEach, expect, it } from 'vitest';
import { defaultAudioFx } from '../src/model/audio.js';
import { EditorStore } from '../src/model/store.js';
import { detachAudio, findClip } from '../src/model/timeline.js';
import { audibleClips } from '../src/engine/scene.js';
import { anchorWords } from '../src/media/transcript.js';
import { highlightClip } from '../src/media/highlights.js';
import { openHighlightsDialog } from '../src/ui/highlights-dialog.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture, clip, onMain } from './helpers.js';
const dialogs = [];
afterEach(() => { dialogs.splice(0).forEach(d => d.close()); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); });
function setup({ detached = true, speed = 1 } = {}) {
  const p = fixture(); p.assets.vid.duration = 400e6; const c = clip('video', 0, 120, { speed, volume: .65, audioFx: { ...defaultAudioFx(), pan: { on: true, value: 25 } }, keepPitch: false }); onMain(p, c);
  const audio = detached ? detachAudio(p, c.id) : null;
  p.transcript = { words: anchorWords(p, Array.from({ length: 240 }, (_, i) => ({ text: `word${i}${i % 10 === 9 ? '.' : ''}`, start: i * 500000, end: i * 500000 + 400000 }))) };
  return { p, c, audio };
}
it.each(['here', 'projects'])('includes original source sound in a standalone highlight after Detach audio: %s', async target => {
  const { p, c } = setup(); expect(audibleClips(p)).toHaveLength(1);
  setPref('highlights', { target, shape: 'keep', captions: 'yellow-caption' }); const store = new EditorStore(p), saved = [], d = openHighlightsDialog({ store, library: { saveProject: async p => saved.push(p) } }, { chat: async () => '{"highlights":[{"title":"First","start":20,"end":59}]}' }); dialogs.push(d); const before = structuredClone(store.project);
  await d.search(); const h = d.found[0]; await d.make(); const short = target === 'projects' ? saved[0] : { ...store.project, tracks: findClip(store.project, store.selectedIds[0]).clip.sequence.tracks };
  const audible = audibleClips(short); expect(audible).toHaveLength(1); const out = audible[0].clip;
  expect(out).toMatchObject({ type: 'video', assetId: c.assetId, muted: false, volume: .65, keepPitch: false, start: 0, in: h.start, duration: h.end - h.start });
  expect(out.audioDetached).toBeFalsy(); expect(out.audioFx).toEqual(c.audioFx); expect(short.tracks.some(t => t.clips.some(c => c.type === 'text'))).toBe(true);
  if (target === 'here') store.undo(); expect({ ...store.project, modified: 0 }).toEqual({ ...before, modified: 0 });
});
it.each([.5, 1, 2])('restores detached source audio at speed %s without changing source edits', speed => {
  const { c, audio } = setup({ speed }), before = structuredClone(c), detachedBefore = structuredClone(audio), h = { start: 10e6, end: 30e6 };
  c.keyframes = { volume: [{ t: 0, v: .5 }, { t: 120e6, v: 1 }] }; before.keyframes = structuredClone(c.keyframes);
  const out = highlightClip(c, h);
  expect(out).toMatchObject({ muted: false, audioDetached: false, speed, start: 0, in: 10e6 * speed, duration: 20e6, volume: .65, keepPitch: false });
  expect(out.audioFx).toEqual(c.audioFx); expect(out.keyframes.volume.length).toBeGreaterThan(0); expect(c).toEqual(before); expect(audio).toEqual(detachedBefore);
});
it('restores detached audio for a clip with a speed curve', () => {
  const { c } = setup(); c.speedCurve = [{ t: 0, v: 1, k: 'linear' }, { t: 120e6, v: 2, k: 'linear' }];
  const detached = highlightClip(c, { start: 10e6, end: 30e6 }), attached = highlightClip({ ...c, audioDetached: false, muted: false }, { start: 10e6, end: 30e6 });
  expect({ ...detached, id: '' }).toEqual({ ...attached, id: '' });
});
it('does not force sound on for an ordinary intentionally muted video', () => {
  const { c } = setup({ detached: false }); c.muted = true; const out = highlightClip(c, { start: 10e6, end: 30e6 }); expect(out.muted).toBe(true); expect(out.audioDetached).toBeFalsy();
});
it('preserves normal audio settings, intentional zero volume and visual edits', () => {
  const { c } = setup({ detached: false }); Object.assign(c, { volume: 0, opacity: .4, transform: { x: 10, y: 20, scale: .8 }, audioFx: { ...defaultAudioFx(), channel: { on: true, mode: 'mono' } } });
  const out = highlightClip(c, { start: 10e6, end: 30e6 }); expect(out).toMatchObject({ volume: 0, opacity: .4, transform: c.transform, audioFx: c.audioFx });
});
