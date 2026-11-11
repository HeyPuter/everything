import { describe, it, expect } from 'vitest';
import {
  addClip, mainTrack, findClip, pasteClips, duplicateClip, splitClip,
  setDisabled, groupClips, ungroupClips, groupMembers, expandGroups, regroup, setClipLabel,
  clipsOnSide, clipsFrom, setRangeIn, setRangeOut, clearRange, rangeFromClips,
  updateMarker, adjacentMarker, renameTrack, deleteTrack, moveTrack, toggleSolo, setTrackSize, insertTrackNear,
  moveKeyTime, setKeyEaseAt, removeKeysAt, keyEaseAt,
} from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { evaluate, audibleClips, gainAt } from '../src/engine/scene.js';
import { fixture, clip, onMain, s } from './helpers.js';

const FREE = { ripple: false, linkOverlays: false };

describe('disabling clips', () => {
  it('hides a disabled clip from the picture and the mix', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    expect(evaluate(p, s(1)).length).toBe(1);
    expect(audibleClips(p).length).toBe(1);
    expect(setDisabled(p, [v.id], true)).toBe(1);
    expect(evaluate(p, s(1)).length).toBe(0);
    expect(audibleClips(p).length).toBe(0);
    expect(gainAt(v, s(1))).toBe(0);
    setDisabled(p, [v.id], false);
    expect(v.disabled).toBeUndefined();
    expect(evaluate(p, s(1)).length).toBe(1);
  });

  it('turns off a transition that touches a disabled clip', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 2));
    a.transition = { id: 'mix', duration: s(1) };
    expect(evaluate(p, s(2))[0].kind).toBe('transition');
    b.disabled = true;
    const layers = evaluate(p, s(1.8));
    expect(layers.length).toBe(1);
    expect(layers[0].clip.id).toBe(a.id);
  });

  it('skips clips on locked tracks', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    mainTrack(p).locked = true;
    expect(setDisabled(p, [v.id], true)).toBe(0);
  });

  it('survives normalization', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    v.disabled = true;
    v.label = 'green';
    v.group = 'g1';
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    const c = mainTrack(n).clips[0];
    expect(c.disabled).toBe(true);
    expect(c.label).toBe('green');
    expect(c.group).toBe('g1');
    v.label = 'not-a-color';
    v.group = '<bad>';
    const n2 = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(mainTrack(n2).clips[0].label).toBeUndefined();
    expect(mainTrack(n2).clips[0].group).toBeUndefined();
  });
});

describe('groups', () => {
  it('groups, expands and ungroups clips', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    const t = clip('text', 1, 1);
    const a = clip('audio', 0, 2);
    addClip(p, t, FREE);
    addClip(p, a, FREE);
    expect(groupClips(p, [v.id])).toBeNull();
    const g = groupClips(p, [v.id, t.id]);
    expect(g).toBeTruthy();
    expect(groupMembers(p, v.id).sort()).toEqual([v.id, t.id].sort());
    expect(expandGroups(p, [t.id, a.id]).sort()).toEqual([v.id, t.id, a.id].sort());
    // Ids of clips that are gone are left out; each member once, whatever the order.
    expect(expandGroups(p, ['gone', a.id, t.id, a.id]).sort()).toEqual([v.id, t.id, a.id].sort());
    expect(ungroupClips(p, [t.id])).toBe(2);
    expect(groupMembers(p, v.id)).toEqual([v.id]);
  });

  it('keeps both halves of a split clip in its group', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    const t = clip('text', 1, 1);
    addClip(p, t, FREE);
    groupClips(p, [v.id, t.id]);
    const right = splitClip(p, v.id, s(2));
    expect(right.group).toBe(v.group);
    expect(groupMembers(p, t.id).length).toBe(3);
  });

  it('gives pasted copies of a group a new group of their own', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    const t = clip('text', 1, 1);
    addClip(p, t, FREE);
    const g = groupClips(p, [v.id, t.id]);
    const board = [v, t].map((c) => ({ ...structuredClone(c), _main: c === v }));
    const pasted = pasteClips(p, board, s(10), FREE);
    expect(pasted.length).toBe(2);
    expect(pasted[0].group).toBeTruthy();
    expect(pasted[0].group).toBe(pasted[1].group);
    expect(pasted[0].group).not.toBe(g);
    // A single duplicated member does not keep a group of one.
    const dup = duplicateClip(p, t.id, FREE);
    expect(dup.group).toBeUndefined();
  });

  it('regroup drops groups left with one member', () => {
    const clips = regroup([{ group: 'a' }, { group: 'b' }, { group: 'b' }, {}]);
    expect(clips[0].group).toBeUndefined();
    expect(clips[1].group).toBe(clips[2].group);
    expect(clips[1].group).not.toBe('b');
  });

  it('labels clips with a color', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    setClipLabel(p, [v.id], 'blue');
    expect(v.label).toBe('blue');
    setClipLabel(p, [v.id], null);
    expect(v.label).toBeUndefined();
  });
});

describe('selecting by side of the playhead', () => {
  it('finds clips left and right of a time', () => {
    const p = fixture();
    const [a, b, c] = onMain(p, clip('video', 0, 2), clip('video', 2, 2), clip('video', 4, 2));
    expect(clipsOnSide(p, s(3), 'right')).toEqual([b.id, c.id]);
    expect(clipsOnSide(p, s(3), 'left')).toEqual([a.id, b.id]);
    expect(clipsFrom(p, b.id)).toEqual([b.id, c.id]);
    expect(clipsFrom(p, b.id, { backward: true })).toEqual([a.id, b.id]);
  });

  it('ignores locked tracks', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2));
    mainTrack(p).locked = true;
    expect(clipsOnSide(p, 0, 'right')).toEqual([]);
  });
});

describe('in and out range', () => {
  it('sets, adjusts and clears the range', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 10));
    setRangeIn(p, s(2));
    expect(p.range).toEqual({ in: s(2), out: s(10) });
    setRangeOut(p, s(6));
    expect(p.range).toEqual({ in: s(2), out: s(6) });
    // An out point before the in point starts a new range from 0.
    setRangeOut(p, s(1));
    expect(p.range).toEqual({ in: 0, out: s(1) });
    // An in point after the out point keeps the in point and extends the out.
    setRangeIn(p, s(5));
    expect(p.range.in).toBe(s(5));
    expect(p.range.out).toBeGreaterThan(s(5));
    expect(clearRange(p)).toBe(true);
    expect(p.range).toBeUndefined();
  });

  it('spans selected clips and survives normalization', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2), clip('video', 2, 3));
    rangeFromClips(p, [a.id, b.id]);
    expect(p.range).toEqual({ in: 0, out: s(5) });
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(n.range).toEqual({ in: 0, out: s(5) });
    p.range = { in: s(3), out: s(1) };
    expect(normalizeProject(JSON.parse(JSON.stringify(p))).range).toBeUndefined();
  });
});

describe('markers', () => {
  it('edits markers and finds neighbors', () => {
    const p = fixture();
    p.markers.push({ id: 'm1', time: s(1), color: '#f5b83d', label: '' }, { id: 'm2', time: s(5), color: '#f5b83d', label: '' });
    expect(updateMarker(p, 'm1', { label: 'Intro', color: '#4f8ff7', note: 'Fade here', time: s(7) })).toBe(true);
    expect(p.markers.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(adjacentMarker(p, s(5), 1).id).toBe('m1');
    expect(adjacentMarker(p, s(5), -1)).toBeNull();
    expect(adjacentMarker(p, s(6), -1).id).toBe('m2');
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(n.markers[1]).toMatchObject({ label: 'Intro', note: 'Fade here', color: '#4f8ff7' });
    updateMarker(p, 'm1', { note: '' });
    expect(p.markers[1].note).toBeUndefined();
  });
});

describe('track management', () => {
  it('renames, sizes, solos, moves and deletes tracks', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    const a1 = clip('audio', 0, 2);
    const a2 = clip('audio', 0, 2);
    addClip(p, a1, FREE);
    addClip(p, a2, FREE);
    const [t1, t2] = p.tracks.filter((t) => t.kind === 'audio');
    expect(renameTrack(p, t1.id, '  Music  ')).toBe(true);
    expect(t1.name).toBe('Music');
    renameTrack(p, t1.id, '');
    expect(t1.name).toBeUndefined();
    setTrackSize(p, t1.id, 'large');
    expect(t1.size).toBe('large');
    setTrackSize(p, t1.id, 'medium');
    expect(t1.size).toBeUndefined();
    expect(moveTrack(p, t1.id, 1)).toBe(true);
    expect(p.tracks.filter((t) => t.kind === 'audio')[0]).toBe(t2);
    expect(moveTrack(p, mainTrack(p).id, 1)).toBe(false);
    toggleSolo(p, t2.id);
    expect(audibleClips(p).map((x) => x.clip.id)).toEqual([a2.id]);
    toggleSolo(p, t2.id);
    expect(audibleClips(p).length).toBe(3);
    expect(deleteTrack(p, t2.id)).toBe(true);
    expect(findClip(p, a2.id)).toBeNull();
    // The base track is emptied, never removed.
    expect(deleteTrack(p, mainTrack(p).id)).toBe(true);
    expect(mainTrack(p).clips.length).toBe(0);
    expect(deleteTrack(p, mainTrack(p).id)).toBe(false);
  });

  it('inserts a track next to another, never a video track below the base', () => {
    const p = fixture();
    const main = mainTrack(p);
    const t = insertTrackNear(p, main.id, 'video', true);
    expect(p.tracks.indexOf(t)).toBeLessThan(p.tracks.indexOf(main));
  });

  it('keeps track names, sizes and solo through normalization', () => {
    const p = fixture();
    const a = clip('audio', 0, 2);
    addClip(p, a, FREE);
    const t = p.tracks.find((x) => x.kind === 'audio');
    Object.assign(t, { name: 'VO', size: 'small', solo: true });
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(n.tracks.find((x) => x.kind === 'audio')).toMatchObject({ name: 'VO', size: 'small', solo: true });
  });
});

describe('keyframe editing on clips', () => {
  const keyed = () => {
    const c = clip('video', 0, 4);
    c.keyframes = { x: [{ t: 0, v: 0, ease: 'linear' }, { t: s(2), v: 1, ease: 'linear' }], opacity: [{ t: s(2), v: 0.5, ease: 'linear' }] };
    return c;
  };

  it('moves every key at a time together', () => {
    const c = keyed();
    expect(moveKeyTime(c, s(2), s(3))).toBe(2);
    expect(c.keyframes.x[1].t).toBe(s(3));
    expect(c.keyframes.opacity[0].t).toBe(s(3));
    // Clamped to the clip.
    moveKeyTime(c, s(3), s(10));
    expect(c.keyframes.x[1].t).toBe(s(4));
  });

  it('replaces a key it lands on', () => {
    const c = keyed();
    moveKeyTime(c, s(2), 0);
    expect(c.keyframes.x.length).toBe(1);
    expect(c.keyframes.x[0].v).toBe(1);
  });

  it('sets and reads easing, and removes keys', () => {
    const c = keyed();
    expect(keyEaseAt(c, s(2))).toBe('linear');
    setKeyEaseAt(c, s(2), 'easeOut');
    expect(keyEaseAt(c, s(2))).toBe('easeOut');
    c.keyframes.x[1].ease = 'hold';
    expect(keyEaseAt(c, s(2))).toBe('mixed');
    expect(keyEaseAt(c, s(1))).toBeNull();
    expect(removeKeysAt(c, s(2))).toBe(2);
    expect(c.keyframes.opacity).toBeUndefined();
    expect(c.keyframes.x.length).toBe(1);
  });
});
