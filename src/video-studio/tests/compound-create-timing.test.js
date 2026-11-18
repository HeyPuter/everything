import { describe, it, expect } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createCompound } from '../src/model/compound.js';
import { addClip, findClip } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { evaluate, audibleClips, gainAt } from '../src/engine/scene.js';

const FREE = { ripple: false, linkOverlays: false };
const RIPPLE = { ripple: true, linkOverlays: true };
const scene = (p, t) => ({
  picture: evaluate(p, t).map(l => [l.clip.name, l.sourceTime, l.x, l.y, l.opacity]),
  sound: audibleClips(p).filter(({ clip: c }) => c.start <= t && t < c.start + c.duration).map(({ clip: c }) => [c.name, gainAt(c, t)]).sort(),
});

describe('grouping preserves timeline time', () => {
  it.each(['base gap', 'overlay only', 'long overlay'])('keeps selected and unrelated clips in place with ripple on: %s', mode => {
    const p = fixture();
    const [a, b, later] = onMain(p, clip('video', 0, 2, { name: 'A' }), clip('video', 4, 2, { name: 'B' }), clip('video', 7, 2, { name: 'Later' }));
    const title = clip('text', mode === 'long overlay' ? 1 : 4, mode === 'long overlay' ? 7 : 2, { name: 'Title' });
    const caption = clip('text', 7.25, 1, { name: 'Caption' });
    addClip(p, title, FREE); addClip(p, caption, FREE);
    const ids = mode === 'overlay only' ? [title.id] : [b.id, title.id];
    const times = [0.5, 1.5, 2.5, 4.5, 5.5, 6.5, 7.5, 8.5].map(s);
    const store = new EditorStore(p);
    const before = times.map(t => scene(store.project, t));
    const unchanged = [a, later, caption].map(c => [c.id, c.start, c.duration]);
    let c;
    store.update('Group', q => { c = createCompound(q, ids, RIPPLE); });
    expect(times.map(t => scene(store.project, t))).toEqual(before);
    expect(unchanged.map(([id]) => { const c = findClip(store.project, id).clip; return [id, c.start, c.duration]; })).toEqual(unchanged);
    expect(c.start).toBe(mode === 'long overlay' ? s(1) : s(4));
    expect(times.map(t => scene(normalizeProject(JSON.parse(JSON.stringify(store.projectForSave()))), t))).toEqual(before);
    store.undo(); expect(times.map(t => scene(store.project, t))).toEqual(before);
    store.redo(); expect(times.map(t => scene(store.project, t))).toEqual(before);
  });
});
