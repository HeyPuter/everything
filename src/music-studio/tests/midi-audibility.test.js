import { describe, expect, it } from 'vitest';
import { compileChannel } from '../src/engine/compile.js';
import { projectToMidi } from '../src/io/midi-project.js';
import { readMidi, writeMidi } from '../src/io/midi.js';
import { createChannel, createClip, createNote, createPattern, createProject } from '../src/model/project.js';

function fixture() {
  const project = createProject();
  project.channels = ['Lead', 'Bass', 'Drum'].map((name, i) => createChannel({ name, type: i === 2 ? 'drum' : 'synth' }));
  const pattern = createPattern(0);
  pattern.notes = Object.fromEntries(project.channels.map((ch, i) => [ch.id, [createNote({ key: 60 + i, pos: 0, len: 96, vel: 1 })]]));
  project.patterns = [pattern];
  project.clips = [createClip({ kind: 'pattern', ref: pattern.id, start: 0, len: 384, track: 0 })];
  return project;
}

describe.each(['song', 'pattern'])('MIDI %s channel audibility', (mode) => {
  it.each(['mute', 'solo', 'muted solo'])('respects rack %s when exporting notes', (state) => {
    const project = fixture();
    project.channels[0].mute = state !== 'solo';
    project.channels[0].solo = state !== 'mute';
    const audible = project.channels.filter((ch, i) => compileChannel(project, ch, i).gain > 0).map((ch) => ch.name);
    expect(audible).toEqual(state === 'mute' ? ['Bass', 'Drum'] : state === 'solo' ? ['Lead'] : []);
    const exported = readMidi(writeMidi(projectToMidi(project, { mode, patternId: project.patterns[0].id })));
    expect(exported.tracks.filter((t) => t.notes.length).map((t) => t.name)).toEqual(audible);
    // Clearing the rack state restores every instrument, including percussion.
    project.channels[0].mute = false;
    project.channels[0].solo = false;
    const restored = projectToMidi(project, { mode, patternId: project.patterns[0].id });
    expect(restored.tracks.map((t) => t.name)).toEqual(['Lead', 'Bass', 'Drum']);
    expect(restored.tracks.flatMap((t) => t.notes)).toHaveLength(3);
  });
});
