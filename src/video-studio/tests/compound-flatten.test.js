import { describe, it, expect } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createCompound, breakApart } from '../src/model/compound.js';
import { addClip, findClip, mainTrack } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { evaluate, audibleClips } from '../src/engine/scene.js';

const FREE = { ripple: false, linkOverlays: false };
const picture = p => evaluate(p, s(1)).filter(l => l.opacity !== 0).map(l => l.clip.name);
const sound = p => audibleClips(p).map(x => x.clip.name).sort();

function setup() {
  const p = fixture();
  const [video] = onMain(p, clip('video', 0, 4, { name: 'inner video' }));
  const title = clip('text', 0, 4, { name: 'inner title' });
  const music = clip('audio', 0, 4, { name: 'inner music' });
  const overlay = clip('video', 0, 4, { name: 'outside video' });
  const outside = clip('audio', 0, 4, { name: 'outside music' });
  for (const c of [title, music, overlay, outside]) addClip(p, c, FREE);
  const store = new EditorStore(p);
  let comp;
  store.update('Nest', q => { comp = createCompound(q, [video.id, title.id, music.id], FREE); });
  return { store, comp, video, title, music, overlay, outside };
}

describe('breaking apart track controls', () => {
  it.each(['none', 'inner hidden', 'inner mute', 'inner solo', 'outer hidden/mute', 'outer solo', 'base hidden'])('preserves picture, stacking and sound with %s', state => {
    const { store, comp, video, title, music, overlay, outside } = setup();
    store.update('Set controls', p => {
      const c = findClip(p, comp.id).clip;
      if (state === 'inner hidden') findClip(c.sequence, title.id).track.hidden = true;
      if (state === 'inner mute') findClip(c.sequence, music.id).track.muted = true;
      if (state === 'inner solo') findClip(c.sequence, music.id).track.solo = true;
      if (state === 'outer hidden/mute') Object.assign(mainTrack(p), { hidden: true, muted: true });
      if (state === 'outer solo') mainTrack(p).solo = true;
      if (state === 'base hidden') {
        mainTrack(c.sequence).hidden = true;
        findClip(c.sequence, video.id).clip.keyframes.opacity = [{ t: 0, v: 1, ease: 'linear' }, { t: s(4), v: 0.5, ease: 'linear' }];
      }
    }, { structural: false });
    const before = { picture: picture(store.project), sound: sound(store.project) };
    const outsideTracks = [overlay, outside].map(c => ({ ...findClip(store.project, c.id).track, clips: undefined }));
    store.update('Break apart', p => { breakApart(p, comp.id, FREE); });
    expect(picture(store.project)).toEqual(before.picture);
    expect(sound(store.project)).toEqual(before.sound);
    if (state === 'base hidden') {
      const restored = store.project.tracks.flatMap(t => t.clips.map(c => ({ track: t, clip: c }))).find(x => x.clip.name === 'inner video');
      expect(restored.track.hidden).toBe(true);
      expect(restored.clip.keyframes.opacity.map(k => k.v)).toEqual([1, 0.5]);
    }

    expect([overlay, outside].map(c => ({ ...findClip(store.project, c.id).track, clips: undefined }))).toEqual(outsideTracks);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(store.projectForSave())));
    expect(picture(loaded)).toEqual(before.picture);
    expect(sound(loaded)).toEqual(before.sound);
    store.undo();
    expect(picture(store.project)).toEqual(before.picture);
    store.redo();
    expect(picture(store.project)).toEqual(before.picture);
    expect(sound(store.project)).toEqual(before.sound);
  });
});

describe('breaking apart timing', () => {
  it('retains gaps and later base clips with ripple editing enabled', () => {
    const p = fixture();
    const [video, later] = onMain(p, clip('video', 1, 2, { name: 'video' }), clip('video', 4, 2, { name: 'later' }));
    const title = clip('text', 0, 4, { name: 'title' });
    addClip(p, title, FREE);
    const c = createCompound(p, [video.id, title.id], FREE);
    const times = [0.5, 1.5, 3.5, 4.5];
    const before = times.map(t => evaluate(p, s(t)).map(l => l.clip.name));
    breakApart(p, c.id, { ripple: true, linkOverlays: true });
    expect(times.map(t => evaluate(p, s(t)).map(l => l.clip.name))).toEqual(before);
    expect(findClip(p, later.id).clip.start).toBe(s(4));
    expect(mainTrack(p).clips.map(c => [c.start, c.duration])).toEqual([[s(1), s(2)], [s(4), s(2)]]);
  });

  it('restores nested compounds to the base track without moving following clips', () => {
    const p = fixture();
    const [video, later] = onMain(p, clip('video', 0, 2, { name: 'video' }), clip('video', 2, 2, { name: 'later' }));
    const inner = createCompound(p, [video.id], FREE);
    const outer = createCompound(p, [inner.id], FREE);
    const before = [0.5, 2.5].map(t => evaluate(p, s(t)).map(l => l.clip.name));
    breakApart(p, outer.id, { ripple: true, linkOverlays: true });
    expect(mainTrack(p).clips.map(c => c.type)).toEqual(['compound', 'video']);
    expect(findClip(p, later.id).clip.start).toBe(s(2));
    expect([0.5, 2.5].map(t => evaluate(p, s(t)).map(l => l.clip.name))).toEqual(before);
  });
});
