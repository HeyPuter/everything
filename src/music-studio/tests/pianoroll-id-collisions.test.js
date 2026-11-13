import { afterEach, expect, it, vi } from 'vitest';
import * as N from '../src/pianoroll/notes.js';
import { generateRiff } from '../src/pianoroll/riff.js';
import { PianoRollEditor } from '../src/pianoroll/editor.js';
import { riffDialog } from '../src/pianoroll/dialogs.js';
import { shared } from '../src/pianoroll/state.js';
import { computeLayout, centerScrollY, rowY } from '../src/pianoroll/geometry.js';
import { Store } from '../src/model/store.js';
import { createProject, createChannel } from '../src/model/project.js';
import { Emitter } from '../src/lib/emitter.js';

vi.mock('../src/render/gfx.js', () => ({ createGfx: () => ({ destroy: vi.fn() }) }));
const editors = [];
afterEach(() => {
  for (const ed of editors.splice(0)) ed.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
  shared.clipboard = null;
  shared.stamp = null;
  shared.last = null;
  shared.cursor.tick = 0;
  shared.cursor.key = 60;
  document.body.replaceChildren();
});
const fixture = () => [
  { id: '000000', key: 60, pos: 0, len: 96, vel: 0.8, pan: 0 },
  { id: '111111', key: 64, pos: 0, len: 96, vel: 0.6, pan: 0.1 },
];
function collide(first = 0) {
  let i = 0;
  const original = crypto.getRandomValues.bind(crypto);
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => bytes.length === 6 ? bytes.fill(first + Math.max(0, i++ - 1)) : original(bytes));
}
function verify(notes, ids, count) {
  expect(notes).toHaveLength(count);
  expect(new Set(notes.map((n) => n.id)).size).toBe(count);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every((id) => notes.filter((n) => n.id === id).length === 1)).toBe(true);
  const changed = N.patchNotes(notes, { [ids[0]]: { vel: 0.2 } });
  expect(changed.filter((n) => n.vel === 0.2)).toHaveLength(1);
}

it.each([0, 2])('duplicates notes independently when random IDs collide from %i', (first) => {
  const notes = fixture();
  collide(first);
  const r = N.duplicateNotes(notes, null, 96);
  verify(r.notes, r.ids, 4);
  expect(r.ids.some((id) => notes.some((n) => n.id === id))).toBe(false);
  expect(notes.map((n) => n.vel)).toEqual([0.8, 0.6]);
});
it('keeps sliced halves distinct from all originals and earlier halves', () => {
  const notes = fixture();
  collide();
  const r = N.sliceNotes(notes, 48);
  verify(r.notes, r.ids, 4);
  expect(r.notes.map((n) => n.len)).toEqual([48, 48, 48, 48]);
});
it('keeps chord tones independently editable and retains original roots', () => {
  const notes = fixture();
  collide();
  const r = N.chordize(notes, [notes[0].id], 'major');
  verify(r.notes, r.ids, 3);
  expect(r.notes.map((n) => n.key)).toEqual([60, 64, 67]);
  expect(r.notes[0]).toBe(notes[0]);
  expect(r.notes[1]).toBe(notes[1]);
});
it('gives clipboard notes distinct IDs within a pasted batch', () => {
  collide();
  const made = N.pasteNotes(N.copyNotes(fixture()), 192);
  verify(made, made.map((n) => n.id), 2);
});
it('generates independently editable riff notes under random ID collisions', () => {
  collide();
  const notes = generateRiff({ style: 'chords', bars: 1, density: 0.2, seed: 2 });
  verify(notes, notes.map((n) => n.id), 3);
});

function setup(tool = 'draw') {
  vi.useFakeTimers();
  const project = createProject({ channels: [createChannel()] });
  project.patterns[0].notes[project.channels[0].id] = fixture();
  const store = new Store(project);
  const engine = Object.assign(new Emitter(), { start: vi.fn(async () => {}), noteOn: vi.fn(), noteOff: vi.fn(), position: 0, mode: 'pattern', playing: false });
  const prefs = Object.assign(new Emitter(), { get: () => null, merge: vi.fn() });
  const app = Object.assign(new Emitter(), { store, engine, prefs, tools: { pianoRoll: tool }, hint: vi.fn(), notify: vi.fn() });
  const body = document.createElement('div');
  document.body.append(body);
  const ed = new PianoRollEditor(app, { body });
  editors.push(ed);
  ed.onViewChange();
  ed.L = computeLayout({ w: 800, h: 500, lane: false });
  ed.scrollY = centerScrollY(ed.L, 60, ed.keyH);
  ed.vp.width = ed.L.gridW;
  return { ed, store, original: store.project };
}

it('keeps keyboard chord IDs distinct and undoable', () => {
  const { ed, store, original } = setup();
  ed.cursor.tick = 192;
  vi.spyOn(ed, 'stampKeys').mockReturnValue([60, 64]);
  collide();
  const r = ed.addAtCursor();
  verify(ed.notes, r.ids, 4);
  store.undo();
  expect(store.project).toBe(original);
});
it('selects only pasted notes when a generated ID matches an existing note', () => {
  const { ed, store, original } = setup();
  shared.clipboard = N.copyNotes(ed.notes);
  collide();
  ed.paste();
  verify(ed.notes, [...ed.selected], 4);
  expect([...ed.selected].some((id) => fixture().some((n) => n.id === id))).toBe(false);
  ed.deleteSelection();
  expect(ed.notes).toEqual(fixture());
  store.undo();
  expect(ed.notes).toHaveLength(4);
  store.undo();
  expect(store.project).toBe(original);
});

function pointer(ed, type, tick) {
  const x = ed.L.gridX + ed.vp.x(tick);
  const y = rowY(ed.L, 60, ed.keyH, ed.scrollY) + ed.keyH / 2;
  ed.surface.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
}
it.each(['draw', 'paint'])('keeps IDs stable and unique across %s gesture previews', (tool) => {
  const { ed, store, original } = setup(tool);
  shared.last = { len: 24, vel: 0.7 };
  collide();
  pointer(ed, 'pointerdown', 192);
  expect(ed.gesture?.type).toBe(tool === 'draw' ? 'add' : 'paint');
  const firstId = ed.notes.find((n) => n.pos === 192).id;
  pointer(ed, 'pointermove', 240);
  pointer(ed, 'pointermove', 264);
  pointer(ed, 'pointerup', 264);
  const made = ed.notes.filter((n) => n.pos >= 192);
  expect(made[0].id).toBe(firstId);
  verify(ed.notes, made.map((n) => n.id), tool === 'draw' ? 3 : 6);
  store.undo();
  expect(store.project).toBe(original);
});
it('keeps generated riff selection separate from retained notes', async () => {
  const { ed, store, original } = setup();
  const pending = riffDialog(ed);
  document.querySelector('#pr-r-style').value = 'chords';
  document.querySelector('#pr-r-bars').value = '1';
  document.querySelector('#pr-r-density').value = '20';
  document.querySelector('#pr-r-seed').value = '2';
  document.querySelector('input[type=checkbox]').checked = false;
  collide();
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Generate').click();
  await pending;
  verify(ed.notes, [...ed.selected], 5);
  ed.deleteSelection();
  expect(ed.notes).toEqual(fixture());
  store.undo();
  store.undo();
  expect(store.project).toBe(original);
});
