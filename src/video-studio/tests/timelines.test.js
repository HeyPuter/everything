import { describe, it, expect } from 'vitest';
import * as TL from '../src/model/timelines.js';
import { normalizeProject } from '../src/model/project.js';
import { mainTrack, allClips, addClip, findClip } from '../src/model/timeline.js';
import { allClipsDeep, removeAssetClips } from '../src/model/compound.js';
import { EditorStore } from '../src/model/store.js';
import { unusedAssets, swapAsset } from '../src/ui/media-actions.js';
import { settingsForRatio } from '../src/ui/timeline-actions.js';
import { fixture, clip, onMain, s } from './helpers.js';

const RIPPLE = { ripple: true, linkOverlays: true };
const FREE = { ripple: false, linkOverlays: false };

/** A project with two clips on Timeline 1 and an empty second timeline (stored). */
function twoTimelines() {
  const p = fixture();
  onMain(p, clip('video', 0, 2), clip('image', 2, 3));
  TL.ensureTimelines(p);
  const second = TL.addTimeline(p, { name: 'Short' });
  return { p, first: p.timelineId, second };
}

describe('timelines model', () => {
  it('lists a plain project as one open timeline', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    const list = TL.listTimelines(p);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Timeline 1', active: true, duration: s(4), clips: 1 });
    expect(TL.activeTimeline(p).name).toBe('Timeline 1');
  });

  it('adds an empty timeline after the open one without opening it', () => {
    const { p, first, second } = twoTimelines();
    expect(p.timelineId).toBe(first);
    expect(p.timelines.map((t) => t.name)).toEqual(['Timeline 1', 'Short']);
    const stored = p.timelines[1];
    expect(stored.tracks).toHaveLength(1);
    expect(stored.tracks[0].main).toBe(true);
    expect(stored.settings).toEqual(p.settings);
    expect(stored.settings).not.toBe(p.settings);
    expect(TL.listTimelines(p).find((t) => t.id === second)).toMatchObject({ active: false, clips: 0, duration: 0 });
  });

  it('switches by swapping contents in and out of the top level', () => {
    const { p, first, second } = twoTimelines();
    const firstTracks = p.tracks;
    p.markers.push({ id: 'm1', time: s(1), color: '#fff', label: 'A' });
    p.range = { in: 0, out: s(1) };
    expect(TL.switchTimeline(p, second)).toBe(true);
    expect(p.timelineId).toBe(second);
    expect(allClips(p)).toHaveLength(0);
    expect(p.markers).toEqual([]);
    expect(p.range).toBeUndefined();
    const stored = p.timelines.find((t) => t.id === first);
    expect(stored.tracks).toBe(firstTracks);
    expect(stored.markers).toHaveLength(1);
    expect(stored.range).toEqual({ in: 0, out: s(1) });
    // The open timeline's entry only keeps its name.
    expect(Object.keys(p.timelines.find((t) => t.id === second)).sort()).toEqual(['id', 'name']);
    expect(TL.switchTimeline(p, first)).toBe(true);
    expect(allClips(p)).toHaveLength(2);
    expect(p.range).toEqual({ in: 0, out: s(1) });
    expect(TL.switchTimeline(p, first)).toBe(false);
    expect(TL.switchTimeline(p, 'nope')).toBe(false);
  });

  it('keeps each timeline its own frame settings', () => {
    const { p, second } = twoTimelines();
    TL.switchTimeline(p, second);
    p.settings = settingsForRatio(p.settings, '9:16');
    expect(p.settings).toMatchObject({ ratio: '9:16', width: 1080, height: 1920 });
    TL.switchTimeline(p, p.timelines[0].id);
    expect(p.settings).toMatchObject({ ratio: '16:9', width: 1920, height: 1080 });
  });

  it('duplicates with fresh ids so the copies are independent', () => {
    const { p, first } = twoTimelines();
    const [a] = mainTrack(p).clips;
    p.markers.push({ id: 'm1', time: 0, color: '#fff', label: '' });
    const copy = TL.duplicateTimeline(p, first);
    const entry = p.timelines.find((t) => t.id === copy);
    expect(entry.name).toBe('Timeline 1 copy');
    expect(p.timelines.indexOf(entry)).toBe(1);
    const ids = entry.tracks.flatMap((t) => t.clips.map((c) => c.id));
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(a.id);
    expect(entry.markers[0].id).not.toBe('m1');
    entry.tracks[0].clips[0].duration = s(1);
    expect(a.duration).toBe(s(2));
    expect(TL.duplicateTimeline(p, first)).toBeTruthy();
    expect(p.timelines.map((t) => t.name)).toContain('Timeline 1 copy 2');
  });

  it('keeps clip groups together in a copy', () => {
    const { p, first } = twoTimelines();
    const [a, b] = mainTrack(p).clips;
    a.group = 'g1';
    b.group = 'g1';
    const copyId = TL.duplicateTimeline(p, first);
    const copy = p.timelines.find((t) => t.id === copyId);
    const [ca, cb] = copy.tracks[0].clips;
    expect(ca.group).toBe(cb.group);
    expect(ca.group).not.toBe('g1');
  });

  it('renames, rejecting blank names', () => {
    const { p, second } = twoTimelines();
    expect(TL.renameTimeline(p, second, '  Vertical   cut ')).toBe(true);
    expect(TL.listTimelines(p)[1].name).toBe('Vertical cut');
    expect(TL.renameTimeline(p, second, '   ')).toBe(false);
  });

  it('gives new timelines unused names', () => {
    const { p } = twoTimelines();
    TL.addTimeline(p);
    TL.addTimeline(p, { name: 'Short' });
    expect(TL.listTimelines(p).map((t) => t.name)).toEqual(['Timeline 1', 'Short 2', 'Timeline 2', 'Short']);
  });

  it('deletes, opening a neighbor first when the open one goes', () => {
    const { p, first, second } = twoTimelines();
    const third = TL.addTimeline(p, { name: 'Third' });
    expect(TL.deleteTimeline(p, first)).toBe(true);
    expect(p.timelineId).toBe(third);
    expect(TL.listTimelines(p).map((t) => t.name)).toEqual(['Third', 'Short']);
    expect(TL.deleteTimeline(p, second)).toBe(true);
    // One custom-named timeline stays listed; the last one can't go.
    expect(TL.deleteTimeline(p, third)).toBe(false);
    expect(TL.activeTimeline(p).name).toBe('Third');
  });

  it('goes back to a plain project when only the default timeline is left', () => {
    const { p, second } = twoTimelines();
    TL.deleteTimeline(p, second);
    expect(p.timelines).toBeUndefined();
    expect(p.timelineId).toBeUndefined();
    expect(allClips(p)).toHaveLength(2);
  });

  it('reorders', () => {
    const { p, second } = twoTimelines();
    expect(TL.moveTimeline(p, second, 0)).toBe(true);
    expect(TL.listTimelines(p).map((t) => t.name)).toEqual(['Short', 'Timeline 1']);
    expect(TL.moveTimeline(p, second, 0)).toBe(false);
  });

  it('inserts another timeline as a compound clip with fresh ids', () => {
    const { p, first, second } = twoTimelines();
    const ids = allClips(p).map((c) => c.id);
    TL.switchTimeline(p, second);
    const c = TL.insertTimeline(p, first, s(1), { ...RIPPLE, main: true });
    expect(c.type).toBe('compound');
    expect(c.name).toBe('Timeline 1');
    expect(c.duration).toBe(s(5));
    expect(mainTrack(p).clips).toEqual([c]);
    const inner = c.sequence.tracks.flatMap((t) => t.clips.map((x) => x.id));
    expect(inner).toHaveLength(2);
    for (const id of inner) expect(ids).not.toContain(id);
    // Not itself, nor an empty one.
    expect(TL.insertTimeline(p, second, 0, FREE)).toBeNull();
    const empty = TL.addTimeline(p);
    expect(TL.insertTimeline(p, empty, 0, FREE)).toBeNull();
  });

  it('caps how many timelines a project holds', () => {
    const p = fixture();
    TL.ensureTimelines(p);
    for (let i = 1; i < TL.MAX_TIMELINES; i++) expect(TL.addTimeline(p)).toBeTruthy();
    expect(TL.addTimeline(p)).toBeNull();
    expect(TL.duplicateTimeline(p, p.timelineId)).toBeNull();
  });
});

describe('media across timelines', () => {
  it('counts clips on stored timelines as using their media', () => {
    const { p, second } = twoTimelines();
    TL.switchTimeline(p, second);
    expect(allClips(p)).toHaveLength(0);
    expect(allClipsDeep(p).map((c) => c.assetId).sort()).toEqual(['img', 'vid']);
    expect(unusedAssets(p).map((a) => a.id).sort()).toEqual(['aud', 'silent']);
  });

  it('swaps and removes media on every timeline', () => {
    const { p, second } = twoTimelines();
    TL.switchTimeline(p, second);
    addClip(p, clip('video', 0, 1), { ...FREE, main: true });
    swapAsset(p, 'vid', { ...p.assets.vid, id: 'vid2' });
    expect(allClipsDeep(p).filter((c) => c.assetId === 'vid2')).toHaveLength(2);
    removeAssetClips(p, ['vid2']);
    expect(allClipsDeep(p).map((c) => c.assetId)).toEqual(['img']);
  });
});

describe('saving timelines', () => {
  it('round-trips through normalizeProject', () => {
    const { p, first, second } = twoTimelines();
    TL.switchTimeline(p, second);
    p.settings = settingsForRatio(p.settings, '9:16');
    addClip(p, clip('image', 0, 2), { ...FREE, main: true });
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(n.timelineId).toBe(second);
    expect(n.timelines.map((t) => t.id)).toEqual([first, second]);
    expect(n.settings.ratio).toBe('9:16');
    expect(allClips(n)).toHaveLength(1);
    const stored = n.timelines[0];
    expect(stored.settings.ratio).toBe('16:9');
    expect(stored.tracks.flatMap((t) => t.clips)).toHaveLength(2);
    expect(Object.keys(n.timelines[1]).sort()).toEqual(['id', 'name']);
  });

  it('checks stored timelines against the media', () => {
    const { p } = twoTimelines();
    const raw = JSON.parse(JSON.stringify(p));
    raw.timelines[1].tracks[0].clips.push({ ...clip('video', 0, 1), assetId: 'missing' }, { ...clip('image', 1, 1) });
    raw.timelines[1].settings = { width: 99999, fps: 7 };
    const n = normalizeProject(raw);
    const stored = n.timelines[1];
    expect(stored.tracks.flatMap((t) => t.clips).map((c) => c.assetId)).toEqual(['img']);
    expect(stored.settings.fps).toBe(30);
    expect(stored.settings.width).toBeLessThanOrEqual(8192);
  });

  it('drops a timeline list without the open timeline, and duplicate ids', () => {
    const { p } = twoTimelines();
    const raw = JSON.parse(JSON.stringify(p));
    raw.timelines.push({ ...raw.timelines[1] });
    expect(normalizeProject(raw).timelines).toHaveLength(2);
    raw.timelineId = 'gone';
    const n = normalizeProject(raw);
    expect(n.timelines).toBeUndefined();
    expect(allClips(n)).toHaveLength(2);
  });

  it('ignores timelines nested inside stored timelines', () => {
    const { p } = twoTimelines();
    const raw = JSON.parse(JSON.stringify(p));
    raw.timelines[1].timelines = [{ id: 'x', name: 'x' }];
    raw.timelines[1].timelineId = 'x';
    expect(normalizeProject(raw).timelines[1].timelines).toBeUndefined();
  });
});

describe('store: opening timelines', () => {
  it('opens a timeline without an undo step and remembers each playhead', () => {
    const { p, first, second } = twoTimelines();
    const store = new EditorStore(p);
    const events = [];
    store.on('timeline', (e) => events.push(e.id));
    store.seek(s(3));
    store.select(mainTrack(p).clips[0].id);
    expect(store.openTimeline(second)).toBe(true);
    expect(store.selection.size).toBe(0);
    expect(store.time).toBe(0);
    expect(store.history.canUndo()).toBe(false);
    expect(events).toEqual([second]);
    store.openTimeline(first);
    expect(store.time).toBe(s(3));
    expect(store.openTimeline(first)).toBe(false);
  });

  it('undo goes back to the timeline the edit was made on', () => {
    const { p, first, second } = twoTimelines();
    const store = new EditorStore(p);
    store.update('Trim', (q) => {
      mainTrack(q).clips[0].duration = s(1);
    });
    store.openTimeline(second);
    store.update('Add', (q) => {
      addClip(q, clip('image', 0, 1), { ...FREE, main: true });
    });
    store.undo();
    expect(store.project.timelineId).toBe(second);
    expect(allClips(store.project)).toHaveLength(0);
    store.undo();
    expect(store.project.timelineId).toBe(first);
    expect(mainTrack(store.project).clips[0].duration).toBe(s(2));
    store.redo();
    store.redo();
    expect(store.project.timelineId).toBe(second);
    expect(allClips(store.project)).toHaveLength(1);
    const stored = store.project.timelines.find((t) => t.id === first);
    expect(stored.tracks.find((t) => t.main).clips[0].duration).toBe(s(1));
  });

  it('closes compound clips being edited first', () => {
    const { p, second } = twoTimelines();
    const store = new EditorStore(p);
    store.update('Insert', (q) => {
      TL.switchTimeline(q, second);
      TL.insertTimeline(q, q.timelines[0].id, 0, { ...FREE, main: true });
    });
    const comp = mainTrack(store.project).clips[0];
    expect(store.openCompound(comp.id)).toBe(true);
    store.openTimeline(store.project.timelines[0].id);
    expect(store.nest).toHaveLength(0);
    expect(findClip(store.project, comp.id)).toBeNull();
  });
});
