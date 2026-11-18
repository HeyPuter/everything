import { describe, it, expect } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createMulticam } from '../src/model/multicam-edit.js';
import { angleTracks } from '../src/model/multicam.js';
import { addClip, mainTrack, findClip } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { evaluate, audibleClips } from '../src/engine/scene.js';

const FREE = { ripple: false, linkOverlays: false };
const RIPPLE = { ripple: true, linkOverlays: true };
const snapshot = (p, t) => ({
  picture: evaluate(p, t).map(l => [l.clip.name, l.sourceTime]),
  sound: audibleClips(p).filter(({ clip: c }) => c.start <= t && t < c.start + c.duration).map(({ clip: c }) => c.name).sort(),
});

describe('creating multicamera clips preserves source controls and timing', () => {
  it.each(['hidden', 'muted', 'solo'])('keeps a camera track %s when it becomes the active angle', flag => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4, { name: 'A' }));
    const b = clip('video', 0, 4, { name: 'B' });
    addClip(p, b, FREE).track[flag] = true;
    const c = createMulticam(p, [a.id, b.id], FREE);
    c.multicam.cuts = [{ t: 0, angle: 1 }];
    c.multicam.audio = 1;
    const expected = { picture: flag === 'hidden' ? [] : [['B', s(1)]], sound: flag === 'muted' ? [] : ['B'] };
    expect(snapshot(p, s(1))).toEqual(expected);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(snapshot(loaded, s(1))).toEqual(expected);
    expect(angleTracks(findClip(loaded, c.id).clip)[1][flag]).toBe(true);
  });

  it.each(['hidden', 'muted'])('does not let the original base track %s suppress a different active angle', flag => {
    const p = fixture();
    const [a, later] = onMain(p, clip('video', 0, 4, { name: 'A' }), clip('video', 4, 2, { name: 'Later' }));
    mainTrack(p)[flag] = true;
    const b = clip('video', 0, 4, { name: 'B' });
    addClip(p, b, FREE);
    const store = new EditorStore(p);
    let c;
    store.update('Multicamera', q => {
      c = createMulticam(q, [a.id, b.id], RIPPLE);
      c.multicam.cuts = [{ t: 0, angle: 1 }]; c.multicam.audio = 1;
    });
    const expected = { picture: [['B', s(1)]], sound: ['B'] };
    expect(snapshot(store.project, s(1))).toEqual(expected);
    expect(findClip(store.project, later.id).clip.start).toBe(s(4));
    expect(mainTrack(store.project)[flag]).toBe(true);
    expect(snapshot(normalizeProject(JSON.parse(JSON.stringify(store.projectForSave()))), s(1))).toEqual(expected);
    store.undo(); expect(findClip(store.project, a.id)).toBeTruthy();
    store.redo(); expect(snapshot(store.project, s(1))).toEqual(expected);
  });

  it('keeps synchronized starts and unrelated clips fixed when ripple is on', () => {
    const p = fixture();
    const [a, later] = onMain(p, clip('video', 4, 2, { name: 'A' }), clip('video', 7, 2, { name: 'Later' }));
    const b = clip('video', 4, 2, { name: 'B' });
    addClip(p, b, FREE);
    const c = createMulticam(p, [a.id, b.id], { ...RIPPLE, starts: { [b.id]: s(3) } });
    expect(c.start).toBe(s(3));
    expect(c.duration).toBe(s(3));
    expect(angleTracks(c).map(t => t.clips[0].start)).toEqual([s(1), 0]);
    expect(findClip(p, later.id).clip.start).toBe(s(7));
    expect(snapshot(p, s(4.5))).toEqual({ picture: [['A', s(0.5)]], sound: ['A'] });
  });
});
