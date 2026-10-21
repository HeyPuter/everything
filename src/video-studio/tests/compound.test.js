import { describe, it, expect } from 'vitest';
import { createCompound, breakApart, composeTransform, compoundClips } from '../src/model/compound.js';
import { addClip, mainTrack, findClip, allClips, splitClip, trimClip, maxDuration, sequenceLength } from '../src/model/timeline.js';
import { normalizeProject, makeClip } from '../src/model/project.js';
import { fixture, clip, onMain, s } from './helpers.js';

const RIPPLE = { ripple: true, linkOverlays: true };
const FREE = { ripple: false, linkOverlays: false };

describe('compound clips', () => {
  it('nests a selection and puts it on the base track', () => {
    const p = fixture();
    const [a, b, c] = onMain(p, clip('video', 0, 2), clip('video', 2, 3), clip('video', 5, 2));
    const t = clip('text', 2.5, 1);
    addClip(p, t, FREE);
    const comp = createCompound(p, [b.id, t.id], RIPPLE);
    expect(comp.type).toBe('compound');
    expect(comp.start).toBe(s(2));
    expect(comp.duration).toBe(s(3));
    expect(mainTrack(p).clips.map((x) => x.id)).toEqual([a.id, comp.id, c.id]);
    expect(findClip(p, t.id)).toBeNull();
    const kinds = comp.sequence.tracks.map((x) => x.kind);
    expect(kinds).toEqual(['text', 'video']);
    expect(comp.sequence.tracks[1].main).toBe(true);
    expect(comp.sequence.tracks[0].clips[0].start).toBe(s(0.5));
    expect(sequenceLength(comp.sequence)).toBe(s(3));
  });

  it('splits and trims like a clip, keeping the nested timing', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    const comp = createCompound(p, [a.id], RIPPLE);
    const right = splitClip(p, comp.id, s(1));
    expect(right.in).toBe(s(1));
    expect(right.duration).toBe(s(3));
    expect(maxDuration(p, comp)).toBe(s(4));
    trimClip(p, right.id, 'start', s(2), FREE);
    expect(findClip(p, right.id).clip.in).toBe(s(2));
  });

  it('breaks apart into the clips it shows, composing its transform', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const t = clip('text', 1, 2);
    addClip(p, t, FREE);
    const comp = createCompound(p, [a.id, b.id, t.id], RIPPLE);
    comp.transform.scale = 0.5;
    comp.transform.x = 0.1;
    // Show only 1 s .. 3 s of the nested timeline.
    comp.in = s(1);
    comp.duration = s(2);
    const restored = breakApart(p, comp.id, RIPPLE);
    expect(compoundClips(p)).toEqual([]);
    const vids = mainTrack(p).clips;
    expect(vids.map((x) => [x.start / 1e6, x.duration / 1e6, x.in / 1e6])).toEqual([[0, 1, 1], [1, 1, 0]]);
    expect(vids[0].transform.scale).toBeCloseTo(0.5);
    expect(vids[0].transform.x).toBeCloseTo(0.1);
    const text = allClips(p).find((x) => x.type === 'text');
    expect(text.start).toBe(0);
    expect(text.duration).toBe(s(2));
    expect(restored.length).toBe(3);
  });

  it('composes transforms around the frame center', () => {
    const r = composeTransform({ x: 0, y: 0, scale: 2, rotation: 90, flipH: false, flipV: false }, { x: 0.1, y: 0, scale: 1, rotation: 0, flipH: false, flipV: false }, 1000, 1000);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(0.2);
    expect(r.scale).toBe(2);
    expect(r.rotation).toBe(90);
  });

  it('survives normalization, dropping nested clips with missing media', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 2));
    const comp = createCompound(p, [a.id], RIPPLE);
    comp.sequence.tracks[0].clips.push({ ...clip('video', 2, 1), assetId: 'nope' });
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    const nc = mainTrack(n).clips[0];
    expect(nc.type).toBe('compound');
    expect(nc.sequence.tracks.flatMap((t) => t.clips).length).toBe(1);
    expect(nc.sequence.tracks.some((t) => t.main)).toBe(true);
  });
});

import { evaluate, audibleClips, gainAt } from '../src/engine/scene.js';
import { expandProject, rootClip } from '../src/engine/compound.js';
import { EditorStore } from '../src/model/store.js';

describe('rendering compound clips', () => {
  it('shows the nested clips with the compound transform and opacity applied', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    const t = clip('text', 1, 2);
    addClip(p, t, FREE);
    const comp = createCompound(p, [a.id, t.id], RIPPLE);
    comp.transform.scale = 0.5;
    comp.transform.x = 0.2;
    comp.opacity = 0.5;
    const layers = evaluate(p, s(1.5));
    expect(layers.map((l) => l.kind)).toEqual(['media', 'text']);
    const media = layers[0];
    expect(media.scale).toBeCloseTo(0.5);
    expect(media.x).toBeCloseTo(0.2);
    expect(media.opacity).toBeCloseTo(0.5);
    expect(rootClip(media.clip)).toBe(comp);
    // A trimmed compound only shows its window.
    comp.in = s(2);
    comp.duration = s(2);
    comp.start = 0;
    p.modified++;
    expect(evaluate(p, s(0.5)).map((l) => l.kind)).toEqual(['media', 'text']);
    expect(evaluate(p, s(1.5)).map((l) => l.kind)).toEqual(['media']);
  });

  it('plays nested sound at the compound volume', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    const comp = createCompound(p, [a.id], RIPPLE);
    comp.volume = 0.5;
    const list = audibleClips(p);
    expect(list.length).toBe(1);
    expect(gainAt(list[0].clip, s(1))).toBeCloseTo(0.5);
    comp.muted = true;
    expect(gainAt(list[0].clip, s(1))).toBe(0);
  });

  it('caches the expansion until the project changes', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    createCompound(p, [a.id], RIPPLE);
    expect(expandProject(p)).toBe(expandProject(p));
    const plain = fixture();
    expect(expandProject(plain)).toBe(plain);
  });

  it('opens a compound for editing and folds the edits back as one step', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const store = new EditorStore(p);
    let comp;
    store.update('nest', (proj) => void (comp = createCompound(proj, [a.id, b.id], RIPPLE)));
    const undoDepth = store.history.undoStack.length;
    expect(store.openCompound(comp.id)).toBe(true);
    expect(store.project.tracks.flatMap((t) => t.clips).length).toBe(2);
    store.update('Rename inner', (proj) => void (proj.tracks.find((t) => t.main).clips[0].name = 'Inner'), { structural: false });
    // Saving while inside keeps the whole project.
    const saved = store.projectForSave();
    expect(saved.tracks.find((t) => t.main).clips[0].type).toBe('compound');
    expect(saved.tracks.find((t) => t.main).clips[0].sequence.tracks.find((t) => t.main).clips[0].name).toBe('Inner');
    store.closeCompound();
    expect(store.nest.length).toBe(0);
    expect(store.history.undoStack.length).toBe(undoDepth + 1);
    const c = store.project.tracks.find((t) => t.main).clips[0];
    expect(c.sequence.tracks.find((t) => t.main).clips[0].name).toBe('Inner');
    store.undo();
    expect(store.project.tracks.find((t) => t.main).clips[0].sequence.tracks.find((t) => t.main).clips[0].name).not.toBe('Inner');
  });
});

describe('project fields while a compound clip is open', () => {
  function open() {
    const p = fixture();
    const [, b] = onMain(p, clip('video', 0, 5), clip('video', 5, 5, { assetId: 'silent' }));
    const comp = createCompound(p, [b.id], RIPPLE);
    const store = new EditorStore(p);
    store.openCompound(comp.id);
    return { store, comp };
  }
  const assetIds = (p) => Object.keys(p.assets).sort();

  it('keeps a project rename made inside', () => {
    const { store } = open();
    store.update('Rename project', (x) => void (x.name = 'New name'), { structural: false });
    expect(store.projectForSave().name).toBe('New name');
    store.closeCompound();
    expect(store.project.name).toBe('New name');
    expect(store.projectForSave().name).toBe('New name');
    // The edits inside are one undo step out here, the rename included.
    store.undo();
    expect(store.project.name).toBe('Test');
  });

  it('keeps media imported inside after a cancelled edit or an undo', () => {
    const { store, comp } = open();
    store.update('Split', () => false); // cancelled
    store.update('Trim', (x) => void (x.name = 'tmp'), { structural: false });
    store.undo();
    const asset = { ...store.project.assets.vid, id: 'newvid', name: 'new.mp4' };
    store.update('Import new.mp4', (x) => void (x.assets.newvid = asset), { structural: false });
    store.update('Add new.mp4', (x) => addClip(x, makeClip('video', { assetId: 'newvid', start: s(5), duration: s(3) }), { ...store.opts, main: true }));
    expect(store.projectForSave().assets.newvid).toBeTruthy();
    store.closeCompound();
    const saved = normalizeProject(JSON.parse(JSON.stringify(store.projectForSave())));
    expect(saved.assets.newvid).toBeTruthy();
    expect(findClip(saved, comp.id).clip.sequence.tracks.some((t) => t.clips.some((c) => c.assetId === 'newvid'))).toBe(true);
  });

  it('does not change the outer project before the compound clip is closed', () => {
    const { store } = open();
    const outer = store.nest[0].outer;
    store.update('Rename project', (x) => void (x.name = 'Inner name'), { structural: false });
    store.update('Drop media', (x) => void delete x.assets.aud, { structural: false });
    expect(outer.name).toBe('Test');
    expect(outer.assets.aud).toBeTruthy();
    store.undo();
    store.undo();
    store.closeCompound();
    expect(store.project.name).toBe('Test');
    expect(assetIds(store.project)).toEqual(['aud', 'img', 'silent', 'vid']);
  });
});

describe('nested compound clips', () => {
  it('applies the inner compound transform before the outer one', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    const inner = createCompound(p, [a.id], RIPPLE);
    inner.transform.x = 0.1;
    const outer = createCompound(p, [inner.id], RIPPLE);
    outer.transform.scale = 2;
    p.modified++;
    const [layer] = evaluate(p, s(1));
    // Inner moves it 0.1 right, then the outer doubles everything around the center.
    expect(layer.x).toBeCloseTo(0.2);
    expect(layer.scale).toBeCloseTo(2);
    expect(rootClip(layer.clip)).toBe(outer);
  });
});
