import { afterEach, expect, it, vi } from 'vitest';
import { Recorder } from '../src/input/recorder.js';
import { createProject, createChannel } from '../src/model/project.js';
import { Store } from '../src/model/store.js';
import * as E from '../src/model/edits.js';
import { Emitter } from '../src/lib/emitter.js';
import { shared } from '../src/pianoroll/state.js';

afterEach(() => { vi.restoreAllMocks(); shared.cursor.tick = 0; });
const originalNote = { id: '000000', key: 60, pos: 0, len: 96, vel: 0.7, pan: 0 };
function setup(existing = []) {
  const project = createProject({ channels: [createChannel(), createChannel()] });
  project.bpm = 120;
  const pid = project.patterns[0].id;
  const cid = project.channels[0].id;
  project.patterns[0].notes[cid] = existing;
  const store = new Store(project);
  const engine = Object.assign(new Emitter(), { playing: true, recording: true, mode: 'pattern', position: 0 });
  const prefs = { get: () => false };
  const app = Object.assign(new Emitter(), { store, engine, prefs, notify: vi.fn() });
  const rec = new Recorder(app, null);
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  let i = 0;
  const random = crypto.getRandomValues.bind(crypto);
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => bytes.length === 6 ? bytes.fill(Math.max(0, i++ - 1)) : random(bytes));
  const notes = (channel = cid) => E.getNotes(store.project, pid, channel);
  const stop = () => { engine.playing = false; engine.emit('state'); };
  return { app, rec, store, engine, now, notes, stop, pid, cid, project };
}

it('records alongside an existing note with the same candidate ID', () => {
  const { rec, now, notes, stop, cid, store, project } = setup([originalNote]);
  rec.noteOn(67, 0.9, cid);
  now.mockReturnValue(250);
  rec.noteOff(67);
  stop();
  expect(notes()).toHaveLength(2);
  expect(notes()[0]).toBe(originalNote);
  expect(notes()[1]).toMatchObject({ key: 67, len: 48, vel: 0.9 });
  expect(notes()[1].id).not.toBe(originalNote.id);
  store.undo();
  expect(store.project).toBe(project);
});

it.each([false, true])('keeps held notes and releases separate across channels=%s', (separateChannels) => {
  const { rec, now, notes, stop, cid, project } = setup();
  const other = separateChannels ? project.channels[1].id : cid;
  rec.noteOn(67, 0.9, cid);
  rec.noteOn(69, 0.8, other);
  expect(rec.take.size).toBe(2);
  now.mockReturnValue(250);
  rec.noteOff(67);
  now.mockReturnValue(500);
  rec.noteOff(69);
  stop();
  const all = separateChannels ? [...notes(), ...notes(other)] : notes();
  expect(all.map((n) => [n.key, n.len])).toEqual([[67, 48], [69, 96]]);
  expect(new Set(all.map((n) => n.id)).size).toBe(2);
});

it.each(['stop', 'loop'])('preserves distinct deferred %s passes while another gesture blocks writes', (finish) => {
  const { rec, now, notes, stop, cid, store, engine, app, project } = setup();
  store.begin('Drag');
  rec.noteOn(67, 0.9, cid);
  now.mockReturnValue(250);
  rec.noteOff(67);
  if (finish === 'stop') stop(); else engine.emit('loop');
  expect(rec.finished).toHaveLength(1);
  engine.playing = true;
  rec.noteOn(69, 0.8, cid);
  now.mockReturnValue(500);
  rec.noteOff(69);
  stop();
  expect(rec.finished).toHaveLength(2);
  store.commit();
  app.emit('frame');
  expect(notes().map((n) => [n.key, n.len])).toEqual([[67, 48], [69, 48]]);
  expect(new Set(notes().map((n) => n.id)).size).toBe(2);
  expect(rec.finished).toHaveLength(0);
  store.undo();
  expect(notes().map((n) => n.key)).toEqual([67]);
  store.undo();
  expect(store.project).toBe(project);
});

it('reserves notes hidden by another gesture that can later be canceled', () => {
  const { rec, now, notes, stop, cid, store, pid, app } = setup([originalNote]);
  store.begin('Delete note');
  store.preview((p) => E.removeNotes(p, pid, cid, [originalNote.id]));
  expect(notes()).toHaveLength(0);
  rec.noteOn(67, 0.9, cid);
  now.mockReturnValue(250);
  stop();
  store.cancel();
  app.emit('frame');
  expect(notes()).toHaveLength(2);
  expect(notes()[0]).toBe(originalNote);
  expect(notes()[1]).toMatchObject({ key: 67, len: 48 });
});

it('keeps step-edited notes independent from existing notes', () => {
  const { rec, notes, cid, engine, app, store, project } = setup([originalNote]);
  engine.playing = false;
  app.prefs.get = (key) => key === 'stepEditing';
  shared.cursor.tick = 96;
  rec.noteOn(67, 0.9, cid);
  rec.noteOff(67);
  expect(notes()).toHaveLength(2);
  expect(notes()[1].id).not.toBe(originalNote.id);
  const remaining = E.removeNotes(store.project, store.pattern.id, cid, [notes()[1].id]);
  expect(E.getNotes(remaining, store.pattern.id, cid)).toEqual([originalNote]);
  store.undo();
  expect(store.project).toBe(project);
});
