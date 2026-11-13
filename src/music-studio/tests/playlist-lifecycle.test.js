import { afterEach, expect, it, vi } from 'vitest';
import { createPlaylistView } from '../src/playlist/view.js';
import { Store } from '../src/model/store.js';
import { createProject, createClip } from '../src/model/project.js';
import { Emitter } from '../src/lib/emitter.js';
import * as E from '../src/model/edits.js';

vi.mock('../src/render/gfx.js', () => ({ createGfx: () => ({ canvas: document.createElement('canvas'), overlay: document.createElement('canvas'), frame: vi.fn(), resize: vi.fn() }) }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function setup(kind = 'pattern') {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const project = createProject();
  project.automation.volume = { id: 'volume', name: 'Tempo', target: { kind: 'tempo' }, points: [{ t: 96, v: 0.5 }] };
  project.clips = [createClip({ kind, ref: kind === 'auto' ? 'volume' : project.patterns[0].id, start: 96, len: 192 })];
  const store = new Store(project);
  const engine = Object.assign(new Emitter(), { mode: 'song', position: 0 });
  const prefs = Object.assign(new Emitter(), { get: (key) => key === 'snap' ? {} : null });
  const app = Object.assign(new Emitter(), { store, engine, prefs, samples: new Emitter(), commands: { has: () => false }, tools: { playlist: 'draw' }, hint: vi.fn() });
  const body = document.createElement('div');
  const panel = createPlaylistView(app, { body });
  const view = panel.view;
  const surface = body.querySelector('.pl-scroller');
  Object.defineProperties(surface, { clientWidth: { value: 800 }, clientHeight: { value: 400 } });
  view.vp.pxPerTick = 0.5;
  const x = view.vp.x(project.clips[0].start + project.clips[0].len / 2);
  const hit = view.hit(view.pointAt(x, 28));
  const y = kind === 'auto' ? hit.auto.bottom - hit.auto.ch * 0.5 : 28;
  const pointer = (type, dx = 0) => surface.dispatchEvent(new MouseEvent(type, { clientX: x + dx, clientY: y, button: 0, altKey: true, bubbles: true }));
  pointer('pointerdown');
  expect(view.hasGesture()).toBe(true);
  return { store, view, pointer, panel };
}

it.each(['replacement', 'undo', 'redo'])('prevents an old clip drag from changing the project after %s', (action) => {
  const { store, view, pointer, panel } = setup();
  if (action === 'replacement') store.load(structuredClone(store.project));
  else if (action === 'undo') {
    pointer('pointermove', 24);
    store.undo();
  } else {
    pointer('pointerup');
    store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 150 }));
    store.undo();
    pointer('pointerdown');
    store.redo();
  }
  const restored = store.project;
  const history = store.undoStack.length;
  pointer('pointermove', 48);
  pointer('pointerup', 48);
  expect(store.project).toBe(restored);
  expect(store.undoStack.length).toBe(history);
  expect(view.hasGesture()).toBe(false);
  if (action === 'undo') {
    expect(store.canRedo).toBe(true);
    store.redo();
    expect(store.project.clips[0].start).toBe(144);
  }
  panel.onHide();
});

it('keeps ordinary clip dragging and undo working', () => {
  const { store, view, pointer, panel } = setup();
  const original = store.project;
  pointer('pointermove', 24);
  pointer('pointerup', 24);
  expect(store.project.clips[0].start).toBe(144);
  expect(view.hasGesture()).toBe(false);
  store.undo();
  expect(store.project).toBe(original);
  panel.onHide();
});

it('still cancels a clip preview without committing history', () => {
  const { store, view, pointer, panel } = setup();
  const original = store.project;
  pointer('pointermove', 24);
  expect(store.project.clips[0].start).toBe(144);
  pointer('pointercancel');
  expect(store.project).toBe(original);
  expect(store.canUndo).toBe(false);
  expect(view.hasGesture()).toBe(false);
  panel.onHide();
});

it.each(['commit', 'undo'])('preserves automation point dragging with %s', (action) => {
  const { store, view, pointer, panel } = setup('auto');
  const original = store.project;
  pointer('pointermove', 24);
  expect(store.project.automation.volume.points[0].t).toBe(144);
  if (action === 'commit') {
    pointer('pointerup', 24);
    store.undo();
  } else {
    store.undo();
    pointer('pointermove', 48);
    pointer('pointerup', 48);
  }
  expect(store.project).toBe(original);
  expect(view.hasGesture()).toBe(false);
  store.redo();
  expect(store.project.automation.volume.points[0].t).toBe(144);
  panel.onHide();
});
