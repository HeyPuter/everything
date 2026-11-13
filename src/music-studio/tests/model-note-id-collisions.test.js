import { afterEach, expect, it, vi } from 'vitest';
import { createProject, createChannel } from '../src/model/project.js';
import { demoProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import * as S from '../src/rack/steps.js';
import { readMidi, writeMidi } from '../src/io/midi.js';
import { importMidi } from '../src/io/midi-project.js';

afterEach(() => vi.restoreAllMocks());
const note = (id, key = 60, pos = 0) => ({ id, key, pos, len: 24, vel: 0.8, pan: 0 });
function setup() {
  const project = createProject({ channels: [createChannel()] });
  const pid = project.patterns[0].id, cid = project.channels[0].id;
  project.patterns[0].notes[cid] = [note('000000'), note('111111', 64)];
  return { project, pid, cid };
}
function collide() {
  let i = 0;
  const random = crypto.getRandomValues.bind(crypto);
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => bytes.length === 6 ? bytes.fill(Math.max(0, i++ - 1)) : random(bytes));
}
function verify(project, pid, cid, count) {
  const notes = E.getNotes(project, pid, cid);
  expect(notes).toHaveLength(count);
  expect(new Set(notes.map((n) => n.id)).size).toBe(count);
  const remaining = E.removeNotes(project, pid, cid, [notes.at(-1).id]);
  expect(E.getNotes(remaining, pid, cid)).toHaveLength(count - 1);
}

it.each([false, true])('adds independently editable notes with supplied IDs=%s', (supplied) => {
  const { project, pid, cid } = setup();
  const added = [note(supplied ? '000000' : undefined, 67, 48), note(supplied ? '000000' : undefined, 69, 72)];
  collide();
  const result = E.addNotes(project, pid, cid, added);
  verify(result, pid, cid, 4);
  expect(E.getNotes(result, pid, cid).slice(0, 2)).toEqual(E.getNotes(project, pid, cid));
  expect(added.map((n) => n.id)).toEqual(supplied ? ['000000', '000000'] : [undefined, undefined]);
});
it('keeps rack step notes distinct from earlier notes', () => {
  const { project, pid, cid } = setup();
  collide();
  const result = E.toggleStep(project, pid, cid, 2, true);
  verify(result, pid, cid, 3);
  expect(E.getNotes(result, pid, cid).at(-1)).toMatchObject({ pos: 48, len: 24, key: 60 });
});
it('keeps notes distinct when cloning a pattern', () => {
  const { project, pid, cid } = setup();
  collide();
  const result = E.clonePattern(project, pid);
  verify(result.project, result.id, cid, 2);
  expect(E.getNotes(result.project, pid, cid)).toBe(E.getNotes(project, pid, cid));
});
it('keeps notes distinct when cloning a channel', () => {
  const { project, pid, cid } = setup();
  collide();
  const result = E.cloneChannel(project, cid, { withNotes: true });
  verify(result.project, pid, result.id, 2);
  expect(E.getNotes(result.project, pid, cid)).toBe(E.getNotes(project, pid, cid));
});
it.each([0, 9])('imports independently editable MIDI notes on channel %i', (channel) => {
  const project = createProject();
  const key = channel === 9 ? 36 : 60;
  const source = readMidi(writeMidi({ ppq: 96, tracks: [{ channel, notes: [{ key, tick: 0, len: 48, vel: 100 }, { key, tick: 96, len: 24, vel: 80 }] }] }));
  collide();
  const result = importMidi(project, source);
  const cid = result.channelIds[0], pid = result.patternIds[0];
  verify(result.project, pid, cid, 2);
  expect(E.getNotes(result.project, pid, cid).map((n) => [n.pos, n.len, n.vel])).toEqual([[0, 48, 100 / 127], [96, 24, 80 / 127]]);
  expect(project.clips).toHaveLength(0);
});
it('makes every demo note independently editable while preserving the music', () => {
  const original = demoProject();
  const music = (p) => p.patterns.flatMap((pat) => Object.values(pat.notes).map((list) => list.map(({ id, ...n }) => n)));
  collide();
  const project = demoProject();
  for (const pat of project.patterns) for (const [cid, list] of Object.entries(pat.notes)) verify(project, pat.id, cid, list.length);
  expect(music(project)).toEqual(music(original));
});
it('preserves unique supplied IDs and object sharing during ordinary insertion', () => {
  const { project, pid, cid } = setup();
  const added = note('fresh-id', 67, 48);
  const result = E.addNotes(project, pid, cid, [added]);
  expect(E.getNotes(result, pid, cid).at(-1)).toBe(added);
  expect(E.getNotes(result, pid, cid).slice(0, 2)).toEqual(E.getNotes(project, pid, cid));
});

it.each(['paint', 'fill', 'randomize', 'paste'])('keeps rack %s results independently editable', (action) => {
  const { project, pid, cid } = setup();
  project.patterns[0].notes[cid] = [note('000000'), note('111111', 60, 24)];
  const edits = {
    paint: (notes) => S.paintSteps(notes, [2, 3], true),
    fill: () => S.fillSteps(4, 1),
    randomize: () => S.randomSteps(4, { rng: () => 0 }),
    paste: (notes) => S.copyNotes(notes),
  };
  collide();
  const result = S.editChannelNotes(project, pid, cid, edits[action]);
  verify(result, pid, cid, action === 'paste' ? 2 : 4);
  expect(E.getNotes(result, pid, cid).map((n) => n.pos)).toEqual(action === 'paste' ? [0, 24] : [0, 24, 48, 72]);
  expect(project.patterns[0].notes[cid].map((n) => n.id)).toEqual(['000000', '111111']);
});
