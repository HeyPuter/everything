import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { newProject } from '../src/model/demo.js';
import * as mixer from '../src/panels/mixer.js';
import { closeWindows } from '../src/ui/windows.js';

let app;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML = '<div id="app"></div>';
  app = new App(document.getElementById('app'), { project: newProject(), storage: { getItem: () => null, setItem() {} } });
  app.start([mixer]);
  app.shell.show('mixer');
});
afterEach(() => {
  closeWindows();
  app.panel('mixer').onHide();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});
function input(el) {
  expect(el).not.toBeNull();
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  const pointer = (type, y = 300) => {
    const event = new MouseEvent(type, { button: 0, clientY: y, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    el.dispatchEvent(event);
  };
  return {
    el, pointer,
    wheel: () => el.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true })),
    key: () => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })),
  };
}
function effect(kind) {
  const type = kind === 'mix' ? 'reverb' : kind;
  const id = app.mixerController.addEffect(3, type);
  const selector = kind === 'mix' ? '[aria-label="Reverb mix"]' : `[data-param="${{ reverb: 'decay', delay: 'feedback', compressor: 'threshold', eq: 'm1_gain' }[kind]}"]`;
  const open = () => {
    const win = app.openEffectEditor(3, id);
    const head = win.el.querySelector('.win-head');
    head.setPointerCapture = vi.fn();
    head.releasePointerCapture = vi.fn();
    return win;
  };
  const win = open();
  return { win, open, selector, control: input(win.el.querySelector(selector)) };
}

it.each(['mix', 'reverb', 'delay', 'compressor', 'eq'].flatMap((kind) => ['pointer', 'pending pointer', 'key', 'wheel'].map((mode) => [kind, mode])))('finishes %s %s input when Escape closes its effect editor', (kind, mode) => {
  const { win, open, selector, control } = effect(kind);
  const store = app.store;
  const initial = store.project;
  const undoCount = store.undoStack.length;
  control.el.focus();
  if (mode.includes('pointer')) {
    control.pointer('pointerdown');
    if (mode === 'pointer') control.pointer('pointermove', 308);
  } else control[mode]();
  const edited = store.project;
  expect(edited === initial).toBe(mode === 'pending pointer');
  control.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(win.el.isConnected).toBe(false);
  expect(store.gesture === null).toBe(true);
  expect(store.undoStack).toHaveLength(undoCount + (mode === 'pending pointer' ? 0 : 1));
  control.pointer('pointermove', 316);
  control.pointer('pointerup', 316);
  vi.advanceTimersByTime(500);
  expect(store.project === edited).toBe(true);
  expect(store.gesture === null).toBe(true);
  const fresh = input(open().el.querySelector(selector));
  fresh.wheel();
  vi.advanceTimersByTime(500);
  store.undo();
  expect(store.project === edited).toBe(true);
  if (mode !== 'pending pointer') store.undo();
  expect(store.project === initial).toBe(true);
});

it.each(['mix', 'reverb', 'delay', 'compressor', 'eq'])('closing an inactive %s editor preserves a newer fader edit', (kind) => {
  const { control, win } = effect(kind);
  control.el.focus();
  control.wheel();
  const first = app.store.project;
  const next = input(app.panel('mixer').strips[2].fader.slider);
  next.wheel();
  const owner = app.store.gesture;
  control.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(win.el.isConnected).toBe(false);
  expect(app.store.gesture === owner).toBe(true);
  next.wheel();
  vi.advanceTimersByTime(500);
  app.store.undo();
  expect(app.store.project === first).toBe(true);
});
