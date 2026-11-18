import { describe, it, expect } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createMulticam, flattenMulticam } from '../src/model/multicam-edit.js';
import { addClip, findClip, mainTrack } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { evaluate, audibleClips, gainAt } from '../src/engine/scene.js';

const FREE = { ripple: false, linkOverlays: false };
const picture = (p, t) => evaluate(p, t).map(l => l.clip.name);
const sound = (p, t) => audibleClips(p).filter(({ clip: c }) => c.start <= t && t < c.start + c.duration).map(({ clip: c }) => [c.assetId, gainAt(c, t)]).sort();
function setup(audio) {
  const p = fixture();
  const [a, later] = onMain(p, clip('video', 0, 4, { name: 'Angle A' }), clip('video', 4, 2, { name: 'Later base' }));
  const b = clip('video', 0, 4, { name: 'Angle B', assetId: 'silent' });
  addClip(p, b, FREE);
  const c = createMulticam(p, [a.id, b.id], FREE);
  c.multicam.audio = audio;
  c.multicam.cuts = [{ t: 0, angle: 0 }, { t: s(2), angle: 1 }];
  const title = clip('text', 0, 4, { name: 'Nested title' });
  const music = clip('audio', 0, 4, { name: 'Nested music' });
  addClip(c.sequence, title, FREE); addClip(c.sequence, music, FREE);
  const outside = clip('video', 0, 4, { name: 'Outside overlay' });
  addClip(p, outside, FREE);
  return { p, c, title, music, outside, later };
}

describe('multicamera flattening preserves tracks', () => {
  it.each(['none', 'outer mute', 'outer solo', 'outer hidden', 'inner hidden', 'inner mute', 'inner solo', 'inner title hidden'].flatMap(state => [0, 'follow'].map(audio => ({ state, audio }))))('keeps scene, sound, and stacking for $state (audio: $audio)', ({ state, audio }) => {
    const { p, c, title, music, outside, later } = setup(audio);
    if (state === 'outer mute') mainTrack(p).muted = true;
    if (state === 'outer solo') mainTrack(p).solo = true;
    if (state === 'outer hidden') mainTrack(p).hidden = true;
    if (state === 'inner hidden') c.sequence.tracks.find(t => t.angle).hidden = true;
    if (state === 'inner mute') c.sequence.tracks.find(t => t.angle).muted = true;
    if (state === 'inner solo') findClip(c.sequence, music.id).track.solo = true;
    if (state === 'inner title hidden') findClip(c.sequence, title.id).track.hidden = true;
    const store = new EditorStore(p);
    const times = [0.5, 1.5, 2.5, 3.5, 4.5].map(s);
    const expected = times.map(t => ({ picture: picture(store.project, t), sound: sound(store.project, t) }));
    const outsideTrack = { ...findClip(store.project, outside.id).track, clips: undefined };
    store.update('Flatten', q => { flattenMulticam(q, c.id); });
    const check = q => times.forEach((t, i) => {
      expect(picture(q, t)).toEqual(expected[i].picture);
      expect(sound(q, t)).toEqual(expected[i].sound);
    });
    check(store.project);
    check(normalizeProject(JSON.parse(JSON.stringify(store.projectForSave()))));
    expect({ ...findClip(store.project, outside.id).track, clips: undefined }).toEqual(outsideTrack);
    expect(findClip(store.project, later.id).clip.start).toBe(s(4));
    store.undo(); check(store.project);
    store.redo(); check(store.project);
  });

  it('preserves locked inner tracks and their names and heights', () => {
    const { p, c, title } = setup(0);
    Object.assign(findClip(c.sequence, title.id).track, { locked: true, name: 'Titles', size: 'large' });
    const made = flattenMulticam(p, c.id);
    const restored = made.find(x => x.name === 'Nested title');
    expect(findClip(p, restored.id).track).toMatchObject({ locked: true, name: 'Titles', size: 'large' });
  });

  it('keeps titles placed between camera tracks between their flattened pictures', () => {
    const { p, c, title } = setup('follow');
    const titleTrack = findClip(c.sequence, title.id).track;
    c.sequence.tracks.splice(c.sequence.tracks.indexOf(titleTrack), 1);
    c.sequence.tracks.splice(1, 0, titleTrack);
    const before = [s(1), s(3)].map(t => picture(p, t));
    flattenMulticam(p, c.id);
    expect([s(1), s(3)].map(t => picture(p, t))).toEqual(before);
  });
  it('keeps titles above every angle when a middle angle needs a different mute track', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4, { name: 'A' }));
    const b = clip('video', 0, 4, { name: 'B' });
    const d = clip('video', 0, 4, { name: 'C' });
    addClip(p, b, FREE); addClip(p, d, FREE);
    const c = createMulticam(p, [a.id, b.id, d.id], FREE);
    c.multicam.audio = 'follow';
    c.multicam.cuts = [{ t: 0, angle: 0 }, { t: s(1), angle: 1 }, { t: s(2), angle: 2 }];
    c.sequence.tracks[1].muted = true;
    addClip(c.sequence, clip('text', 0, 4, { name: 'Title' }), FREE);
    const times = [0.5, 1.5, 2.5].map(s);
    const before = times.map(t => ({ picture: picture(p, t), sound: sound(p, t) }));
    flattenMulticam(p, c.id);
    expect(times.map(t => ({ picture: picture(p, t), sound: sound(p, t) }))).toEqual(before);
  });

});
