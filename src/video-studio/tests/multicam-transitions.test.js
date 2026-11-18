import { describe, it, expect } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createMulticam, flattenMulticam } from '../src/model/multicam-edit.js';
import { addClip, mainTrack, setTransition } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { evaluate } from '../src/engine/scene.js';

const FREE = { ripple: false, linkOverlays: false };
const signature = layer => layer.kind === 'transition'
  ? { kind: layer.kind, id: layer.id, progress: layer.progress, from: signature(layer.from), to: signature(layer.to) }
  : { kind: layer.kind, name: layer.clip.name, sourceTime: layer.sourceTime, opacity: layer.opacity };
const frames = p => [1.5, 1.75, 2, 2.25, 2.5].map(t => evaluate(p, s(t)).map(signature));

function separateAngles(audio) {
  const p = fixture();
  const [a, b, later] = onMain(p, clip('video', 0, 2, { name: 'A' }), clip('video', 2, 2, { name: 'B' }), clip('video', 4, 2, { name: 'Later' }));
  setTransition(p, a.id, 'mix', s(1));
  setTransition(p, b.id, 'mix', s(1));
  const c = createMulticam(p, [a.id, b.id], FREE);
  c.multicam.cuts = [{ t: 0, angle: 0 }, { t: s(2), angle: 1 }];
  c.multicam.audio = audio;
  return { p, c, later };
}

describe('multicamera transition partners', () => {
  it('drops outgoing transitions whose partners are outside the camera track when creating angles', () => {
    const { c } = separateAngles('follow');
    expect(c.sequence.tracks.map(t => t.clips[0].transition)).toEqual([null, null]);
  });

  it.each([0, 'follow'])('does not invent transitions between angles or into an outside clip in saved projects (audio %s)', audio => {
    const { p, c } = separateAngles(audio);
    // Older saved projects could retain these orphaned transitions.
    c.sequence.tracks.forEach(t => { t.clips[0].transition = { id: 'mix', duration: s(1) }; });
    const store = new EditorStore(p);
    const before = [...frames(store.project), ...[3.75, 4.25].map(t => evaluate(store.project, s(t)).map(signature))];
    const check = q => expect([...frames(q), ...[3.75, 4.25].map(t => evaluate(q, s(t)).map(signature))]).toEqual(before);
    store.update('Flatten', q => { flattenMulticam(q, c.id); });
    check(store.project);
    check(normalizeProject(JSON.parse(JSON.stringify(store.projectForSave()))));
    expect(mainTrack(store.project).clips.every(c => !c.transition)).toBe(true);
    store.undo(); check(store.project);
    store.redo(); check(store.project);
  });

  it.each([0, 'follow'])('keeps a valid transition within one active camera (audio %s)', audio => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2, { name: 'A' }));
    const other = clip('video', 0, 4, { name: 'Other camera' });
    addClip(p, other, FREE);
    const c = createMulticam(p, [a.id, other.id], FREE);
    const next = clip('video', 2, 2, { name: 'A next' });
    c.sequence.tracks[0].clips.push(next);
    setTransition(c.sequence, a.id, 'mix', s(1));
    c.multicam.audio = audio;
    const before = frames(p);
    expect(before[1][0].kind).toBe('transition');
    flattenMulticam(p, c.id);
    expect(frames(p)).toEqual(before);
    expect(frames(normalizeProject(JSON.parse(JSON.stringify(p))))).toEqual(before);
  });

  it('drops a transition when the next clip on that camera is not selected by the cuts', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2, { name: 'A' }));
    const b = clip('video', 0, 4, { name: 'B' }); addClip(p, b, FREE);
    const c = createMulticam(p, [a.id, b.id], FREE);
    c.sequence.tracks[0].clips.push(clip('video', 2, 2, { name: 'A next' }));
    setTransition(c.sequence, a.id, 'mix', s(1));
    c.multicam.audio = 'follow';
    c.multicam.cuts = [{ t: 0, angle: 0 }, { t: s(2), angle: 1 }];
    const before = frames(p);
    flattenMulticam(p, c.id);
    expect(frames(p)).toEqual(before);
  });
});
