import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import * as E from '../src/model/edits.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup() {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML = '<div id="app"></div>';
  const app = new App(document.getElementById('app'), { storage: { getItem: () => null, setItem() {} } }).start([]);
  const tempo = document.querySelector('.tempo');
  tempo.setPointerCapture = vi.fn();
  const pointer = (type, y = 300, id = 1) => {
    const e = new MouseEvent(type, { bubbles: true, clientY: y, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: id });
    tempo.dispatchEvent(e);
  };
  return { app, store: app.store, tempo, pointer };
}

it.each(['replacement', 'undo', 'redo', 'lostpointercapture', 'pointercancel', 'blur'])('ends the old tempo drag on %s', (action) => {
  const { store, tempo, pointer } = setup();
  if (action === 'redo') {
    store.apply('Earlier tempo', (p) => E.setProjectProps(p, { bpm: 99 }));
    store.undo();
  }
  pointer('pointerdown');
  if (action !== 'redo') pointer('pointermove', 298);
  if (action === 'replacement') store.load({ ...structuredClone(store.project), bpm: 99 });
  else if (action === 'undo' || action === 'redo') store[action]();
  else if (action === 'blur') tempo.blur();
  else pointer(action, 298);
  const restored = store.project;
  const history = store.undoStack.length;
  expect(Boolean(store.gesture)).toBe(false);
  pointer('pointermove', 280);
  pointer('pointerup', 280);
  expect(store.project.bpm).toBe(restored.bpm);
  expect(store.project).toBe(restored);
  expect(store.undoStack).toHaveLength(history);
  pointer('pointerdown');
  pointer('pointermove', 298);
  pointer('pointerup', 298);
  expect(store.project.bpm).toBe(restored.bpm + 1);
  store.undo();
  expect(store.project).toBe(restored);
});

it('commits an ordinary tempo drag once and preserves undo after capture release', () => {
  const { store, pointer } = setup();
  const original = store.project;
  pointer('pointerdown');
  pointer('pointermove', 296);
  pointer('pointerup', 296);
  pointer('lostpointercapture', 296);
  expect(store.project.bpm).toBe(original.bpm + 2);
  expect(store.undoStack).toHaveLength(1);
  store.undo();
  expect(store.project).toBe(original);
});

it('keeps the initiating pointer in control of tempo', () => {
  const { store, pointer } = setup();
  pointer('pointerdown');
  pointer('pointermove', 298);
  const value = store.project.bpm;
  pointer('pointerdown', 350, 2);
  pointer('pointermove', 300, 2);
  pointer('pointerup', 300, 2);
  expect(store.project.bpm).toBe(value);
  expect(Boolean(store.gesture)).toBe(true);
  pointer('pointermove', 296);
  pointer('pointerup', 296);
  expect(store.project.bpm).toBe(value + 1);
  expect(store.undoStack).toHaveLength(1);
});

it('does not overwrite or finish another edit that supersedes a tempo drag', () => {
  const { store, pointer } = setup();
  pointer('pointerdown');
  pointer('pointermove', 298);
  store.begin('Mute track');
  store.preview((p) => E.updateTrack(p, 0, { mute: true }));
  const gesture = store.gesture;
  const preview = store.project;
  pointer('pointermove', 280);
  pointer('pointerup', 280);
  expect(store.project.bpm).toBe(preview.bpm);
  expect(store.project).toBe(preview);
  expect(store.gesture === gesture).toBe(true);
  store.cancel();
});

function typeTempo(tempo, value = '147,5') {
  tempo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const input = tempo.querySelector('input');
  expect(input).not.toBeNull();
  input.value = value;
  return input;
}

it.each(['replacement', 'undo', 'redo'])('discards a typed tempo after %s', (action) => {
  const { store, tempo } = setup();
  if (action !== 'replacement') store.apply('Earlier tempo', (p) => E.setProjectProps(p, { bpm: 99 }));
  if (action === 'redo') store.undo();
  const input = typeTempo(tempo);
  if (action === 'replacement') store.load({ ...structuredClone(store.project), bpm: 99 });
  else store[action]();
  const restored = store.project;
  const history = store.undoStack.length;
  const stayedOpen = input.isConnected;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(store.project.bpm).toBe(restored.bpm);
  expect(store.project).toBe(restored);
  expect(store.undoStack).toHaveLength(history);
  expect(stayedOpen).toBe(false);
  expect(tempo.getAttribute('aria-valuenow')).toBe(String(restored.bpm));
});

it.each(['Enter', 'Escape', 'blur'])('preserves ordinary typed tempo with %s across an unrelated edit', (action) => {
  const { store, tempo } = setup();
  const input = typeTempo(tempo);
  store.apply('Mute track', (p) => E.updateTrack(p, 0, { mute: true }));
  const before = store.project;
  expect(input.isConnected).toBe(true);
  if (action === 'blur') input.blur();
  else input.dispatchEvent(new KeyboardEvent('keydown', { key: action, bubbles: true }));
  expect(input.isConnected).toBe(false);
  expect(document.activeElement).toBe(tempo);
  if (action === 'Escape') expect(store.project).toBe(before);
  else {
    expect(store.project.bpm).toBe(147.5);
    expect(store.project.tracks[0].mute).toBe(true);
    store.undo();
    expect(store.project).toBe(before);
  }
});
