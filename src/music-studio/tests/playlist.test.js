import { describe, it, expect } from 'vitest';
import * as C from '../src/playlist/clips.js';
import { trackLayout, trackAt, trackTop, trackHeight, clipZone } from '../src/playlist/geometry.js';
import { DEFAULT_TRACK_H } from '../src/playlist/constants.js';
import { demoProject } from '../src/model/demo.js';
import { createProject, createChannel } from '../src/model/project.js';
import * as E from '../src/model/edits.js';
import { PPQ, snapFloor } from '../src/model/time.js';

const BAR = PPQ * 4;
const byNum = (a, b) => a[0] - b[0] || a[1] - b[1];

function project() {
  return demoProject();
}

describe('sources and placement', () => {
  it('uses natural lengths for patterns, audio and automation', () => {
    let p = project();
    const beat = p.patterns[0];
    expect(C.sourceLength(p, { kind: 'pattern', id: beat.id })).toBe(BAR);
    expect(C.sourceLength(p, { kind: 'pattern', id: p.patterns[1].id })).toBe(BAR * 4);
    // 2 seconds at 120 BPM is 4 beats.
    let r = E.addSample(p, { id: 's1', duration: 2 });
    p = { ...r.project, bpm: 120 };
    const ch = createChannel({ type: 'audio', name: 'Vox', sample: 's1' });
    p = E.addChannel(p, ch);
    expect(C.sourceLength(p, { kind: 'audio', id: ch.id })).toBe(PPQ * 4);
    expect(C.sourceLength(p, { kind: 'audio', id: ch.id }, { s1: 1 })).toBe(PPQ * 2);
    r = E.addAutomation(p, { points: [{ t: 0, v: 0 }, { t: BAR * 2, v: 1 }] });
    expect(C.sourceLength(r.project, { kind: 'auto', id: r.id })).toBe(BAR * 2);
    expect(C.sourceLength(p, null)).toBe(BAR);
  });

  it('places a clip at a snapped position and adds tracks when needed', () => {
    const p = project();
    const src = { kind: 'pattern', id: p.patterns[0].id };
    const tick = snapFloor(BAR * 2 + 50, BAR);
    const r = C.placeClip(p, src, 20, tick);
    const clip = r.project.clips.find((c) => c.id === r.id);
    expect(clip).toMatchObject({ kind: 'pattern', track: 20, start: BAR * 2, len: BAR, offset: 0, ref: src.id });
    expect(r.project.tracks.length).toBe(21);
  });

  it('computes paint positions in both directions', () => {
    expect(C.paintStarts(BAR, BAR, BAR * 3 + 10)).toEqual([BAR, BAR * 2, BAR * 3]);
    expect(C.paintStarts(BAR * 3, BAR, BAR + 10)).toEqual([BAR * 3, BAR * 2, BAR]);
    expect(C.paintStarts(BAR, BAR, BAR - 500)).toEqual([BAR, 0]);
  });

  it('finds the first free track for a range', () => {
    const p = project();
    expect(C.firstFreeTrack(p, 0, BAR)).toBe(3); // tracks 1..3 are busy in bar 1; the lead starts at bar 5
    expect(C.firstFreeTrack(p, BAR * 4, BAR * 5)).toBe(4);
  });
});

describe('indexing and hit testing', () => {
  it('groups clips by track sorted by start and finds the clip under a tick', () => {
    const p = project();
    const by = C.clipsByTrack(p.clips, p.tracks.length);
    expect(by).toHaveLength(p.tracks.length);
    expect(by[0].map((c) => c.start)).toEqual(Array.from({ length: 8 }, (_, i) => i * BAR));
    expect(C.clipAt(by, 1, BAR * 5).start).toBe(BAR * 4);
    expect(C.clipAt(by, 3, 10)).toBeNull();
    expect(C.clipAt(by, 99, 10)).toBeNull();
  });

  it('collects clips in a marquee range', () => {
    const p = project();
    const ids = C.clipsInRange(p.clips, BAR * 3 + 1, BAR * 4 + 1, 0, 1);
    const picked = p.clips.filter((c) => ids.includes(c.id));
    expect(picked.map((c) => [c.track, c.start / BAR]).sort(byNum)).toEqual([[0, 3], [0, 4], [1, 0], [1, 4]]);
  });

  it('lays tracks out and maps y to tracks, also past the end', () => {
    const L = trackLayout([{ height: 30 }, { height: 50 }, {}]);
    expect(Array.from(L.tops)).toEqual([0, 30, 80, 80 + DEFAULT_TRACK_H]);
    expect(trackAt(L, 0)).toBe(0);
    expect(trackAt(L, 29.9)).toBe(0);
    expect(trackAt(L, 30)).toBe(1);
    expect(trackAt(L, 79)).toBe(1);
    expect(trackAt(L, 81)).toBe(2);
    expect(trackAt(L, L.total + 1)).toBe(3);
    expect(trackAt(L, L.total + DEFAULT_TRACK_H * 2 + 1)).toBe(5);
    expect(trackAt(L, -10)).toBe(0);
    expect(trackTop(L, 4)).toBe(L.total + DEFAULT_TRACK_H);
    expect(trackHeight(L, 1)).toBe(50);
  });

  it('splits clips into edge and body zones', () => {
    expect(clipZone(100, 80, 102)).toBe('left');
    expect(clipZone(100, 80, 177)).toBe('right');
    expect(clipZone(100, 80, 140)).toBe('body');
    // Narrow clips keep a body.
    expect(clipZone(100, 12, 106)).toBe('body');
  });
});

describe('moving, duplicating and resizing', () => {
  it('moves several clips together across tracks, adding tracks at the bottom', () => {
    const p = project();
    const ids = p.clips.filter((c) => c.track === 1).map((c) => c.id);
    const r = C.moveClips(p, ids, BAR, 15);
    const moved = r.project.clips.filter((c) => ids.includes(c.id));
    expect(moved.map((c) => [c.track, c.start / BAR])).toEqual([[16, 1], [16, 5]]);
    expect(r.project.tracks.length).toBe(17);
  });

  it('clamps moves at tick 0 and track 1', () => {
    const p = project();
    const id = p.clips.find((c) => c.track === 1 && c.start === BAR * 4).id;
    const r = C.moveClips(p, [id], -BAR * 10, -5);
    expect(r.project.clips.find((c) => c.id === id)).toMatchObject({ start: 0, track: 0 });
  });

  it('duplicates on move and right after the selection', () => {
    const p = project();
    const ids = p.clips.filter((c) => c.track === 2).map((c) => c.id);
    const d = C.moveClips(p, ids, 0, 2, { duplicate: true });
    expect(d.project.clips).toHaveLength(p.clips.length + 2);
    expect(d.project.clips.filter((c) => d.ids.includes(c.id)).every((c) => c.track === 4)).toBe(true);
    const r = C.duplicateClips(p, ids);
    const copies = r.project.clips.filter((c) => r.ids.includes(c.id));
    expect(copies.map((c) => c.start / BAR).sort((a, b) => a - b)).toEqual([8, 12]);
  });

  it('resizes the right edge and trims the left edge keeping content in place', () => {
    const p = project();
    const clip = p.clips.find((c) => c.track === 1 && c.start === 0);
    const a = C.resizeClips(p, [clip.id], 'right', -BAR, { minLen: 24 }).clips.find((c) => c.id === clip.id);
    expect(a.len).toBe(BAR * 3);
    const b = C.resizeClips(p, [clip.id], 'left', BAR).clips.find((c) => c.id === clip.id);
    expect(b).toMatchObject({ start: BAR, len: BAR * 3, offset: BAR });
    // Extending left is limited by the offset.
    const c2 = C.resizeClips({ ...p, clips: p.clips.map((c) => (c.id === clip.id ? b : c)) }, [clip.id], 'left', -BAR * 3).clips.find((c) => c.id === clip.id);
    expect(c2).toMatchObject({ start: 0, len: BAR * 4, offset: 0 });
    const tiny = C.resizeClips(p, [clip.id], 'right', -BAR * 10, { minLen: 24 }).clips.find((c) => c.id === clip.id);
    expect(tiny.len).toBe(24);
  });
});

describe('slicing', () => {
  it('splits a clip with correct offsets on both halves', () => {
    const clip = { id: 'a', kind: 'pattern', track: 0, start: 100, len: 400, offset: 30, ref: 'p', mute: false };
    const [l, r] = C.splitClip(clip, 250);
    expect(l).toMatchObject({ id: 'a', start: 100, len: 150, offset: 30 });
    expect(r).toMatchObject({ start: 250, len: 250, offset: 180, ref: 'p' });
    expect(r.id).not.toBe('a');
    expect(C.splitClip(clip, 100)).toBeNull();
    expect(C.splitClip(clip, 500)).toBeNull();
  });

  it('slices only clips that pass the filter', () => {
    const p = project();
    const r = C.sliceClips(p, BAR * 2, (c) => c.track === 1);
    expect(r.ids).toHaveLength(1);
    expect(r.project.clips).toHaveLength(p.clips.length + 1);
    const halves = r.project.clips.filter((c) => c.track === 1 && c.start < BAR * 4);
    expect(halves.map((c) => [c.start, c.len, c.offset])).toEqual([[0, BAR * 2, 0], [BAR * 2, BAR * 2, BAR * 2]]);
    expect(C.sliceClips(p, BAR * 2, () => false).project).toBe(p);
  });
});

describe('make unique, mute and clipboard', () => {
  it('clones the pattern and points only this clip at it', () => {
    const p = project();
    const clip = p.clips.find((c) => c.track === 1);
    const r = C.makeUnique(p, clip.id);
    expect(r.project.patterns).toHaveLength(p.patterns.length + 1);
    expect(r.project.clips.find((c) => c.id === clip.id).ref).toBe(r.id);
    const others = r.project.clips.filter((c) => c.track === 1 && c.id !== clip.id);
    expect(others.every((c) => c.ref === clip.ref)).toBe(true);
  });

  it('clones automation for automation clips', () => {
    let p = project();
    const a = E.addAutomation(p, { name: 'Cut', points: [{ t: 0, v: 0.2 }] });
    const placed = C.placeClip(a.project, { kind: 'auto', id: a.id }, 5, 0);
    const r = C.makeUnique(placed.project, placed.id);
    expect(Object.keys(r.project.automation)).toHaveLength(2);
    expect(r.project.automation[r.id]).toMatchObject({ name: 'Cut #2', points: [{ t: 0, v: 0.2 }] });
    expect(r.project.automation[r.id].points).not.toBe(a.project.automation[a.id].points);
  });

  it('toggles mute on a set of clips', () => {
    const p = project();
    const ids = p.clips.filter((c) => c.track === 2).map((c) => c.id);
    const m = C.toggleClipMute(p, ids);
    expect(m.clips.filter((c) => ids.includes(c.id)).every((c) => c.mute)).toBe(true);
    const u = C.toggleClipMute(m, ids);
    expect(u.clips.filter((c) => ids.includes(c.id)).every((c) => !c.mute)).toBe(true);
  });

  it('copies relative to the selection and pastes at a position and track', () => {
    const p = project();
    const ids = p.clips.filter((c) => c.track === 1 || c.track === 2).map((c) => c.id);
    const board = C.copyClips(p, ids);
    expect(board.clips.map((c) => c.track).sort()).toEqual([0, 0, 1, 1]);
    const r = C.pasteClips(p, board, BAR * 8, 6);
    const pasted = r.project.clips.filter((c) => r.ids.includes(c.id));
    expect(pasted.map((c) => [c.track, c.start / BAR]).sort(byNum)).toEqual([[6, 8], [6, 12], [7, 8], [7, 12]]);
    expect(C.copyClips(p, [])).toBeNull();
  });
});

describe('tracks', () => {
  it('inserts a track and shifts clips below it down', () => {
    const p = project();
    const n = p.tracks.length;
    const q = C.insertTrack(p, 1);
    expect(q.tracks).toHaveLength(n + 1);
    expect(q.tracks[0].name).toBe('Drums');
    expect(q.tracks[1].name).toBe('Track 2');
    expect(q.tracks[2].name).toBe('Bass');
    expect(q.tracks[5].name).toBe('Track 6'); // renumbered default name
    expect(q.clips.filter((c) => c.track === 0)).toHaveLength(8);
    expect(q.clips.filter((c) => c.track === 1)).toHaveLength(0);
    expect(q.clips.filter((c) => c.track === 2)).toHaveLength(2);
  });

  it('deletes a track with its clips and moves later clips up', () => {
    const p = project();
    const q = C.deleteTrack(p, 1);
    expect(q.tracks).toHaveLength(p.tracks.length - 1);
    expect(q.tracks[1].name).toBe('Chords');
    expect(q.clips.filter((c) => c.track === 1).every((c) => c.ref === p.patterns[2].id)).toBe(true);
    expect(q.clips).toHaveLength(p.clips.length - 2);
    expect(C.deleteTrack(p, 99)).toBe(p);
    const single = { ...createProject(), tracks: [createProject().tracks[0]] };
    expect(C.deleteTrack(single, 0).tracks).toHaveLength(1);
  });

  it('solos and mutes others like the rack', () => {
    let p = project();
    p = C.soloTrack(p, 2);
    expect(p.tracks.filter((t) => t.solo).length).toBe(1);
    expect(C.trackAudible(p, 2)).toBe(true);
    expect(C.trackAudible(p, 0)).toBe(false);
    p = C.soloTrack(p, 2);
    expect(p.tracks.some((t) => t.solo)).toBe(false);
    p = C.muteOtherTracks(p, 0);
    expect(p.tracks.filter((t) => t.mute)).toHaveLength(p.tracks.length - 1);
    p = C.muteOtherTracks(p, 0);
    expect(p.tracks.some((t) => t.mute)).toBe(false);
  });
});

describe('markers', () => {
  it('adds sorted markers with default names, renames and removes them', () => {
    let p = project();
    let r = C.addMarker(p, { pos: BAR * 4, name: C.nextMarkerName(p) });
    p = r.project;
    const second = C.addMarker(p, { pos: 0, name: C.nextMarkerName(p) });
    p = second.project;
    expect(p.markers.map((m) => m.name)).toEqual(['Marker 2', 'Marker 1']);
    p = C.updateMarker(p, r.id, { name: 'Drop' });
    expect(p.markers[1].name).toBe('Drop');
    p = C.removeMarker(p, second.id);
    expect(p.markers).toHaveLength(1);
  });
});

describe('marker navigation', () => {
  it('finds the next and previous marker, skipping one just passed while playing', () => {
    let p = createProject();
    p = C.addMarker(p, { pos: PPQ * 8, name: 'Verse' }).project;
    p = C.addMarker(p, { pos: 0, name: 'Intro' }).project;
    p = C.addMarker(p, { pos: PPQ * 16, name: 'Chorus' }).project;
    const ms = p.markers;
    expect(ms.map((m) => m.name)).toEqual(['Intro', 'Verse', 'Chorus']);
    expect(C.adjacentMarker(ms, 0, 1).name).toBe('Verse');
    expect(C.adjacentMarker(ms, PPQ * 8, 1).name).toBe('Chorus');
    expect(C.adjacentMarker(ms, PPQ * 16, 1)).toBe(null);
    expect(C.adjacentMarker(ms, PPQ * 9, -1).name).toBe('Verse');
    expect(C.adjacentMarker(ms, PPQ * 8 + 10, -1, PPQ).name).toBe('Intro');
    expect(C.adjacentMarker(ms, 0, -1)).toBe(null);
  });

  it('moves a marker and keeps the list sorted', () => {
    let p = createProject();
    const a = C.addMarker(p, { pos: 0, name: 'A' });
    p = C.addMarker(a.project, { pos: PPQ * 4, name: 'B' }).project;
    p = C.updateMarker(p, a.id, { pos: PPQ * 8 });
    expect(p.markers.map((m) => m.name)).toEqual(['B', 'A']);
  });
});

describe('audio clip length under tempo automation', () => {
  it('follows the tempo map from where the clip is placed', async () => {
    const C = await import('../src/playlist/clips.js');
    const { createProject } = await import('../src/model/project.js');
    const E = await import('../src/model/edits.js');
    let p = createProject();
    p = { ...p, bpm: 120 };
    expect(C.audioTicks(p, 2)).toBe(384); // 2 s at 120 BPM = 4 beats
    // A tempo clip holding 60 BPM (v for 60 in the 20..300 range) over the first 8 bars.
    const v = (60 - 20) / 280;
    const r = E.addAutomation(p, { name: 'Tempo', target: { kind: 'tempo' }, points: [{ t: 0, v }, { t: 3072, v }] });
    p = E.addClips(r.project, [{ kind: 'auto', ref: r.id, track: 0, start: 0, len: 3072 }]).project;
    expect(C.audioTicks(p, 2)).toBe(192); // 2 s at 60 BPM = 2 beats
    expect(C.audioTicks(p, 2, 4000)).toBe(384); // after the clip: back to 120 BPM
  });
});
