import { describe, it, expect } from 'vitest';
import * as E from '../src/model/edits.js';
import { createProject, createChannel, patternLength, songLength, channelAudible, freeInsert } from '../src/model/project.js';
import { newProject, demoProject } from '../src/model/demo.js';
import { STEP, PPQ, formatBST, formatTime, snapTicks, gridTicks, ceilToBar } from '../src/model/time.js';

describe('time', () => {
  it('formats bar:step:tick from one', () => {
    expect(formatBST(0)).toBe('1:01:00');
    expect(formatBST(STEP)).toBe('1:02:00');
    expect(formatBST(PPQ * 4 + 5)).toBe('2:01:05');
    expect(formatBST(PPQ * 3, [3, 4])).toBe('2:01:00');
  });
  it('formats minutes and seconds at a tempo', () => {
    expect(formatTime(PPQ * 2, 120)).toBe('0:01:00');
    expect(formatTime(PPQ * 240, 120)).toBe('2:00:00');
  });
  it('picks a grid that keeps lines apart and resolves snaps', () => {
    expect(gridTicks(1)).toBe(STEP / 2); // 12px apart at 1px per tick
    expect(gridTicks(0.01)).toBeGreaterThanOrEqual(PPQ * 4);
    expect(snapTicks('beat', 1)).toBe(PPQ);
    expect(snapTicks('bar', 1, [3, 4])).toBe(PPQ * 3);
    expect(snapTicks('none', 1)).toBe(0);
    expect(ceilToBar(1)).toBe(PPQ * 4);
  });
});

describe('edits', () => {
  it('toggles steps as one-step notes at the channel root key', () => {
    const p0 = newProject();
    const pat = p0.patterns[0].id;
    const ch = p0.channels[0].id;
    const p1 = E.toggleStep(p0, pat, ch, 4);
    const notes = E.getNotes(p1, pat, ch);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ pos: 4 * STEP, len: STEP, key: 60 });
    expect(E.stepOn(notes, 4)).toBe(true);
    const p2 = E.toggleStep(p1, pat, ch, 4);
    expect(E.getNotes(p2, pat, ch)).toHaveLength(0);
    expect(p2.patterns[0].notes[ch]).toBeUndefined();
  });

  it('shares unchanged structure', () => {
    const p0 = newProject();
    const p1 = E.updateChannel(p0, p0.channels[1].id, { volume: 0.5 });
    expect(p1.channels[0]).toBe(p0.channels[0]);
    expect(p1.patterns).toBe(p0.patterns);
    expect(E.updateChannel(p1, p1.channels[1].id, { volume: 0.5 })).toBe(p1);
  });

  it('removes a channel with its notes and audio clips', () => {
    let p = demoProject();
    const bass = p.channels.find((c) => c.name === 'Bass').id;
    p = E.removeChannels(p, [bass]);
    expect(p.channels.some((c) => c.id === bass)).toBe(false);
    for (const pat of p.patterns) expect(pat.notes[bass]).toBeUndefined();
  });

  it('keeps at least one pattern and drops a deleted pattern\'s clips', () => {
    let p = demoProject();
    const beat = p.patterns[0].id;
    p = E.removePattern(p, beat);
    expect(p.clips.some((c) => c.ref === beat)).toBe(false);
    const single = createProject();
    expect(E.removePattern(single, single.patterns[0].id)).toBe(single);
  });

  it('moves playlist tracks with their clips', () => {
    let p = demoProject();
    const lead = p.clips.find((c) => c.track === 3);
    p = E.moveTrack(p, 3, 0);
    expect(p.tracks[0].name).toBe('Lead');
    expect(p.clips.find((c) => c.id === lead.id).track).toBe(0);
  });

  it('refuses routing loops', () => {
    let p = createProject();
    p = E.setRoute(p, 1, 2, 1);
    expect(p.mixer[1].routes[2]).toBe(1);
    const same = E.setRoute(p, 2, 1, 1);
    expect(same.mixer[2].routes[1]).toBeUndefined();
  });

  it('solos one channel and clears solo on a second click', () => {
    let p = newProject();
    const id = p.channels[1].id;
    p = E.soloChannel(p, id);
    expect(p.channels.filter((c) => channelAudible(p, c)).map((c) => c.id)).toEqual([id]);
    p = E.soloChannel(p, id);
    expect(p.channels.every((c) => channelAudible(p, c))).toBe(true);
  });

  it('measures patterns and songs in whole bars', () => {
    const p = demoProject();
    expect(patternLength(p.patterns[0])).toBe(PPQ * 4);
    expect(patternLength(p.patterns[3])).toBe(PPQ * 16);
    expect(songLength(p)).toBe(PPQ * 32);
  });

  it('caps effect slots', () => {
    let p = createProject();
    for (let i = 0; i < 12; i++) p = E.addSlot(p, 0, 'eq').project;
    expect(p.mixer[0].fx).toHaveLength(10);
  });

  it('clones channels with notes', () => {
    const p0 = demoProject();
    const kick = p0.channels[0].id;
    const { project, id } = E.cloneChannel(p0, kick, { withNotes: true });
    expect(project.channels[1].id).toBe(id);
    expect(project.patterns[0].notes[id]).toHaveLength(p0.patterns[0].notes[kick].length);
    expect(createChannel().params.cutoff).toBeGreaterThan(0);
  });
});

describe('free mixer inserts', () => {
  it('skips inserts used by channels, send targets and inserts with effects', () => {
    let p = newProject();
    const used = p.channels.map((c) => c.mixer);
    const first = freeInsert(p);
    expect(used).not.toContain(first);
    p = E.updateMixerTrack(p, first, { routes: { 0: 1, [first + 1]: 1 } });
    p = E.updateMixerTrack(p, first + 2, { fx: [{ id: 'x', type: 'reverb', on: true, mix: 1, params: {} }] });
    // `first` stays free (it only sends), the bus and the insert with effects are skipped.
    expect(freeInsert(p)).toBe(first);
    p = E.addChannel(p, createChannel({ mixer: first }), p.channels.length);
    expect(freeInsert(p)).toBe(first + 3);
  });
});
