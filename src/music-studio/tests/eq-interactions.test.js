import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { MixerController } from '../src/mixer/controller.js';
import { openEffectEditor } from '../src/effects/ui/editor.js';
import { closeWindows } from '../src/ui/windows.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  const drawing = new Proxy({}, { get: (t, k) => t[k] ?? (() => {}), set: (t, k, v) => ((t[k] = v), true) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(drawing);
});
afterEach(() => {
  closeWindows();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const app = new App(root, { storage: { getItem: () => null, setItem() {} } });
  const ctl = new MixerController(app);
  const slotId = ctl.addEffect(1, 'eq');
  app.store.load(structuredClone(app.store.project));
  const win = openEffectEditor(app, ctl, 1, slotId);
  const box = win.el.querySelector('.eqg');
  box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 560, height: 220 });
  const handle = win.el.querySelector('[data-band="m1"]');
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
  const pointer = (type, x = 200, y = 110, id = 1, target = handle, extra = {}) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true, ...extra });
    Object.defineProperty(event, 'pointerId', { value: id });
    target.dispatchEvent(event);
  };
  return { app, store: app.store, ctl, slotId, win, handle, pointer, params: () => app.store.project.mixer[1].fx[0].params };
}

it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'close'])('finishes an EQ drag on %s and ignores stale movement', (end) => {
  const { store, win, handle, pointer, params } = setup();
  const before = store.project;
  pointer('pointerdown');
  pointer('pointermove', 210, 100);
  expect(params().m1_freq).toBeGreaterThan(before.mixer[1].fx[0].params.m1_freq);
  expect(params().m1_gain).toBeGreaterThan(0);
  if (end === 'close') win.close();
  else if (end === 'blur') handle.blur();
  else pointer(end, 210, 100);
  const finished = store.project;
  expect(Boolean(store.gesture)).toBe(false);
  expect(handle.classList.contains('dragging')).toBe(false);
  expect(store.undoStack).toHaveLength(1);
  pointer('pointermove', 240, 80);
  pointer('pointerup', 240, 80);
  pointer('lostpointercapture', 240, 80);
  expect(store.project === finished).toBe(true);
  expect(store.undoStack).toHaveLength(1);
  store.undo();
  expect(store.project === before).toBe(true);
  if (end !== 'close') {
    pointer('pointerdown');
    pointer('pointermove', 210, 100);
    pointer('pointerup', 210, 100);
    expect(params().m1_gain).toBeGreaterThan(0);
    store.undo();
    expect(store.project === before).toBe(true);
  }
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('keeps an EQ drag owned by its first pointer despite foreign %s', (end) => {
  const { store, win, handle, pointer, params } = setup();
  const before = store.project;
  pointer('pointerdown');
  pointer('pointermove', 210, 100);
  const moved = store.project;
  const other = win.el.querySelector('[data-band="m2"]');
  other.setPointerCapture = vi.fn();
  pointer('pointerdown', 220, 120, 2, other);
  pointer('pointermove', 260, 80, 2, other);
  pointer(end, 260, 80, 2, other);
  pointer('pointerdown', 230, 130, 2);
  pointer('pointermove', 270, 70, 2);
  pointer(end, 270, 70, 2);
  expect(store.project === moved).toBe(true);
  expect(handle.classList.contains('dragging')).toBe(true);
  pointer('pointermove', 220, 90);
  pointer('pointerup', 220, 90);
  expect(params().m1_gain).toBeGreaterThan(moved.mixer[1].fx[0].params.m1_gain);
  expect(params().m2_gain).toBe(0);
  expect(store.undoStack).toHaveLength(1);
  store.undo();
  expect(store.project === before).toBe(true);
});

it.each([['load', false], ['undo', false], ['redo', false], ['load', true], ['undo', true]])('discards obsolete EQ drags after %s (moved: %s)', (action, moved) => {
  const { store, handle, pointer } = setup();
  if (action !== 'load') {
    store.apply('Tempo', (p) => ({ ...p, bpm: 150 }));
    if (action === 'redo') store.undo();
  }
  pointer('pointerdown');
  if (moved) pointer('pointermove', 210, 100);
  if (action === 'load') store.load(structuredClone(store.project));
  else store[action]();
  const restored = store.project;
  const history = store.undoStack.length;
  const canRedo = store.canRedo;
  pointer('pointermove', 230, 80);
  pointer('pointerup', 230, 80);
  expect(store.project === restored).toBe(true);
  expect(store.undoStack).toHaveLength(history);
  expect(store.canRedo).toBe(canRedo);
  expect(handle.classList.contains('dragging')).toBe(false);
  pointer('pointerdown');
  pointer('pointermove', 210, 100);
  pointer('pointerup', 210, 100);
  expect(store.project === restored).toBe(false);
  store.undo();
  expect(store.project === restored).toBe(true);
});

it.each(['key', 'wheel'].flatMap((kind) => [true, false].map((load) => [kind, load])))('prevents an old EQ %s timer from committing a newer edit (load: %s)', (kind, load) => {
  const { store, handle } = setup();
  if (kind === 'key') handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  else handle.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
  if (load) store.load(structuredClone(store.project));
  store.begin('Tempo');
  store.preview((p) => ({ ...p, bpm: 150 }));
  const newer = store.gesture;
  const history = store.undoStack.length;
  vi.advanceTimersByTime(500);
  expect(store.gesture === newer).toBe(true);
  expect(store.undoStack).toHaveLength(history);
  store.cancel();
  expect(store.project.bpm).toBe(130);
});

it('does not let a superseded EQ drag overwrite or commit another edit', () => {
  const { store, pointer } = setup();
  pointer('pointerdown');
  pointer('pointermove', 210, 100);
  store.begin('Tempo');
  store.preview((p) => ({ ...p, bpm: 150 }));
  const newer = store.gesture;
  const preview = store.project;
  pointer('pointermove', 230, 80);
  pointer('pointerup', 230, 80);
  expect(store.project === preview).toBe(true);
  expect(store.gesture === newer).toBe(true);
  store.cancel();
  expect(store.project.bpm).toBe(130);
});

it('preserves ordinary EQ keys, wheel, reset, fine dragging and unrelated tempo edits', () => {
  const { store, handle, pointer, params } = setup();
  const initial = store.project;
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
  expect(params().m1_gain).toBe(0.1);
  vi.advanceTimersByTime(500);
  store.undo();
  expect(store.project === initial).toBe(true);
  const q = params().m1_q;
  handle.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
  expect(params().m1_q).toBeCloseTo(q * 1.08);
  vi.advanceTimersByTime(500);
  store.undo();
  expect(store.project === initial).toBe(true);
  pointer('pointerdown');
  store.apply('Tempo', (p) => ({ ...p, bpm: 150 }));
  const edited = store.project;
  pointer('pointermove', 210, 100, 1, handle, { shiftKey: true });
  pointer('pointerup', 210, 100);
  expect(params().m1_gain).toBe(0.4);
  expect(store.project.bpm).toBe(150);
  handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  expect(params().m1_gain).toBe(0);
  store.undo();
  expect(params().m1_gain).toBe(0.4);
  store.undo();
  expect(store.project === edited).toBe(true);
});
