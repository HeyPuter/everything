import { describe, it, expect } from 'vitest';
import { createSessionState, createTrack } from '../src/model/session-edits.js';
import { templateFromState, stateFromTemplate, userTemplates, saveTemplate, deleteTemplate } from '../src/multitrack/templates.js';
import { Prefs } from '../src/lib/prefs.js';

describe('session templates', () => {
  it('keeps tracks, bus routing, effects, master and tempo but no clips', () => {
    const state = createSessionState({ tracks: 0, template: [{ name: 'Voice', channels: 1, output: 'Vox Bus', volume: -3, pan: 20 }, { name: 'Vox Bus', type: 'bus', fx: [{ id: 's1', effect: 'deesser', values: { threshold: -20 }, enabled: true }] }] });
    state.master = createTrack({ ...state.master, volume: -1.5 });
    state.tempo = 96;
    state.clips = [{ id: 'c1' }];
    const t = templateFromState(state, 'Interview');
    expect(t.label).toBe('Interview');
    expect(t.tracks[0]).toMatchObject({ name: 'Voice', channels: 1, volume: -3, pan: 20, output: 'Vox Bus' });
    expect(t.tracks[1].fx[0].effect).toBe('deesser');
    const next = stateFromTemplate(t, { sampleRate: 44100, bitDepth: 24, autoCrossfade: true });
    expect(next.sampleRate).toBe(44100);
    expect(next.tempo).toBe(96);
    expect(next.master.volume).toBe(-1.5);
    expect(next.clips).toEqual([]);
    const bus = next.tracks.find((x) => x.type === 'bus');
    expect(next.tracks[0].output).toBe(bus.id);
    expect(next.tracks[0].id).not.toBe(state.tracks[0].id);
  });

  it('keeps sends to buses and track and master EQ', () => {
    const state = createSessionState({ tracks: 0, template: [{ name: 'Voice', channels: 1 }, { name: 'Verb', type: 'bus' }] });
    const verb = state.tracks[1].id;
    state.tracks[0] = createTrack({ ...state.tracks[0], sends: [{ target: verb, level: -6, pre: true }], eq: { on: true, values: { gain1: 3 } } });
    state.master = createTrack({ ...state.master, eq: { on: true, values: { gain2: -2 } } });
    const t = JSON.parse(JSON.stringify(templateFromState(state, 'Verb')));
    const next = stateFromTemplate(t, { sampleRate: 48000, bitDepth: 32, autoCrossfade: true });
    const bus = next.tracks.find((x) => x.type === 'bus');
    expect(next.tracks[0].sends).toHaveLength(1);
    expect(next.tracks[0].sends[0]).toMatchObject({ target: bus.id, level: -6, pre: true, on: true });
    expect(next.tracks[0].sends[0].id).not.toBe(state.tracks[0].sends[0].id);
    expect(next.tracks[0].eq).toEqual({ on: true, values: { gain1: 3 } });
    expect(next.master.eq).toEqual({ on: true, values: { gain2: -2 } });
  });

  it('stores templates by name', () => {
    const prefs = new Prefs({ getItem: () => null, setItem: () => {} });
    saveTemplate(prefs, { id: 'a', label: 'Podcast 2' });
    saveTemplate(prefs, { id: 'b', label: 'podcast 2' });
    expect(userTemplates(prefs).map((t) => t.id)).toEqual(['b']);
    deleteTemplate(prefs, 'b');
    expect(userTemplates(prefs)).toEqual([]);
  });
});

describe('bring clips to front on select', () => {
  it('reorders without an undo step and keeps a saved session saved', async () => {
    const { Session } = await import('../src/model/session.js');
    const { createClip, addClips } = await import('../src/model/session-edits.js');
    const doc = new Session({ name: 'S.asesx', tracks: 1 });
    const t = doc.state.tracks[0].id;
    doc.apply('Clips', addClips(doc.state, [createClip({ id: 'a', trackId: t, start: 0, length: 100 }), createClip({ id: 'b', trackId: t, start: 50, length: 100, z: 1 })]));
    doc.markSaved();
    const steps = doc.history.entries.length;
    expect(doc.raiseClips(['a'])).toBe(true);
    expect(doc.history.entries.length).toBe(steps);
    expect(doc.dirty).toBe(false);
    expect(doc.state.clips.find((c) => c.id === 'a').z).toBeGreaterThan(1);
    doc.history.undo();
    expect(doc.state.clips.find((c) => c.id === 'a')?.z ?? 2).toBeGreaterThan(1);
  });
});
