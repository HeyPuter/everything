import { describe, it, expect } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createCompound, breakApart } from '../src/model/compound.js';
import { addClip, findClip, mainTrack, moveClip, splitClip, trimClip, toggleSolo } from '../src/model/timeline.js';
import { normalizeProject, makeTrack } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { evaluate, audibleClips, gainAt } from '../src/engine/scene.js';

const FREE = { ripple: false, linkOverlays: false };
const RIPPLE = { ripple: true, linkOverlays: true };
const snap = (p, t) => ({
  picture: evaluate(p, t).map(l => [l.clip.name, l.x, l.y, l.opacity]),
  sound: audibleClips(p).filter(({ clip: c }) => c.start <= t && t < c.start + c.duration).map(({ clip: c }) => [c.name, gainAt(c, t)]).sort(),
});
function setup(state) {
  const p = fixture();
  const [base, later] = onMain(p, clip('video', 0, 4, { name: 'Base' }), clip('video', 4, 3, { name: 'Later base' }));
  const overlay = clip('video', 0, 4, { name: 'Overlay' });
  const laterOverlay = clip('video', 5, 2, { name: 'Later overlay' });
  const { track } = addClip(p, overlay, FREE);
  track.clips.push(laterOverlay);
  if (state === 'base hidden') mainTrack(p).hidden = true;
  if (state === 'base muted') mainTrack(p).muted = true;
  if (state === 'overlay solo') track.solo = true;
  if (state === 'base solo') mainTrack(p).solo = true;
  if (state === 'both solo') { mainTrack(p).solo = true; track.solo = true; }
  if (state === 'outside solo') {
    const audio = makeTrack('audio', { solo: true, clips: [clip('audio', 0, 7, { name: 'Outside music' })] });
    p.tracks.push(audio);
  }
  return { p, base, later, overlay, laterOverlay };
}

describe('track controls when creating a compound', () => {
  it.each(['base hidden', 'base muted', 'overlay solo', 'base solo', 'both solo', 'outside solo'].flatMap(state => [FREE, RIPPLE].map(opts => ({ state, opts }))))('keeps playback for $state (ripple $opts.ripple)', ({ state, opts }) => {
    const { p, base, overlay, later, laterOverlay } = setup(state);
    const store = new EditorStore(p);
    const times = [0.5, 2.5, 4.5, 5.5].map(s);
    const before = times.map(t => snap(store.project, t));
    const controls = [later, laterOverlay].map(c => ({ ...findClip(p, c.id).track, clips: undefined }));
    let made;
    store.update('Group', q => { made = createCompound(q, [base.id, overlay.id], opts); });
    expect(times.map(t => snap(store.project, t))).toEqual(before);
    expect(findClip(store.project, later.id).clip.start).toBe(s(4));
    expect([later, laterOverlay].map(c => ({ ...findClip(store.project, c.id).track, clips: undefined }))).toEqual(controls);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(store.projectForSave())));
    expect(times.map(t => snap(loaded, t))).toEqual(before);
    store.undo(); expect(times.map(t => snap(store.project, t))).toEqual(before);
    store.redo(); expect(times.map(t => snap(store.project, t))).toEqual(before);
    expect(findClip(store.project, made.id)).toBeTruthy();
  });

  it('keeps a soloed group audible after the former solo track becomes empty', () => {
    const { p, base, overlay, laterOverlay } = setup('overlay solo');
    findClip(p, laterOverlay.id).track.clips = [overlay];
    const before = snap(p, s(1));
    const c = createCompound(p, [base.id, overlay.id], FREE);
    expect(snap(p, s(1))).toEqual(before);
    expect(findClip(p, c.id).track.solo).toBe(true);
    const source = c.sequence.tracks.find(t => t.solo);
    expect(source.clips[0].name).toBe('Overlay');
    toggleSolo(c.sequence, source.id);
    expect(snap(normalizeProject(JSON.parse(JSON.stringify(p))), s(1)).sound.map(x => x[0]).sort()).toEqual(['Base', 'Overlay']);
  });

  it('does not put a text-only group on a hidden or muted unrelated video track', () => {
    const p = fixture();
    const { track } = addClip(p, clip('video', 6, 2), FREE);
    track.hidden = true; track.muted = true;
    const title = clip('text', 0, 4, { name: 'Title' });
    addClip(p, title, FREE);
    const before = snap(p, s(1));
    createCompound(p, [title.id], FREE);
    expect(snap(p, s(1))).toEqual(before);
    expect(track.hidden).toBe(true); expect(track.muted).toBe(true);
  });

  it('lets a separately placed group move, split, trim, and break apart without changing its contents', () => {
    const { p, base, overlay } = setup('base muted');
    const expected = snap(p, s(1));
    const c = createCompound(p, [base.id, overlay.id], RIPPLE);
    const host = findClip(p, c.id).track;
    expect(Boolean(host.main)).toBe(false);
    moveClip(p, c.id, { start: s(8), trackId: host.id }, FREE);
    const right = splitClip(p, c.id, s(10));
    trimClip(p, right.id, 'start', s(10.25), FREE);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(snap(loaded, s(9))).toEqual(expected);
    expect(snap(loaded, s(11))).toEqual(expected);
    breakApart(loaded, right.id, FREE);
    expect(snap(loaded, s(11))).toEqual(expected);
  });
  it('preserves audio-only solo groups and the silence of unrelated base clips', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 7, { name: 'Base' }));
    const music = clip('audio', 0, 4, { name: 'Music' });
    addClip(p, music, FREE).track.solo = true;
    const store = new EditorStore(p);
    const before = snap(store.project, s(1));
    let c;
    store.update('Group music', q => { c = createCompound(q, [music.id], RIPPLE); });
    expect(snap(store.project, s(1))).toEqual(before);
    expect(findClip(store.project, c.id).track.solo).toBe(true);
    expect(snap(normalizeProject(JSON.parse(JSON.stringify(store.projectForSave()))), s(1))).toEqual(before);
  });

  it('keeps the new group responsive to its own outer hide and mute controls', () => {
    const { p, base, overlay } = setup('base hidden');
    const store = new EditorStore(p);
    let c;
    store.update('Group', q => { c = createCompound(q, [base.id, overlay.id], FREE); });
    const before = snap(store.project, s(1));
    store.update('Hide and mute group', q => { Object.assign(findClip(q, c.id).track, { hidden: true, muted: true }); });
    expect(snap(store.project, s(1))).toEqual({ picture: [], sound: [] });
    store.undo();
    expect(snap(store.project, s(1))).toEqual(before);
  });

});
