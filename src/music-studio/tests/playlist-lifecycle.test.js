import { afterEach, expect, it, vi } from 'vitest';
import { createPlaylistView } from '../src/playlist/view.js';
import { Store } from '../src/model/store.js';
import { createProject, createClip } from '../src/model/project.js';
import { Emitter } from '../src/lib/emitter.js';
import * as E from '../src/model/edits.js';
import { App } from '../src/app.js';
import { Commands } from '../src/commands/registry.js';
import { registerCoreCommands } from '../src/commands/core.js';

vi.mock('../src/render/gfx.js', () => ({ createGfx: () => ({ canvas: document.createElement('canvas'), overlay: document.createElement('canvas'), frame: vi.fn(), resize: vi.fn() }) }));
const keyboardListeners = [];
afterEach(() => {
  for (const [type, listener, options] of keyboardListeners.splice(0)) document.removeEventListener(type, listener, options);
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(kind = 'pattern') {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const project = createProject();
  project.markers = [{ id: 'marker', name: 'Start', pos: 96 }];
  project.automation.volume = { id: 'volume', name: 'Tempo', target: { kind: 'tempo' }, points: [{ t: 96, v: 0.5 }] };
  project.clips = [createClip({ kind, ref: kind === 'auto' ? 'volume' : project.patterns[0].id, start: 96, len: 192 })];
  const store = new Store(project);
  const engine = Object.assign(new Emitter(), { mode: 'song', position: 0, seek: vi.fn() });
  const prefs = Object.assign(new Emitter(), { get: (key) => key === 'snap' ? {} : null });
  const app = Object.assign(new Emitter(), { store, engine, prefs, samples: new Emitter(), commands: { has: () => false }, tools: { playlist: 'draw' }, hint: vi.fn() });
  const body = document.createElement('div');
  const panel = createPlaylistView(app, { body });
  const view = panel.view;
  const surface = body.querySelector('.pl-scroller');
  Object.defineProperties(surface, { clientWidth: { value: 800 }, clientHeight: { value: 400 } });
  view.vp.pxPerTick = 0.5;
  view.vp.width = 800;
  const x = view.vp.x(project.clips[0].start + project.clips[0].len / 2);
  const hit = view.hit(view.pointAt(x, 28));
  const y = kind === 'auto' ? hit.auto.bottom - hit.auto.ch * 0.5 : 28;
  const pointer = (type, dx = 0, touchId) => {
    const event = new MouseEvent(type, { clientX: x + dx, clientY: y, button: 0, altKey: true, bubbles: true });
    if (touchId !== undefined) Object.defineProperties(event, { pointerId: { value: touchId }, pointerType: { value: 'touch' } });
    return surface.dispatchEvent(event);
  };
  pointer('pointerdown');
  expect(view.hasGesture()).toBe(true);
  return { store, view, pointer, panel, body, engine, app };
}

function installKeyboard(app, panel, body) {
  app.commands = new Commands(app);
  app.activePanel = 'playlist';
  app.shell = { panels: new Map([['playlist', { impl: panel }]]) };
  registerCoreCommands(app);
  const add = document.addEventListener.bind(document);
  const spy = vi.spyOn(document, 'addEventListener').mockImplementation((...args) => {
    keyboardListeners.push(args);
    add(...args);
  });
  App.prototype.installKeyboard.call(app);
  spy.mockRestore();
  document.body.append(body);
  panel.focus();
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

function resizePointer(body) {
  const grip = body.querySelector('.pl-track-resize');
  const send = (type, dy = 0, altKey = false) => grip.dispatchEvent(new MouseEvent(type, { clientY: 56 + dy, button: 0, altKey, bubbles: true }));
  return { grip, send };
}

it.each(['replacement', 'undo', 'redo', 'hide'])('ends track resizing after %s', (action) => {
  const { store, pointer, panel, body } = setup();
  pointer('pointerup');
  if (action === 'redo') {
    store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 150 }));
    store.undo();
  }
  const original = store.project;
  const { grip, send } = resizePointer(body);
  send('pointerdown');
  if (action !== 'redo') send('pointermove', 20);
  if (action === 'replacement') store.load(structuredClone(original));
  else if (action === 'hide') panel.onHide();
  else store[action]();
  const restored = store.project;
  const history = store.undoStack.length;
  send('pointermove', 40);
  send('pointerup', 40);
  expect(store.project).toBe(restored);
  expect(store.project.tracks[0].height).toBe(56);
  expect(store.undoStack.length).toBe(history);
  expect(grip.classList.contains('dragging')).toBe(false);
  if (action === 'undo') {
    store.redo();
    expect(store.project.tracks[0].height).toBe(76);
  }
});

it.each([false, true])('keeps track resizing and undo working with Alt=%s', (alt) => {
  const { store, pointer, body } = setup();
  pointer('pointerup');
  const original = store.project;
  const { send } = resizePointer(body);
  send('pointerdown');
  send('pointermove', 20, alt);
  send('pointerup', 20, alt);
  expect(store.project.tracks[0].height).toBe(76);
  expect(store.project.tracks[1].height).toBe(alt ? 76 : 56);
  store.undo();
  expect(store.project).toBe(original);
});

function rulerPointer(body, kind) {
  const ruler = body.querySelector('.pl-ruler');
  return (type, dx = 0) => ruler.dispatchEvent(new MouseEvent(type, { clientX: 48 + dx, clientY: kind === 'loop' ? 4 : 16, button: 0, altKey: true, bubbles: true }));
}

for (const kind of ['loop', 'marker']) {
  it.each(['replacement', 'undo', 'redo', 'hide'])('ends a ' + kind + ' drag after %s', (action) => {
    const { store, pointer, panel, body } = setup();
    pointer('pointerup');
    if (action === 'redo') {
      store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 150 }));
      store.undo();
    }
    const original = store.project;
    const send = rulerPointer(body, kind);
    send('pointerdown');
    if (action !== 'redo') send('pointermove', 24);
    if (action === 'replacement') store.load(structuredClone(original));
    else if (action === 'hide') panel.onHide();
    else store[action]();
    const restored = store.project;
    const history = store.undoStack.length;
    send('pointermove', 48);
    send('pointerup', 48);
    expect(store.project).toBe(restored);
    expect(store.project.loop).toBeNull();
    expect(store.project.markers[0].pos).toBe(96);
    expect(store.undoStack.length).toBe(history);
    expect(body.querySelector('.marker-drag')).toBeNull();
  });

  it('commits an ordinary ' + kind + ' drag and supports undo', () => {
    const { store, pointer, body } = setup();
    pointer('pointerup');
    const original = store.project;
    const send = rulerPointer(body, kind);
    send('pointerdown');
    send('pointermove', 24);
    send('pointerup', 24);
    if (kind === 'loop') expect(store.project.loop).toEqual({ start: 96, end: 144 });
    else expect(store.project.markers[0].pos).toBe(144);
    store.undo();
    expect(store.project).toBe(original);
  });

  it('discards a canceled ' + kind + ' preview', () => {
    const { store, pointer, body } = setup();
    pointer('pointerup');
    const original = store.project;
    const send = rulerPointer(body, kind);
    send('pointerdown');
    send('pointermove', 24);
    send('pointercancel', 24);
    expect(store.project).toBe(original);
    expect(store.canUndo).toBe(false);
  });
}

it('preserves marker-click seeking and ruler scrubbing', () => {
  const { store, pointer, body, engine } = setup();
  pointer('pointerup');
  const original = store.project;
  const marker = rulerPointer(body, 'marker');
  marker('pointerdown');
  marker('pointerup');
  expect(engine.seek).toHaveBeenLastCalledWith(96);
  const ruler = body.querySelector('.pl-ruler');
  for (const [type, x] of [['pointerdown', 250], ['pointermove', 274], ['pointerup', 274]]) {
    ruler.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: 16, button: 0, altKey: true, bubbles: true }));
  }
  expect(engine.seek).toHaveBeenLastCalledWith(548);
  expect(store.project).toBe(original);
  expect(store.canUndo).toBe(false);
});

it.each(['before confirmation', 'just after confirmation'])('does not rename a replacement project marker %s', async (timing) => {
  const { store, pointer, view } = setup();
  pointer('pointerup');
  const pending = view.renameMarker(store.project.markers[0]);
  const dialog = document.querySelector('.dialog');
  dialog.querySelector('input').value = 'Old prompt';
  const submit = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Rename');
  if (timing === 'just after confirmation') submit.click();
  const replacement = structuredClone(store.project);
  store.load(replacement);
  if (timing === 'before confirmation') submit.click();
  await pending;
  expect(store.project).toBe(replacement);
  expect(store.project.markers[0].name).toBe('Start');
  expect(store.canUndo).toBe(false);
  expect(document.querySelector('.dialog')).toBeNull();
});

it('keeps marker rename usable across an unrelated tempo edit', async () => {
  const { store, pointer, view } = setup();
  pointer('pointerup');
  const pending = view.renameMarker(store.project.markers[0]);
  store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 150 }));
  const dialog = document.querySelector('.dialog');
  dialog.querySelector('input').value = 'Verse';
  [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Rename').click();
  await pending;
  expect(store.project.markers[0].name).toBe('Verse');
  expect(store.project.bpm).toBe(150);
  store.undo();
  expect(store.project.markers[0].name).toBe('Start');
  expect(store.project.bpm).toBe(150);
});

it.each(['before confirmation', 'just after confirmation'])('does not add a marker to a replacement project %s', async (timing) => {
  const { store, pointer, view } = setup();
  pointer('pointerup');
  const pending = view.addMarker(192);
  const dialog = document.querySelector('.dialog');
  dialog.querySelector('input').value = 'Verse';
  const submit = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Add');
  if (timing === 'just after confirmation') submit.click();
  const replacement = structuredClone(store.project);
  store.load(replacement);
  if (timing === 'before confirmation') submit.click();
  await pending;
  expect(store.project).toBe(replacement);
  expect(store.canUndo).toBe(false);
  expect(document.querySelector('.dialog')).toBeNull();
});

it('keeps Add Marker usable across a tempo edit', async () => {
  const { store, pointer, view } = setup();
  pointer('pointerup');
  const pending = view.addMarker(192);
  store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 150 }));
  const before = store.project;
  const dialog = document.querySelector('.dialog');
  dialog.querySelector('input').value = 'Verse';
  [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Add').click();
  await pending;
  expect(store.project.markers.at(-1)).toMatchObject({ name: 'Verse', pos: 192 });
  expect(store.project.bpm).toBe(150);
  store.undo();
  expect(store.project).toBe(before);
});

it.each([false, true])('discards a canceled track resize with Alt=%s', (alt) => {
  const { store, pointer, body } = setup();
  pointer('pointerup');
  const original = store.project;
  const { grip, send } = resizePointer(body);
  send('pointerdown');
  send('pointermove', 20, alt);
  expect(store.project.tracks[0].height).toBe(76);
  send('pointercancel', 20, alt);
  expect(store.project).toBe(original);
  expect(store.canUndo).toBe(false);
  expect(store.dirty).toBe(false);
  expect(grip.classList.contains('dragging')).toBe(false);
});

it.each(['loop', 'marker', 'resize from canvas', 'resize from header'])('Escape cancels an active %s without clearing the clip selection', (kind) => {
  const { app, store, view, pointer, panel, body } = setup();
  pointer('pointerup');
  installKeyboard(app, panel, body);
  const original = store.project;
  const selected = [...view.selection];
  const resize = kind.startsWith('resize');
  if (kind === 'resize from header') body.querySelector('.pl-track-name').focus();
  const send = resize ? resizePointer(body).send : rulerPointer(body, kind);
  send('pointerdown');
  send('pointermove', 24);
  expect(store.project).not.toBe(original);
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  send('pointermove', 48);
  send('pointerup', 48);
  expect(store.project).toBe(original);
  expect(store.canUndo).toBe(false);
  expect(store.dirty).toBe(false);
  expect([...view.selection]).toEqual(selected);
  expect(body.querySelector('.dragging, .marker-drag')).toBeNull();
  panel.onHide();
});

it('Escape clears the clip selection when there is no active gesture', () => {
  const { app, view, pointer, panel, body } = setup();
  pointer('pointerup');
  installKeyboard(app, panel, body);
  expect(view.selection.size).toBe(1);
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(view.selection.size).toBe(0);
  panel.onHide();
});

it.each(['loop', 'marker', 'resize'])('discards an unfinished %s drag when pointer capture is lost', (kind) => {
  const { store, pointer, panel, body } = setup();
  pointer('pointerup');
  const original = store.project;
  const send = kind === 'resize' ? resizePointer(body).send : rulerPointer(body, kind);
  send('pointerdown');
  send('pointermove', 24);
  expect(store.project).not.toBe(original);
  send('lostpointercapture', 24);
  send('pointermove', 48);
  send('pointerup', 48);
  expect(store.project).toBe(original);
  expect(store.canUndo).toBe(false);
  expect(store.dirty).toBe(false);
  expect(body.querySelector('.dragging, .marker-drag')).toBeNull();
  panel.onHide();
});

it.each(['loop', 'marker', 'resize'])('preserves a committed %s drag when capture is released after pointerup', (kind) => {
  const { store, pointer, panel, body } = setup();
  pointer('pointerup');
  const original = store.project;
  const send = kind === 'resize' ? resizePointer(body).send : rulerPointer(body, kind);
  send('pointerdown');
  send('pointermove', 24);
  send('pointerup', 24);
  const committed = store.project;
  expect(committed).not.toBe(original);
  send('lostpointercapture', 24);
  expect(store.project).toBe(committed);
  expect(store.canUndo).toBe(true);
  store.undo();
  expect(store.project).toBe(original);
  panel.onHide();
});

it.each(['interrupted', 'released'])('cleans up a %s touch clip drag when capture is lost', (state) => {
  const { store, pointer, view, panel } = setup();
  pointer('pointerup');
  const original = store.project;
  pointer('pointerdown', 0, 1);
  pointer('pointermove', 24, 1);
  if (state === 'released') pointer('pointerup', 24, 1);
  pointer('lostpointercapture', 24, 1);
  expect(view.hasGesture()).toBe(false);
  if (state === 'released') {
    expect(store.project.clips[0].start).toBe(144);
    store.undo();
  }
  expect(store.project).toBe(original);
  expect(store.canUndo).toBe(false);
  pointer('pointerdown', 0, 2);
  pointer('pointermove', 24, 2);
  pointer('pointerup', 24, 2);
  expect(store.project.clips[0].start).toBe(144);
  store.undo();
  expect(store.project).toBe(original);
  panel.onHide();
});

it.each(['replacement', 'hide', 'Escape'])('ends a playlist pinch on %s and accepts the next single touch', (action) => {
  const { store, pointer, view, panel } = setup();
  pointer('pointerup');
  pointer('pointerdown', 0, 1);
  pointer('pointermove', 24, 1);
  pointer('pointerdown', 100, 2);
  expect(store.project.clips[0].start).toBe(96);
  if (action === 'replacement') store.load(structuredClone(store.project));
  else if (action === 'hide') panel.onHide();
  else panel.actions.deselect();
  const zoom = view.vp.pxPerTick;
  const scroll = view.vp.scroll;
  pointer('pointermove', 150, 2);
  expect(view.vp.pxPerTick).toBe(zoom);
  expect(view.vp.scroll).toBe(scroll);
  if (action === 'hide') panel.onShow();
  pointer('pointerdown', 0, 3);
  pointer('pointermove', 150, 2);
  pointer('pointerup', 150, 2);
  expect(store.project.clips[0].start).toBe(96);
  expect(view.hasGesture()).toBe(true);
  pointer('pointermove', 24, 3);
  pointer('pointerup', 24, 3);
  expect(store.project.clips[0].start).toBe(144);
  panel.onHide();
});

it('keeps ordinary two-finger playlist zoom working after canceling the first-finger preview', () => {
  const { store, pointer, view, panel } = setup();
  pointer('pointerup');
  const original = store.project;
  pointer('pointerdown', 0, 1);
  pointer('pointermove', 24, 1);
  pointer('pointerdown', 100, 2);
  const zoom = view.vp.pxPerTick;
  expect(view.hasGesture()).toBe(true);
  pointer('pointermove', 150, 2);
  expect(view.vp.pxPerTick).toBeGreaterThan(zoom);
  expect(store.project).toBe(original);
  expect(store.canUndo).toBe(false);
  pointer('pointerup', 150, 2);
  pointer('pointerup', 24, 1);
  panel.onHide();
});
