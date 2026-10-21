import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { History } from '../src/model/history.js';
import { setTransition, mainTrack, addClip, findClip, moveClip } from '../src/model/timeline.js';
import { makeTrack } from '../src/model/project.js';
import { fixture, clip, onMain, s } from './helpers.js';

function storeWith(...mainClips) {
  const p = fixture();
  onMain(p, ...mainClips);
  return new EditorStore(p);
}

const events = (store, type) => {
  const list = [];
  store.on(type, (d) => list.push(d));
  return list;
};

afterEach(() => vi.restoreAllMocks());

describe('History', () => {
  it('undoes and redoes snapshots in order and clears redo on a new edit', () => {
    const h = new History();
    h.push('s0', 'one');
    h.push('s1', 'two');
    expect(h.undoLabel).toBe('two');
    expect(h.undo('s2')).toEqual({ snapshot: 's1', label: 'two' });
    expect(h.redoLabel).toBe('two');
    expect(h.redo('s1')).toEqual({ snapshot: 's2', label: 'two' });
    h.undo('s2');
    h.push('s1b', 'three');
    expect(h.canRedo()).toBe(false);
    expect(h.undo('x')).toEqual({ snapshot: 's1b', label: 'three' });
  });

  it('forgets the oldest steps past its limit', () => {
    const h = new History(3);
    for (let i = 0; i < 5; i++) h.push(i, `e${i}`);
    expect(h.undoStack.map((e) => e.snapshot)).toEqual([2, 3, 4]);
  });

  it('folds the steps since a mark, even after old steps fell off, and nothing once the mark was undone', () => {
    const h = new History(4);
    h.push('o', 'O');
    h.push('a', 'A');
    const mark = h.mark();
    for (let i = 0; i < 3; i++) h.push(i, `e${i}`); // the oldest step went, 'A' is still there
    expect(h.fold(mark, 'Batch').snapshot).toBe(0);
    expect(h.undoStack.map((e) => e.label)).toEqual(['A', 'Batch']);
    // The marked step was undone meanwhile: what is on the stack is not the batch's to fold.
    h.push('b', 'B');
    const gone = h.mark();
    h.undo('now');
    h.push('c', 'C');
    expect(h.fold(gone, 'Batch 2')).toBe(null);
    expect(h.undoStack.map((e) => e.label)).toEqual(['A', 'Batch', 'C']);
  });

  it('keeps fewer steps of a big project, within its memory budget, but never fewer than the minimum', () => {
    const big = { text: 'x'.repeat(1000) };
    const h = new History(200, { budget: 50_000, minSteps: 10 });
    for (let i = 0; i < 100; i++) h.push({ ...big, i }, `e${i}`);
    expect(h.undoStack).toHaveLength(49);
    expect(h.undoStack.at(-1).snapshot.i).toBe(99);
    const tight = new History(200, { budget: 1000, minSteps: 10 });
    for (let i = 0; i < 100; i++) tight.push({ ...big, i }, `e${i}`);
    expect(tight.undoStack).toHaveLength(10);
    // Small projects keep the full count.
    const small = new History(200);
    for (let i = 0; i < 300; i++) small.push({ i }, `e${i}`);
    expect(small.undoStack).toHaveLength(200);
  });

  it('returns null with nothing to undo or redo', () => {
    const h = new History();
    expect(h.undo('x')).toBe(null);
    expect(h.redo('x')).toBe(null);
    expect(h.undoLabel).toBe('');
  });
});

describe('EditorStore.update', () => {
  it('applies an edit, emits change and makes it undoable and redoable', () => {
    const store = storeWith(clip('video', 0, 4));
    const changes = events(store, 'change');
    const id = mainTrack(store.project).clips[0].id;
    expect(store.update('Rename', (p) => { p.name = 'New'; }, { structural: false })).toBe(true);
    expect(changes).toEqual([{ label: 'Rename', structural: false }]);
    expect(store.undo()).toBe('Rename');
    expect(store.project.name).toBe('Test');
    expect(store.redo()).toBe('Rename');
    expect(store.project.name).toBe('New');
    expect(findClip(store.project, id)).toBeTruthy();
  });

  it('passes through the edit function result', () => {
    const store = storeWith();
    expect(store.update('Count', () => 7)).toBe(7);
  });

  it('records nothing when the edit returns false, and restores the project', () => {
    const store = storeWith(clip('video', 0, 4));
    const changes = events(store, 'change');
    const before = JSON.stringify(store.project);
    const rev = store.revision;
    expect(store.update('Nope', (p) => { p.name = 'Changed'; mainTrack(p).clips = []; return false; })).toBe(false);
    expect(JSON.stringify(store.project)).toBe(before);
    expect(store.history.canUndo()).toBe(false);
    expect(store.revision).toBe(rev);
    expect(changes).toEqual([]);
  });

  it('keeps the same project, track and clip objects when an edit is cancelled', () => {
    const store = storeWith(clip('video', 0, 4), clip('video', 4, 4));
    const project = store.project;
    const track = mainTrack(project);
    const [a, b] = track.clips;
    expect(store.update('Split', () => false)).toBe(false);
    expect(store.project).toBe(project);
    expect(store.project.tracks[0]).toBe(track);
    // An edit that changed things before cancelling is undone in place.
    expect(store.update('Nope', (p) => {
      findClip(p, a.id).clip.start = s(9);
      mainTrack(p).clips.reverse();
      p.tracks.push(makeTrack('audio'));
      return false;
    })).toBe(false);
    expect(store.project).toBe(project);
    expect(project.tracks).toEqual([track]);
    expect(track.clips).toEqual([a, b]);
    expect(track.clips[0]).toBe(a);
    expect(track.clips[1]).toBe(b);
    expect(a.start).toBe(0);
  });

  it('rolls back an edit that fails inside a coalesced run, keeping the run so far', () => {
    const store = storeWith();
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    store.update('Volume', (p) => { p.name = 'v1'; }, { coalesce: 'vol', structural: false });
    now += 100;
    expect(store.update('Volume', (p) => { p.name = 'half'; return false; }, { coalesce: 'vol', structural: false })).toBe(false);
    expect(store.project.name).toBe('v1');
    now += 100;
    expect(() => store.update('Volume', (p) => { p.name = 'boom'; throw new Error('boom'); }, { coalesce: 'vol', structural: false })).toThrow('boom');
    expect(store.project.name).toBe('v1');
    expect(store.history.undoStack).toHaveLength(1);
    store.undo();
    expect(store.project.name).toBe('Test');
  });

  it('copies a very big project once per coalesced run, not on every step', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const copies = (store) => {
      const json = vi.spyOn(JSON, 'stringify');
      for (let i = 0; i < 6; i++) {
        now += 50;
        store.update('Volume', (p) => void (p.volume = i), { coalesce: 'vol', structural: false });
      }
      const n = json.mock.calls.filter(([v]) => v === store.project).length;
      json.mockRestore();
      return n;
    };
    expect(copies(storeWith())).toBe(5); // small: every merged step can roll back
    const big = storeWith();
    big.project.notes = 'x'.repeat(1_200_000);
    expect(copies(big)).toBe(1);
  });

  it('leaves a grouped overlay in place when a coalesced nudge is blocked', () => {
    const store = storeWith(clip('video', 0, 5), clip('video', 5, 5));
    store.setToggle('ripple', false);
    const b = mainTrack(store.project).clips[1];
    const o = clip('text', 0, 2);
    addClip(store.project, o, { ripple: false });
    const f = Math.round(s(1) / 30);
    const nudge = (d) => store.update('Nudge clip', (p) => moveClip(p, b.id, { start: findClip(p, b.id).clip.start + d, trackId: mainTrack(p).id }, { ...store.opts, with: [b.id, o.id] }), { coalesce: 'nudge' });
    expect(nudge(f)).toBe(true);
    expect(nudge(-f)).toBe(true);
    expect(nudge(-f)).toBe(false); // blocked by the first clip
    expect(findClip(store.project, o.id).clip.start).toBe(0);
    expect(findClip(store.project, b.id).clip.start).toBe(s(5));
  });

  it('restores the project and rethrows when the edit throws', () => {
    const store = storeWith(clip('video', 0, 4));
    expect(() => store.update('Boom', (p) => { p.name = 'Half'; throw new Error('boom'); })).toThrow('boom');
    expect(store.project.name).toBe('Test');
    expect(store.history.canUndo()).toBe(false);
  });

  it('merges a quick run of edits with the same coalesce key into one undo step', () => {
    const store = storeWith();
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    for (const v of [1, 2, 3]) {
      store.update('Volume', (p) => { p.name = `v${v}`; }, { coalesce: 'vol', structural: false });
      now += 100;
    }
    expect(store.history.undoStack).toHaveLength(1);
    store.update('Other', (p) => { p.name = 'other'; }, { coalesce: 'other', structural: false });
    expect(store.history.undoStack).toHaveLength(2);
    store.undo();
    store.undo();
    expect(store.project.name).toBe('Test');
  });

  it('starts a new undo step after a pause or seal()', () => {
    const store = storeWith();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    store.update('A', (p) => { p.name = 'a'; }, { coalesce: 'k', structural: false });
    now += 5000;
    store.update('A', (p) => { p.name = 'b'; }, { coalesce: 'k', structural: false });
    store.seal();
    store.update('A', (p) => { p.name = 'c'; }, { coalesce: 'k', structural: false });
    expect(store.history.undoStack).toHaveLength(3);
  });

  it('prunes empty tracks after structural edits unless asked not to', () => {
    const store = storeWith();
    store.update('Add track', (p) => { p.tracks.push(makeTrack('audio')); }, { keepEmptyTracks: true });
    expect(store.project.tracks).toHaveLength(2);
    store.update('Touch', () => {});
    expect(store.project.tracks).toHaveLength(1);
  });

  it('drops transitions whose clips were pulled apart by any edit', () => {
    const store = storeWith(clip('video', 0, 2), clip('video', 2, 2));
    const [a, b] = mainTrack(store.project).clips;
    store.update('Transition', (p) => setTransition(p, a.id, 'mix'));
    store.update('Nudge', (p) => { findClip(p, b.id).clip.start = s(3); });
    expect(findClip(store.project, a.id).clip.transition).toBe(null);
  });
});

describe('EditorStore multi-step undo', () => {
  it('undoes and redoes several steps with one change event', () => {
    const store = storeWith();
    for (const n of ['A', 'B', 'C', 'D']) store.update(`Rename ${n}`, (p) => void (p.name = n), { structural: false });
    const changes = events(store, 'change');
    expect(store.undo(3)).toBe('Rename B');
    expect(store.project.name).toBe('A');
    expect(changes).toHaveLength(1);
    expect(store.history.redoStack).toHaveLength(3);
    expect(store.redo(2)).toBe('Rename C');
    expect(store.project.name).toBe('C');
    expect(changes).toHaveLength(2);
    // Each step still restores exactly, one at a time too.
    expect(store.undo(9)).toBe('Rename A');
    expect(store.project.name).toBe('Test');
    expect(store.undo(2)).toBe(null);
    expect(store.redo()).toBe('Rename A');
    expect(store.project.name).toBe('A');
    expect(store.redo(5)).toBe('Rename D');
    expect(store.project.name).toBe('D');
    expect(changes).toHaveLength(5);
  });
});

describe('EditorStore selection', () => {
  it('selects, adds and toggles ids', () => {
    const store = storeWith();
    const sel = events(store, 'select');
    store.select('a');
    store.select(['b', 'c'], { add: true });
    store.select('b', { toggle: true });
    expect(store.selectedIds).toEqual(['a', 'c']);
    expect(sel.at(-1)).toEqual({ ids: ['a', 'c'] });
    store.select(null);
    expect(store.selectedIds).toEqual([]);
  });

  it('exposes the single selected clip', () => {
    const store = storeWith(clip('video', 0, 2), clip('video', 2, 2));
    const [a, b] = mainTrack(store.project).clips;
    store.select(a.id);
    expect(store.selected.clip).toBe(a);
    store.select([a.id, b.id]);
    expect(store.selected).toBe(null);
  });

  it('forgets selected clips that an edit or undo removed', () => {
    const store = storeWith(clip('video', 0, 2));
    const t = clip('text', 0, 1);
    store.update('Add', (p) => { addClip(p, t, store.opts); });
    store.select([t.id]);
    store.undo();
    expect(store.selectedIds).toEqual([]);
    store.redo();
    store.select([t.id]);
    store.update('Delete', (p) => { p.tracks.forEach((tr) => (tr.clips = tr.clips.filter((c) => c.id !== t.id))); });
    expect(store.selectedIds).toEqual([]);
  });

  it('selecting a transition clears the clip selection, and selecting a clip clears the transition', () => {
    const store = storeWith(clip('video', 0, 2), clip('video', 2, 2));
    const [a, b] = mainTrack(store.project).clips;
    store.update('Transition', (p) => setTransition(p, a.id, 'mix'));
    store.select(b.id);
    store.selectTransition(a.id);
    expect(store.selectedIds).toEqual([]);
    expect(store.transition).toBe(a.id);
    store.select(b.id);
    expect(store.transition).toBe(null);
  });

  it('forgets the selected transition once it is removed, by an edit or by undo', () => {
    const store = storeWith(clip('video', 0, 2), clip('video', 2, 2));
    const [a] = mainTrack(store.project).clips;
    store.update('Transition', (p) => setTransition(p, a.id, 'mix'));
    store.selectTransition(a.id);
    store.update('Remove', (p) => setTransition(p, a.id, null));
    expect(store.transition).toBe(null);

    store.update('Transition', (p) => setTransition(p, a.id, 'mix'));
    store.selectTransition(a.id);
    store.undo();
    expect(store.transition).toBe(null);
  });

  it('clears everything when another project is loaded', () => {
    const store = storeWith(clip('video', 0, 2), clip('video', 2, 2));
    const [a] = mainTrack(store.project).clips;
    store.update('Transition', (p) => setTransition(p, a.id, 'mix'));
    store.selectTransition(a.id);
    store.seek(s(1));
    store.load(fixture());
    expect([store.selectedIds, store.transition, store.time, store.history.canUndo(), store.dirty]).toEqual([[], null, 0, false, false]);
  });
});

describe('EditorStore playhead', () => {
  it('clamps seeks to the project, rounds to microseconds and only emits on change', () => {
    const store = storeWith(clip('video', 0, 4));
    const times = events(store, 'time');
    store.seek(-5);
    expect(times).toEqual([]);
    store.seek(1234.6);
    store.seek(s(99));
    store.seek(s(99));
    expect(times).toEqual([{ time: 1235 }, { time: s(4) }]);
  });

  it('stays at 0 in an empty project', () => {
    const store = storeWith();
    store.seek(s(3));
    expect(store.time).toBe(0);
  });
});

describe('EditorStore dirty state', () => {
  it('is dirty after edits until the revision is saved, and again after undo', () => {
    const store = storeWith();
    expect(store.dirty).toBe(false);
    store.update('Rename', (p) => { p.name = 'x'; }, { structural: false });
    expect(store.dirty).toBe(true);
    store.savedRevision = store.revision;
    expect(store.dirty).toBe(false);
    store.undo();
    expect(store.dirty).toBe(true);
  });

  it('stamps the modified time on every edit', () => {
    const store = storeWith();
    store.project.modified = 0;
    store.update('Rename', (p) => { p.name = 'x'; }, { structural: false });
    expect(store.project.modified).toBeGreaterThan(0);
  });

  it('reports toggle changes and passes them to timeline operations', () => {
    const store = storeWith();
    const toggles = events(store, 'toggles');
    store.setToggle('ripple', false);
    expect(toggles).toEqual([{ name: 'ripple', value: false }]);
    expect(store.opts).toEqual({ ripple: false, linkOverlays: true });
  });
});
