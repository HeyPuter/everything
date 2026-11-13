import { afterEach, expect, it, vi } from 'vitest';
import { PianoRollEditor } from '../src/pianoroll/editor.js';
import { Store } from '../src/model/store.js';
import { createProject, createChannel, createPattern, createNote } from '../src/model/project.js';
import { Emitter } from '../src/lib/emitter.js';
import * as E from '../src/model/edits.js';
import { openNoteProps, closeNoteProps } from '../src/pianoroll/dialogs.js';
import { computeLayout, rowY, centerScrollY } from '../src/pianoroll/geometry.js';

vi.mock('../src/render/gfx.js', () => ({ createGfx: () => ({ destroy: vi.fn() }) }));

afterEach(() => { closeNoteProps(); vi.useRealTimers(); });

function setup() {
  vi.useFakeTimers();
  const project = createProject();
  project.channels = [createChannel(), createChannel()];
  project.patterns.push(createPattern(1));
  const store = new Store(project);
  let start;
  const ready = new Promise((resolve) => { start = resolve; });
  const engine = Object.assign(new Emitter(), { start: vi.fn(() => ready), noteOn: vi.fn(), noteOff: vi.fn() });
  const prefs = Object.assign(new Emitter(), { get: () => null });
  const app = Object.assign(new Emitter(), { store, engine, prefs, tools: { pianoRoll: 'draw' }, hint: vi.fn() });
  const editor = new PianoRollEditor(app, { body: document.createElement('div') });
  editor.onViewChange();
  return { editor, store, engine, start };
}

it.each(['replacement', 'channel', 'pattern'])('cancels a pending keyboard preview on %s change', async (change) => {
  const { editor, store, engine, start } = setup();
  const pending = editor.audition(60, 0.8, { hold: false });
  if (change === 'replacement') store.load(structuredClone(store.project));
  else if (change === 'channel') store.setChannel(store.project.channels[1].id);
  else store.setPattern(store.project.patterns[1].id);
  start();
  await pending;
  expect(engine.noteOn).not.toHaveBeenCalled();
  expect(editor.auditioning).toEqual([]);
  expect(editor.pressed.size).toBe(0);
  editor.destroy();
});

it('keeps a pending preview across unrelated project edits', async () => {
  const { editor, store, engine, start } = setup();
  const cid = store.channel.id;
  const pending = editor.audition(60, 0.8, { hold: false });
  store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 150 }));
  start();
  await pending;
  expect(engine.noteOn).toHaveBeenCalledExactlyOnceWith(cid, 60, 0.8);
  vi.advanceTimersByTime(220);
  expect(engine.noteOff).toHaveBeenLastCalledWith(cid, 60);
  expect(editor.pressed.size).toBe(0);
  editor.destroy();
});

function beginNoteDrag(editor, store) {
  const note = createNote({ key: 60, pos: 96, len: 96 });
  store.apply('Add note', (p) => E.setNotes(p, store.pattern.id, store.channel.id, [note]));
  editor.L = computeLayout({ w: 800, h: 500, lane: false });
  editor.scrollY = centerScrollY(editor.L, note.key, editor.keyH);
  const x = editor.L.gridX + editor.vp.x(note.pos + note.len / 2);
  const y = rowY(editor.L, note.key, editor.keyH, editor.scrollY) + editor.keyH / 2;
  const pointer = (type, dx = 0) => editor.surface.dispatchEvent(new MouseEvent(type, { clientX: x + dx, clientY: y, button: 0, altKey: true, bubbles: true }));
  pointer('pointerdown');
  expect(editor.gesture?.type).toBe('move');
  return pointer;
}

it('does not let a note drag modify a reopened project with the same IDs', () => {
  const { editor, store } = setup();
  const pointer = beginNoteDrag(editor, store);
  const replacement = structuredClone(store.project);
  replacement.name = 'Reopened';
  store.load(replacement);
  pointer('pointermove', 24);
  pointer('pointerup', 24);
  expect(store.project).toBe(replacement);
  expect(store.canUndo).toBe(false);
  expect(store.dirty).toBe(false);
  expect(editor.gesture).toBeNull();
  editor.destroy();
});

it('still commits an ordinary note drag as one undo step', () => {
  const { editor, store } = setup();
  const pointer = beginNoteDrag(editor, store);
  const original = store.project;
  pointer('pointermove', 24);
  pointer('pointerup', 24);
  expect(editor.notes[0].pos).toBe(144);
  expect(editor.gesture).toBeNull();
  store.undo();
  expect(store.project).toBe(original);
  editor.destroy();
});

function noteProperties(editor, store) {
  const note = createNote({ key: 60, pos: 96, len: 96 });
  store.apply('Add note', (p) => E.setNotes(p, store.pattern.id, store.channel.id, [note]));
  store.apply('Velocity', (p) => E.setNotes(p, store.pattern.id, store.channel.id, [{ ...note, vel: 0.5 }]));
  openNoteProps(editor, editor.notes[0]);
  return editor.root.querySelector('.pr-popover');
}

it.each(['replacement', 'undo', 'deletion', 'channel', 'pattern'])('closes stale note properties after %s', (change) => {
  const { editor, store } = setup();
  const popup = noteProperties(editor, store);
  const pitch = popup.querySelector('[aria-label="Pitch"]');
  if (change === 'replacement') store.load(structuredClone(store.project));
  else if (change === 'undo') store.undo();
  else if (change === 'deletion') store.apply('Delete', (p) => E.setNotes(p, store.pattern.id, store.channel.id, []));
  else if (change === 'channel') store.setChannel(store.project.channels[1].id);
  else store.setPattern(store.project.patterns[1].id);
  const current = store.project;
  expect(editor.root.querySelector('.pr-popover')).toBeNull();
  pitch.value = 'D5';
  pitch.dispatchEvent(new Event('change', { bubbles: true }));
  expect(store.project).toBe(current);
  expect(editor.root.querySelector('.pr-popover')).toBeNull();
  editor.destroy();
});

it('keeps note properties usable for successive edits and unrelated tempo changes', () => {
  const { editor, store } = setup();
  const popup = noteProperties(editor, store);
  const pitch = popup.querySelector('[aria-label="Pitch"]');
  pitch.value = 'D5';
  pitch.dispatchEvent(new Event('change', { bubbles: true }));
  expect(editor.notes[0].key).toBe(62);
  store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 150 }));
  expect(editor.root.querySelector('.pr-popover')).toBe(popup);
  const pan = popup.querySelector('[aria-label="Pan in percent, negative is left"]');
  pan.value = '50';
  pan.dispatchEvent(new Event('change', { bubbles: true }));
  expect(editor.notes[0]).toMatchObject({ key: 62, vel: 0.5, pan: 0.5 });
  expect(editor.root.querySelector('.pr-popover')).toBe(popup);
  editor.destroy();
});

it.each(['undo', 'redo'])('ends a note drag when %s changes history', (action) => {
  const { editor, store } = setup();
  const pointer = beginNoteDrag(editor, store);
  if (action === 'undo') {
    pointer('pointermove', 24);
  } else {
    pointer('pointerup');
    store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 150 }));
    store.undo();
    pointer('pointerdown');
    expect(editor.gesture?.type).toBe('move');
  }
  store[action]();
  const restored = store.project;
  const history = store.undoStack.length;
  pointer('pointermove', 48);
  pointer('pointerup', 48);
  expect(store.project).toBe(restored);
  expect(store.undoStack.length).toBe(history);
  expect(editor.gesture).toBeNull();
  if (action === 'undo') {
    expect(store.canRedo).toBe(true);
    store.redo();
    expect(editor.notes[0].pos).toBe(144);
  } else expect(store.project.bpm).toBe(150);
  editor.destroy();
});
