import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import * as P from '../src/model/project.js';
import * as E from '../src/model/edits.js';
import { demoProject } from '../src/model/demo.js';
import { makeUnique } from '../src/playlist/clips.js';
import { registerCoreCommands } from '../src/commands/core.js';
import { importMidi } from '../src/io/midi-project.js';
import { readMidi, writeMidi } from '../src/io/midi.js';
import { compileSequence } from '../src/engine/compile.js';

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
function fixture() {
  const p = P.createProject({ channels: [P.createChannel({ name: 'One' }), P.createChannel({ name: 'Two' })] });
  const pattern = p.patterns[0]; pattern.id = '00000000'; pattern.length = 768;
  pattern.notes = Object.fromEntries(p.channels.map((ch, i) => [ch.id, [{ id: `note-${i}`, key: 67 + i, pos: 0, len: 96, vel: 0.7, pan: 0 }]]));
  p.clips = ['a', 'b'].map((id) => ({ ...P.createClip({ ref: pattern.id, len: 96 }), id }));
  return { project: p, pattern };
}
function collide() {
  const random = crypto.getRandomValues.bind(crypto);
  let calls = 0;
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => bytes.length === 8 && calls++ < 2 ? bytes.fill(0) : random(bytes));
}
function collidePatterns() {
  const create = P.createPattern;
  vi.spyOn(P, 'createPattern').mockImplementation((...args) => ({ ...create(...args), id: '00000000' }));
}
function verify(project, original, id) {
  expect(id).not.toBe(original.patterns[0].id);
  expect(new Set(project.patterns.map((p) => p.id)).size).toBe(project.patterns.length);
  expect(project.patterns[0]).toBe(original.patterns[0]);
  const removed = E.removePattern(project, id);
  expect(removed.patterns[0]).toBe(original.patterns[0]);
  expect(removed.clips.filter((c) => c.ref === original.patterns[0].id)).toEqual(project.clips.filter((c) => c.ref === original.patterns[0].id));
}

it.each(['new', 'clone', 'splitByChannel'])('keeps the original pattern intact during the %s command after an ID collision', async (action) => {
  const { project, pattern } = fixture();
  const app = new App(document.createElement('div'), { project, storage: { getItem: () => null, setItem() {} } });
  app.notify = vi.fn();
  registerCoreCommands(app);
  collide();
  await app.commands.run(`patterns.${action}`);
  const next = app.store.project;
  const added = next.patterns.filter((p) => p !== pattern);
  expect(added).toHaveLength(action === 'splitByChannel' ? 2 : 1);
  for (const pat of added) verify(next, project, pat.id);
  if (action === 'new') {
    expect(app.store.view.pattern).toBe(added[0].id);
    expect(app.store.pattern.notes).toEqual({});
  } else if (action === 'clone') {
    expect(app.store.view.pattern).toBe(added[0].id);
    expect(Object.keys(app.store.pattern.notes)).toEqual(project.channels.map((c) => c.id));
    expect(app.store.pattern.length).toBe(768);
  } else {
    expect(added.map((p) => Object.keys(p.notes))).toEqual(project.channels.map((c) => [c.id]));
    expect(added.map((p) => p.length)).toEqual([768, 768]);
  }
  app.store.undo(); expect(app.store.project).toBe(project);
  app.store.redo(); expect(app.store.project).toBe(next);
});

it('makes only the chosen pattern clip unique when cloning its source collides', () => {
  const { project, pattern } = fixture();
  collide();
  const result = makeUnique(project, 'b');
  verify(result.project, project, result.id);
  expect(result.project.clips.map((c) => c.ref)).toEqual([pattern.id, result.id]);
  const changed = E.setNotes(result.project, result.id, project.channels[0].id, []);
  expect(changed.patterns[0].notes).toBe(pattern.notes);
  expect(E.removePattern(changed, result.id).clips).toEqual([project.clips[0]]);
});

it('reserves successive pattern additions against earlier additions', () => {
  const { project } = fixture();
  collidePatterns();
  const first = E.addPattern(project, { name: 'First' });
  const second = E.addPattern(first.project, { name: 'Second' });
  verify(second.project, project, first.id);
  verify(second.project, project, second.id);
  expect(second.project.patterns.map((p) => p.name)).toEqual(['Pattern 1', 'First', 'Second']);
});

it.each([false, true])('links MIDI clips to their newly imported patterns (percussion %s)', (percussion) => {
  const { project } = fixture();
  const tracks = percussion ? [{ channel: 9, notes: [{ key: 36, tick: 0, len: 24, vel: 100 }] }] : [60, 64].map((key, channel) => ({ channel, notes: [{ key, tick: 0, len: 48, vel: 100 }] }));
  const midi = readMidi(writeMidi({ ppq: 96, tracks }));
  collidePatterns();
  const result = importMidi(project, midi);
  for (const id of result.patternIds) verify(result.project, project, id);
  expect(new Set(result.patternIds).size).toBe(tracks.length);
  const imported = { ...result.project, clips: result.project.clips.filter((c) => result.patternIds.includes(c.ref)) };
  const slots = new Map(imported.channels.map((c, i) => [c.id, i]));
  const seq = compileSequence(imported, { mode: 'song', slotOf: (id) => slots.get(id) ?? -1 });
  expect([...seq.notes.key]).toEqual(percussion ? [60] : [60, 64]);
  expect(imported.clips).toHaveLength(tracks.length);
});

it('retains all demo patterns and their intended arrangement after source IDs collide', () => {
  const expected = demoProject();
  const music = (p) => p.patterns.map((pat) => ({ name: pat.name, notes: Object.values(pat.notes).map((list) => list.map(({ id, ...n }) => n)) }));
  const arrangement = (p) => p.clips.map(({ ref, id, ...c }) => ({ ...c, pattern: p.patterns.find((pat) => pat.id === ref)?.name }));
  collidePatterns();
  const result = demoProject();
  expect(new Set(result.patterns.map((p) => p.id)).size).toBe(4);
  expect(music(result)).toEqual(music(expected));
  expect(arrangement(result)).toEqual(arrangement(expected));
});

it('does not reserve pattern IDs against unrelated channel IDs', () => {
  const project = P.createProject({ channels: [{ ...P.createChannel(), id: '00000000' }] });
  collide();
  const result = E.addPattern(project);
  expect(result.id).toBe('00000000');
  expect(result.project.channels).toBe(project.channels);
});
