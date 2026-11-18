import { it, expect, vi } from 'vitest';
import { createAvatar } from '../src/ui/avatar-actions.js';
import { EditorStore } from '../src/model/store.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { findClip } from '../src/model/timeline.js';
import { encodeLips } from '../src/media/lipsync.js';
import { fixture, clip } from './helpers.js';

const lips = encodeLips({ rate: 50, frames: 2, open: [.2, .4], wide: [0, 0], round: [0, 0], fric: [0, 0], beats: [] });
function setup(locked = false, grouped = false) {
  const p = fixture(), voice = clip('audio', 1, 2), sibling = clip('audio', 4, 1);
  if (grouped) voice.group = sibling.group = 'existing-group';
  const track = makeTrack('audio', { locked, clips: [voice, sibling] }); p.tracks.push(track);
  const store = new EditorStore(p); let finish;
  const analyze = vi.fn(() => new Promise(r => { finish = () => r(lips); }));
  const ctx = { store, avatarServices: { analyze } };
  const result = createAvatar(ctx, { voiceClipId: voice.id, seed: 7 });
  return { store, result, track, voice, analyze, finish: () => finish() };
}
async function check(e, grouped) {
  const source = findClip(e.store.project, e.voice.id), before = structuredClone(source.track);
  const history = e.store.history.undoStack.length;
  e.finish(); const made = await e.result;
  expect(made.type).toBe('avatar'); expect(made.avatar.lips).toEqual(lips);
  expect(made.start).toBe(source.clip.start); expect(made.duration).toBe(source.clip.duration);
  expect(made.avatar.voiceAsset).toBe(source.clip.assetId);
  if (grouped) { expect(made.group).toBeTruthy(); expect(source.clip.group).toBe(made.group); }
  else { expect(source.track).toEqual(before); expect(made.group).toBeUndefined(); }
  expect(e.store.project.tracks.flatMap(t => t.clips).filter(c => c.type === 'audio')).toHaveLength(2);
  expect(e.store.history.undoStack).toHaveLength(history + 1);
  const saved = structuredClone(e.store.projectForSave());
  e.store.undo(); expect(findClip(e.store.project, made.id)).toBeNull();
  expect(findClip(e.store.project, e.voice.id).track).toEqual(before);
  e.store.redo(); expect(e.store.projectForSave().tracks).toEqual(saved.tracks);
  expect(e.store.projectForSave().assets).toEqual(saved.assets);
  expect(findClip(normalizeProject(saved), made.id).clip).toEqual(made);
}
it('reads a locked voice without modifying its track or grouping the source', async () => {
  await check(setup(true), false);
});
it('preserves a voice track locked while lip analysis runs', async () => {
  const e = setup(); e.store.update('Lock voice', () => { e.track.locked = true; }); await check(e, false);
});
it('preserves the destination when the voice moves to a locked track during analysis', async () => {
  const e = setup(); e.store.update('Move voice', p => {
    e.track.clips = e.track.clips.filter(c => c.id !== e.voice.id);
    p.tracks.push(makeTrack('audio', { locked: true, clips: [e.voice] })); e.voice.start = 3000000;
  }); await check(e, false);
});
it('keeps existing locked voice groups intact', async () => {
  await check(setup(true, true), false);
});
it('still groups a new avatar with an unlocked voice', async () => {
  await check(setup(), true);
});
it('uses the latest lock state when a voice is unlocked during analysis', async () => {
  const e = setup(true); e.store.update('Unlock voice', () => { e.track.locked = false; }); await check(e, true);
});
