import { describe, it, expect, vi } from 'vitest';
import { createCompound, breakApart, composeTransform, compoundClips } from '../src/model/compound.js';
import { createMulticam, flattenMulticam } from '../src/model/multicam-edit.js';
import { addClip, mainTrack, findClip, allClips, splitClip, trimClip, maxDuration, sequenceLength, setTransition, deleteClips, MIN_CLIP } from '../src/model/timeline.js';
import { normalizeProject, makeClip, MAX_COMPOUND_DEPTH, compoundDepth } from '../src/model/project.js';
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

  it('keeps hidden and muted source tracks that are nested together', () => {
    const p = fixture();
    const [video] = onMain(p, clip('video', 0, 4));
    const music = clip('audio', 0, 4);
    const title = clip('text', 0, 4);
    addClip(p, music, FREE);
    addClip(p, title, FREE);
    findClip(p, music.id).track.muted = true;
    findClip(p, title.id).track.hidden = true;
    const shown = evaluate(p, s(1)).map(l => l.kind);
    const heard = audibleClips(p).map(x => x.clip.type);
    const store = new EditorStore(p);
    store.update('Create compound clip', q => { createCompound(q, [video.id, music.id, title.id], FREE); });
    expect(evaluate(store.project, s(1)).map(l => l.kind)).toEqual(shown);
    expect(audibleClips(store.project).map(x => x.clip.type)).toEqual(heard);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(store.projectForSave())));
    expect(evaluate(loaded, s(1)).map(l => l.kind)).toEqual(shown);
    expect(audibleClips(loaded).map(x => x.clip.type)).toEqual(heard);
    store.undo();
    expect(findClip(store.project, music.id).track.muted).toBe(true);
    expect(findClip(store.project, title.id).track.hidden).toBe(true);
    store.redo();
    expect(evaluate(store.project, s(1)).map(l => l.kind)).toEqual(shown);
    expect(audibleClips(store.project).map(x => x.clip.type)).toEqual(heard);
  });

  it('drops a transition into a clip left outside, which could not be seen or removed', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    setTransition(p, a.id, 'mix', s(1));
    const first = createCompound(p, [a.id], RIPPLE);
    expect(first.sequence.tracks[0].clips[0].transition).toBe(null);
    // Next to a second compound clip, it would have blended into that one's contents.
    createCompound(p, [b.id], RIPPLE);
    expect(evaluate(p, s(2)).some((layer) => layer.kind === 'transition')).toBe(false);
  });

  it('keeps a transition between two clips nested together', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    setTransition(p, a.id, 'mix', s(1));
    const comp = createCompound(p, [a.id, b.id], RIPPLE);
    expect(comp.sequence.tracks[0].clips[0].transition).toEqual({ id: 'mix', duration: s(1) });
  });

  it('refuses base track clips with other base track clips between them', () => {
    const p = fixture();
    const [a, b, c] = onMain(p, clip('video', 0, 2), clip('video', 2, 3), clip('video', 5, 2));
    const t = clip('text', 2.5, 1);
    addClip(p, t, FREE);
    const before = JSON.stringify(p);
    expect(createCompound(p, [a.id, c.id], RIPPLE)).toBeNull();
    expect(JSON.stringify(p)).toBe(before);
    expect(createCompound(p, [a.id, t.id, c.id], RIPPLE)).toBeNull();
    // Neighbors, and overlays alone, still nest.
    expect(createCompound(p, [b.id, c.id, t.id], RIPPLE).duration).toBe(s(5));
    expect(mainTrack(p).clips.map((x) => x.duration)).toEqual([s(2), s(5)]);
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

  it.each([[true, false], [false, true], [true, true]])('preserves the scene when breaking apart flips %s/%s', (flipH, flipV) => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    Object.assign(a.transform, { x: 0.2, y: -0.3, rotation: 17, scale: 0.7 });
    const comp = createCompound(p, [a.id], FREE);
    Object.assign(comp.transform, { x: -0.1, y: 0.1, scale: 0.5, rotation: 35, flipH, flipV });
    const before = evaluate(p, s(1))[0];
    breakApart(p, comp.id, FREE);
    const after = evaluate(p, s(1))[0];
    for (const key of ['x', 'y', 'scale', 'rotation']) expect(after[key]).toBeCloseTo(before[key]);
    for (const key of ['flipH', 'flipV']) expect(after[key]).toBe(before[key]);
  });

  it('leaves out slivers shorter than the shortest clip when broken apart', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const comp = createCompound(p, [a.id, b.id], RIPPLE);
    // Trimmed to start 10 ms before the cut: 10 ms of A shows.
    trimClip(p, comp.id, 'start', s(1.99), RIPPLE);
    const out = breakApart(p, comp.id, RIPPLE);
    expect(out).toHaveLength(1);
    expect(out[0].duration).toBe(s(2));
    expect(allClips(p).every((c) => c.duration >= MIN_CLIP)).toBe(true);
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

describe('compound clips on locked tracks', () => {
  it('are not opened for editing', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const comp = createCompound(p, [a.id, b.id], RIPPLE);
    mainTrack(p).locked = true;
    const store = new EditorStore(p);
    expect(store.openCompound(comp.id)).toBe(false);
    expect(store.nest).toHaveLength(0);
    mainTrack(store.project).locked = false;
    expect(store.openCompound(comp.id)).toBe(true);
  });
});

describe('closing a compound clip that got shorter', () => {
  const setup = (toggles) => {
    const p = fixture();
    const [, x] = onMain(p, clip('video', 0, 5), clip('video', 5, 4), clip('video', 9, 5));
    const title = clip('text', 10, 1); // over the last clip
    addClip(p, title, FREE);
    const comp = createCompound(p, [x.id], RIPPLE);
    const store = new EditorStore(p, { toggles });
    store.openCompound(comp.id);
    const inner = mainTrack(store.project).clips[0];
    store.update('Trim', (pp) => trimClip(pp, inner.id, 'end', s(2), store.opts));
    store.closeCompound();
    return { store, title };
  };
  const spansOf = (store) => mainTrack(store.project).clips.map((c) => [c.start / 1e6, c.duration / 1e6]);

  it('closes the gap on the rippled base track, moving overlays with their clips', () => {
    const { store, title } = setup({});
    expect(spansOf(store)).toEqual([[0, 5], [5, 2], [7, 5]]);
    expect(findClip(store.project, title.id).clip.start).toBe(s(8));
    store.undo();
    expect(spansOf(store)).toEqual([[0, 5], [5, 4], [9, 5]]);
  });

  it('leaves the gap with ripple off', () => {
    const { store, title } = setup({ ripple: false });
    expect(spansOf(store)).toEqual([[0, 5], [5, 2], [9, 5]]);
    expect(findClip(store.project, title.id).clip.start).toBe(s(10));
  });
});

describe('closing a compound clip whose contents got longer or empty', () => {
  const setup = (toggles, trimOuter = false) => {
    const p = fixture();
    const [, x] = onMain(p, clip('video', 0, 5), clip('video', 5, 4), clip('video', 9, 5));
    const title = clip('text', 10, 1); // over the last clip
    addClip(p, title, FREE);
    const comp = createCompound(p, [x.id], RIPPLE);
    if (trimOuter) trimClip(p, comp.id, 'end', s(8), RIPPLE);
    const store = new EditorStore(p, { toggles });
    store.openCompound(comp.id);
    return { store, title, comp };
  };
  const spansOf = (store) => mainTrack(store.project).clips.map((c) => [c.start / 1e6, c.duration / 1e6]);
  const extend = (store) => {
    const inner = mainTrack(store.project).clips[0];
    store.update('Add', (pp) => void addClip(pp, clip('image', 4, 3), { ...store.opts, main: true }));
    return inner;
  };

  it.each([true, false])('autosaves the full extended compound and following clips before it is closed (ripple: %s)', (ripple) => {
    const { store, title, comp } = setup({ ripple });
    extend(store);
    const before = structuredClone(store.project);
    const outer = structuredClone(store.nest[0].outer);
    const undoDepth = store.history.undoStack.length;
    const saved = normalizeProject(store.projectForSave());
    expect(findClip(saved, comp.id).clip.duration).toBe(s(7));
    expect(mainTrack(saved).clips.map((c) => [c.start / 1e6, c.duration / 1e6])).toEqual([[0, 5], [5, 7], [12, 5]]);
    if (ripple) expect(findClip(saved, title.id).clip.start).toBe(s(13));
    expect(store.project).toEqual(before);
    expect(store.nest[0].outer).toEqual(outer);
    expect(store.nest).toHaveLength(1);
    expect(store.history.undoStack).toHaveLength(undoDepth);
    store.closeCompound();
    expect(saved.tracks).toEqual(normalizeProject(store.projectForSave()).tracks);
  });

  it('keeps an existing outer trim when autosaving extended contents', () => {
    const { store, comp } = setup({}, true);
    extend(store);
    const saved = store.projectForSave();
    expect(findClip(saved, comp.id).clip.duration).toBe(s(3));
    expect(mainTrack(saved).clips.map((c) => [c.start / 1e6, c.duration / 1e6])).toEqual([[0, 5], [5, 3], [8, 5]]);
    store.closeCompound();
    expect(saved.tracks).toEqual(store.project.tracks);
  });

  it('propagates autosaved duration changes through multiple open compounds', () => {
    const p = fixture();
    const [, target] = onMain(p, clip('video', 0, 5), clip('video', 5, 4), clip('video', 9, 5));
    const child = createCompound(p, [target.id], RIPPLE);
    const parent = createCompound(p, [child.id], RIPPLE);
    const store = new EditorStore(p);
    store.openCompound(parent.id);
    store.openCompound(child.id);
    extend(store);
    const saved = store.projectForSave();
    const outer = findClip(saved, parent.id).clip;
    expect(outer.duration).toBe(s(7));
    expect(findClip(outer.sequence, child.id).clip.duration).toBe(s(7));
    expect(mainTrack(saved).clips.map((c) => c.start / 1e6)).toEqual([0, 5, 12]);
    expect(store.nest).toHaveLength(2);
    store.closeCompound();
    store.closeCompound();
    expect(saved.tracks).toEqual(store.project.tracks);
  });

  it('autosaves deletion of an emptied compound before it is closed', () => {
    const { store, comp } = setup({});
    store.update('Delete', (pp) => deleteClips(pp, allClips(pp).map((c) => c.id), store.opts) > 0);
    const saved = store.projectForSave();
    expect(findClip(saved, comp.id)).toBeNull();
    expect(mainTrack(saved).clips.map((c) => [c.start / 1e6, c.duration / 1e6])).toEqual([[0, 5], [5, 5]]);
    store.closeCompound();
    expect(saved.tracks).toEqual(store.project.tracks);
  });

  it('grows to show what was added at the end, rippling the base track', () => {
    const { store, title, comp } = setup({});
    extend(store);
    store.closeCompound();
    expect(findClip(store.project, comp.id).clip.duration).toBe(s(7));
    expect(spansOf(store)).toEqual([[0, 5], [5, 7], [12, 5]]);
    expect(findClip(store.project, title.id).clip.start).toBe(s(13));
    store.undo();
    expect(spansOf(store)).toEqual([[0, 5], [5, 4], [9, 5]]);
  });

  it('grows without ripple too, moving the clips after it later', () => {
    const { store } = setup({ ripple: false });
    extend(store);
    store.closeCompound();
    expect(spansOf(store)).toEqual([[0, 5], [5, 7], [12, 5]]);
    expect(noOverlapsIn(store.project)).toBe(true);
  });

  it('keeps a trim that ended before its end', () => {
    const { store } = setup({}, true);
    extend(store);
    store.closeCompound();
    expect(spansOf(store)).toEqual([[0, 5], [5, 3], [8, 5]]);
  });

  it('goes away when everything inside was deleted', () => {
    const { store, title, comp } = setup({});
    store.update('Delete', (pp) => deleteClips(pp, allClips(pp).map((c) => c.id), store.opts) > 0);
    store.closeCompound();
    expect(findClip(store.project, comp.id)).toBeNull();
    expect(spansOf(store)).toEqual([[0, 5], [5, 5]]);
    expect(findClip(store.project, title.id).clip.start).toBe(s(6));
    store.undo();
    expect(findClip(store.project, comp.id)).not.toBeNull();
  });
});

const noOverlapsIn = (p) => p.tracks.every((t) => t.clips.every((c, i) => !i || c.start >= t.clips[i - 1].start + t.clips[i - 1].duration - 1));

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

describe('nesting depth', () => {
  it('refuses a compound clip deeper than a saved project keeps, so nothing is lost on reload', () => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 2));
    const store = new EditorStore(p);
    const limits = [];
    store.on('limit', (d) => limits.push(d));
    let id = c.id;
    const nest = () => {
      let made = null;
      const ok = store.update('Create compound clip', (proj) => {
        made = createCompound(proj, [id], RIPPLE);
        return Boolean(made);
      });
      if (ok) id = made.id;
      return ok;
    };
    for (let i = 0; i < MAX_COMPOUND_DEPTH; i++) expect(nest()).toBe(true);
    expect(compoundDepth(store.project.tracks)).toBe(MAX_COMPOUND_DEPTH);
    const steps = store.history.undoStack.length;
    expect(nest()).toBe(false);
    expect(limits).toEqual([{ kind: 'compound-depth', max: MAX_COMPOUND_DEPTH }]);
    expect(compoundDepth(store.project.tracks)).toBe(MAX_COMPOUND_DEPTH);
    expect(store.history.undoStack.length).toBe(steps);
    // What is there survives saving and loading whole.
    const media = (tracks) => tracks.flatMap((t) => t.clips.flatMap((x) => (x.type === 'compound' ? media(x.sequence.tracks) : [x.assetId])));
    const back = normalizeProject(JSON.parse(JSON.stringify(store.projectForSave())));
    expect(media(back.tracks)).toEqual(media(store.project.tracks));
    expect(media(back.tracks)).toHaveLength(1);
    // Inside an open compound clip the levels above count too.
    store.openCompound(id);
    id = store.project.tracks.flatMap((t) => t.clips)[0].id;
    expect(nest()).toBe(false);
    expect(limits).toHaveLength(2);
  });
});


describe('neighboring compounds with different track layouts', () => {
  it('keeps a later video from inheriting an earlier effect track kind', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const fx = clip('effect', 0, 2);
    addClip(p, fx, FREE);
    createCompound(p, [a.id, fx.id], FREE);
    createCompound(p, [b.id], FREE);
    expect(evaluate(p, s(1)).map(l => l.kind)).toEqual(['media', 'effect']);
    const second = evaluate(p, s(3));
    expect(second.map(l => l.kind)).toEqual(['media']);
    expect(second[0].clip.sourceId).toBe(b.id);
    expect(audibleClips(p).map(({ clip: c }) => c.sourceId).sort()).toEqual([a.id, b.id].sort());
  });

  it.each([false, true])('preserves different hidden and mute states after a first compound with hidden=%s', (hidden) => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    const first = createCompound(p, [a.id], FREE);
    const second = createCompound(p, [b.id], FREE);
    Object.assign(first.sequence.tracks[0], { hidden, muted: hidden });
    Object.assign(second.sequence.tracks[0], { hidden: !hidden, muted: !hidden });
    expect(evaluate(p, s(1))).toHaveLength(hidden ? 0 : 1);
    expect(evaluate(p, s(3))).toHaveLength(hidden ? 1 : 0);
    expect(audibleClips(p).map(({ clip: c }) => c.sourceId)).toEqual([hidden ? b.id : a.id]);
    expect(evaluate(p, s(3), { includeHidden: true })).toHaveLength(1);
  });
  it('still shares compatible render tracks across many compounds', () => {
    const p = fixture();
    const child = clip('video', 0, 1);
    const sequence = { tracks: [{ id: 'inner', kind: 'video', main: true, clips: [child] }] };
    for (let i = 0; i < 1000; i++) onMain(p, clip('compound', i, 1, { sequence: structuredClone(sequence) }));
    const expanded = expandProject(p);
    expect(expanded.tracks.filter(t => t.virtual)).toHaveLength(1);
    expect(expanded.tracks.find(t => t.virtual).clips).toHaveLength(1000);
    expect(evaluate(p, s(999.5)).map(l => l.kind)).toEqual(['media']);
    expect(expandProject(p)).toBe(expanded);
  });

});

describe('nested track settings', () => {
  it('keeps track locks, solo and size when the project is saved and reopened', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    const comp = createCompound(p, [a.id], FREE);
    const store = new EditorStore(p);
    store.openCompound(comp.id);
    store.update('Track settings', q => {
      Object.assign(q.tracks[0], { locked: true, solo: true, size: 'large' });
    }, { structural: false });
    store.closeCompound();
    const loaded = normalizeProject(JSON.parse(JSON.stringify(store.projectForSave())));
    expect(mainTrack(loaded).clips[0].sequence.tracks[0]).toMatchObject({ locked: true, solo: true, size: 'large' });
  });

  it('keeps an inner solo local to its compound after closing it', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    const inside = clip('audio', 0, 4);
    const outside = clip('audio', 0, 4);
    addClip(p, inside, FREE);
    addClip(p, outside, FREE);
    const comp = createCompound(p, [a.id, inside.id], FREE);
    const store = new EditorStore(p);
    store.openCompound(comp.id);
    store.update('Solo inner music', q => { q.tracks.find(t => t.kind === 'audio').solo = true; }, { structural: false });
    expect(audibleClips(store.project).map(x => x.clip.id)).toEqual([inside.id]);
    store.closeCompound();
    const heard = audibleClips(store.project).map(x => x.clip.sourceId || x.clip.id).sort();
    expect(heard).toEqual([inside.id, outside.id].sort());
    const loaded = normalizeProject(JSON.parse(JSON.stringify(store.projectForSave())));
    expect(audibleClips(loaded).map(x => x.clip.sourceId || x.clip.id).sort()).toEqual(heard);
    findClip(loaded, outside.id).track.solo = true;
    loaded.modified++;
    expect(audibleClips(loaded).map(x => x.clip.sourceId || x.clip.id)).toEqual([outside.id]);
    findClip(loaded, outside.id).track.solo = false;
    mainTrack(loaded).solo = true;
    loaded.modified++;
    expect(audibleClips(loaded).map(x => x.clip.sourceId || x.clip.id)).toEqual([inside.id]);
    mainTrack(loaded).muted = true;
    loaded.modified++;
    expect(audibleClips(loaded)).toEqual([]);
  });
});


describe('compound render cache invalidation', () => {
  it('reflects consecutive edits made in the same millisecond', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    const comp = createCompound(p, [a.id], FREE);
    const store = new EditorStore(p);
    const now = vi.spyOn(Date, 'now').mockReturnValue(p.modified);
    try {
      expect(evaluate(store.project, s(1))).toHaveLength(1);
      expect(audibleClips(store.project)).toHaveLength(1);
      store.update('Hide and mute track', q => {
        mainTrack(q).hidden = true;
        mainTrack(q).muted = true;
      }, { structural: false });
      expect(evaluate(store.project, s(1))).toHaveLength(0);
      expect(audibleClips(store.project)).toHaveLength(0);
      store.update('Show and unmute track', q => {
        mainTrack(q).hidden = false;
        mainTrack(q).muted = false;
      }, { structural: false });
      expect(evaluate(store.project, s(1))).toHaveLength(1);
      expect(audibleClips(store.project)).toHaveLength(1);
      store.openCompound(comp.id);
      store.update('Move nested video', q => { mainTrack(q).clips[0].transform.x = 0.3; }, { structural: false });
      store.closeCompound();
      expect(evaluate(store.project, s(1))[0].x).toBeCloseTo(0.3);
      store.undo();
      expect(evaluate(store.project, s(1))[0].x).toBeCloseTo(0);
      store.redo();
      expect(evaluate(store.project, s(1))[0].x).toBeCloseTo(0.3);
      expect(expandProject(store.project)).toBe(expandProject(store.project));
    } finally {
      now.mockRestore();
    }
  });
});


describe('flattened compound appearance', () => {
  it.each(['compound', 'multicam'])('preserves inherited blend modes when flattening a %s', type => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    const b = clip('video', 0, 4);
    addClip(p, b, FREE);
    const c = type === 'compound' ? createCompound(p, [a.id, b.id], FREE) : createMulticam(p, [a.id, b.id], FREE);
    c.blend = 'multiply';
    const before = evaluate(p, s(1)).map(l => l.blend);
    if (type === 'compound') breakApart(p, c.id, FREE);
    else flattenMulticam(p, c.id);
    expect(evaluate(p, s(1)).map(l => l.blend)).toEqual(before);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(evaluate(loaded, s(1)).map(l => l.blend)).toEqual(before);
  });

  it('keeps a child blend override when breaking apart', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    a.blend = 'screen';
    const c = createCompound(p, [a.id], FREE);
    c.blend = 'multiply';
    const before = evaluate(p, s(1))[0].blend;
    breakApart(p, c.id, FREE);
    expect(evaluate(p, s(1))[0].blend).toBe(before);
  });
});


describe('disabled compounds', () => {
  it.each(['compound', 'multicam'])('stays disabled when flattening a %s', type => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    const b = clip('video', 0, 4);
    addClip(p, b, FREE);
    const c = type === 'compound' ? createCompound(p, [a.id, b.id], FREE) : createMulticam(p, [a.id, b.id], FREE);
    c.disabled = true;
    expect(evaluate(p, s(1))).toEqual([]);
    expect(audibleClips(p)).toEqual([]);
    if (type === 'compound') breakApart(p, c.id, FREE);
    else flattenMulticam(p, c.id);
    expect(evaluate(p, s(1))).toEqual([]);
    expect(audibleClips(p)).toEqual([]);
    expect(allClips(p).every(c => c.disabled)).toBe(true);
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(evaluate(loaded, s(1))).toEqual([]);
    expect(audibleClips(loaded)).toEqual([]);
  });
});
