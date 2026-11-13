import { describe, expect, it } from 'vitest';
import { registerCoreCommands } from '../src/commands/core.js';
import { Store } from '../src/model/store.js';
import { createProject, createChannel, createNote } from '../src/model/project.js';
import { compileSequence } from '../src/engine/compile.js';
import { parseProject, serializeProject } from '../src/model/serialize.js';

function setup(length = null) {
  const project = createProject();
  project.channels = [createChannel({ name: 'Kick' }), createChannel({ name: 'Bass' })];
  const source = project.patterns[0];
  source.length = length;
  source.notes = {
    [project.channels[0].id]: [createNote({ pos: 0 })],
    [project.channels[1].id]: [createNote({ pos: 800 })],
  };
  const store = new Store(project);
  const commands = new Map();
  registerCoreCommands({ store, commands: { register: (...items) => items.forEach((item) => commands.set(item.id, item)) } });
  return { store, source, split: commands.get('patterns.splitByChannel') };
}

const sequence = (project, patternId) => compileSequence(project, { patternId, slotOf: (id) => project.channels.findIndex((ch) => ch.id === id) });

describe('split by channel', () => {
  it.each([null, 1536, 384])('preserves playback timing with source length %s', (length) => {
    const { store, source, split } = setup(length);
    const original = store.project;
    const before = sequence(original, source.id);
    expect(split.enabled()).toBe(true);
    split.run();
    const parts = store.project.patterns.slice(1);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      const cid = Object.keys(part.notes)[0];
      const slot = original.channels.findIndex((ch) => ch.id === cid);
      const after = sequence(store.project, part.id);
      expect(after.end).toBe(before.end);
      const originalStarts = Array.from(before.notes.start).filter((_, i) => before.notes.slot[i] === slot);
      expect(Array.from(after.notes.start)).toEqual(originalStarts);
      expect(part.notes[cid]).toEqual(source.notes[cid]);
      expect(sequence(parseProject(serializeProject(store.project)), part.id).end).toBe(before.end);
    }
    expect(store.project.patterns[0]).toBe(source);
    store.undo();
    expect(store.project).toBe(original);
    store.redo();
    expect(store.project.patterns).toHaveLength(3);
  });
});

it.each(['A'.repeat(60), 'A'.repeat(52) + '🎹abcdef'])('keeps split channel names identifiable after saving %s', (name) => {
  const { store, source, split } = setup();
  source.name = name;
  split.run();
  const parts = store.project.patterns.slice(1);
  const reopened = parseProject(serializeProject(store.project)).patterns.slice(1);
  expect(reopened.map((p) => p.name)).toEqual(parts.map((p) => p.name));
  for (let i = 0; i < parts.length; i++) {
    expect(parts[i].name.length).toBeLessThanOrEqual(60);
    expect(parts[i].name.endsWith(` - ${store.project.channels[i].name}`)).toBe(true);
    expect(parts[i].name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  }
  expect(new Set(reopened.map((p) => p.name)).size).toBe(2);
});

it('keeps ordinary split names unchanged', () => {
  const { store, source, split } = setup();
  source.name = 'Verse';
  split.run();
  expect(store.project.patterns.slice(1).map((p) => p.name)).toEqual(['Verse - Kick', 'Verse - Bass']);
});

it.each(['Intro', 'P'.repeat(27) + '🎹' + 'P'.repeat(31)])('retains both labels with long channel names and source %s', (name) => {
  const { store, source, split } = setup();
  source.name = name;
  store.project.channels[0].name = 'C'.repeat(28) + '🎸' + 'C'.repeat(30);
  split.run();
  const part = store.project.patterns[1];
  const [patternLabel, channelLabel] = part.name.split(' - ');
  expect(patternLabel.length).toBeGreaterThan(0);
  expect(channelLabel.length).toBeGreaterThan(0);
  expect(name.startsWith(patternLabel)).toBe(true);
  expect(store.project.channels[0].name.startsWith(channelLabel)).toBe(true);
  expect(part.name.length).toBeLessThanOrEqual(60);
  expect(part.name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  expect(parseProject(serializeProject(store.project)).patterns[1].name).toBe(part.name);
});
