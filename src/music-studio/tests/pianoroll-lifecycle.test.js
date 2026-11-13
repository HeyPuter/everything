import { afterEach, expect, it, vi } from 'vitest';
import { PianoRollEditor } from '../src/pianoroll/editor.js';
import { Store } from '../src/model/store.js';
import { createProject, createChannel, createPattern } from '../src/model/project.js';
import { Emitter } from '../src/lib/emitter.js';
import * as E from '../src/model/edits.js';

vi.mock('../src/render/gfx.js', () => ({ createGfx: () => ({ destroy: vi.fn() }) }));

afterEach(() => vi.useRealTimers());

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
  const app = Object.assign(new Emitter(), { store, engine, prefs });
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
