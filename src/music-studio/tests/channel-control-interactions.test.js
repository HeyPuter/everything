import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { newProject } from '../src/model/demo.js';
import * as rack from '../src/panels/channel-rack.js';
import * as mixer from '../src/panels/mixer.js';
import { openChannelEditor } from '../src/rack/editor.js';
import { closeWindows } from '../src/ui/windows.js';

let app;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML = '<div id="app"></div>';
  app = new App(document.getElementById('app'), { project: newProject(), storage: { getItem: () => null, setItem() {} } });
  app.start([rack, mixer]);
  app.shell.show('rack');
  app.shell.show('mixer');
});
afterEach(() => {
  closeWindows();
  for (const name of ['rack', 'mixer']) app.panel(name).onHide?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function instrumentWindow(kind, channel = 0) {
  const win = openChannelEditor(app, app.store.project.channels[channel].id);
  [...win.el.querySelectorAll('[role="tab"]')].find((el) => el.textContent === (kind === 'instrument' ? 'Instrument' : 'Channel')).click();
  return win;
}
function input(el) {
  expect(el).not.toBeNull();
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  const pointer = (type, y = 300) => {
    const event = new MouseEvent(type, { button: 0, clientY: y, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    el.dispatchEvent(event);
  };
  const wheel = () => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, bubbles: true, cancelable: true }));
  const key = () => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  return { el, pointer, wheel, key };
}
function controls(kind, target) {
  const win = instrumentWindow(kind);
  const old = input(win.el.querySelector(kind === 'instrument' ? '[aria-label="Voice tone"]' : '[aria-label="Channel pan"]'));
  let next;
  if (target === 'same window') next = win.el.querySelector(kind === 'instrument' ? '[aria-label="Voice punch"]' : '[aria-label="Channel volume"]');
  else if (target === 'another window') next = instrumentWindow(kind, 1).el.querySelector(kind === 'instrument' ? '[aria-label="Voice tone"]' : '[aria-label="Channel pan"]');
  else if (target === 'rack') next = app.panel('rack').view.grid.querySelectorAll('.rack-row')[1].querySelector('.c-vol [role="slider"]');
  else next = app.panel('mixer').strips[2].fader.slider;
  return { old, next: input(next) };
}

const cases = ['instrument', 'channel'].flatMap((kind) => ['same window', 'another window', 'rack', 'mixer'].flatMap((target) => ['pointer', 'key', 'wheel'].map((mode) => [kind, target, mode])));
it.each(cases)('keeps %s controls attached to their edit when %s receives input during %s', (kind, target, mode) => {
  const { old, next } = controls(kind, target);
  const store = app.store;
  const initial = store.project;
  old.el.focus();
  if (mode === 'pointer') {
    old.pointer('pointerdown');
    old.pointer('pointermove', 292);
  } else old[mode]();
  const first = store.project;
  expect(first === initial).toBe(false);
  vi.advanceTimersByTime(100);
  next.wheel();
  const preview = store.project;
  const owner = store.gesture;
  expect(preview === first).toBe(false);
  if (mode === 'pointer') {
    old.pointer('pointermove', 276);
    old.pointer('pointerup', 276);
  } else vi.advanceTimersByTime(350);
  expect(store.project === preview).toBe(true);
  expect(store.gesture === owner).toBe(true);
  expect(store.undoStack).toHaveLength(1);
  const originalValue = kind === 'instrument' ? first.channels[0].params.tone : first.channels[0].pan;
  expect(Number(old.el.getAttribute('aria-valuenow'))).toBeCloseTo(originalValue, 3);
  next.wheel();
  vi.advanceTimersByTime(500);
  expect(store.undoStack).toHaveLength(2);
  store.undo();
  expect(store.project === first).toBe(true);
  store.undo();
  expect(store.project === initial).toBe(true);
  old.wheel();
  vi.advanceTimersByTime(500);
  expect(store.project === initial).toBe(false);
  store.undo();
  expect(store.project === initial).toBe(true);
});

it.each(['instrument', 'channel'].flatMap((kind) => ['pointer', 'pending pointer', 'key', 'wheel'].map((mode) => [kind, mode])))('finishes %s %s input when Escape closes its editor', (kind, mode) => {
  const win = instrumentWindow(kind);
  const old = input(win.el.querySelector(kind === 'instrument' ? '[aria-label="Voice tone"]' : '[aria-label="Channel pan"]'));
  const store = app.store;
  const initial = store.project;
  old.el.focus();
  if (mode.includes('pointer')) {
    old.pointer('pointerdown');
    if (mode === 'pointer') old.pointer('pointermove', 292);
  } else old[mode]();
  const edited = store.project;
  old.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(win.el.isConnected).toBe(false);
  expect(store.gesture === null).toBe(true);
  expect(store.undoStack).toHaveLength(mode === 'pending pointer' ? 0 : 1);
  old.pointer('pointermove', 276);
  old.pointer('pointerup', 276);
  vi.advanceTimersByTime(500);
  expect(store.project === edited).toBe(true);
  expect(store.gesture === null).toBe(true);
  const fresh = instrumentWindow(kind);
  const next = input(fresh.el.querySelector(kind === 'instrument' ? '[aria-label="Voice tone"]' : '[aria-label="Channel pan"]'));
  next.wheel();
  vi.advanceTimersByTime(500);
  store.undo();
  expect(store.project === edited).toBe(true);
  if (mode !== 'pending pointer') store.undo();
  expect(store.project === initial).toBe(true);
});

it.each(['instrument', 'channel'])('closing an inactive %s editor preserves another control gesture', (kind) => {
  const { old, next } = controls(kind, 'mixer');
  old.el.focus();
  old.wheel();
  const first = app.store.project;
  next.wheel();
  const owner = app.store.gesture;
  old.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(old.el.isConnected).toBe(false);
  expect(app.store.gesture === owner).toBe(true);
  next.wheel();
  vi.advanceTimersByTime(500);
  expect(app.store.undoStack).toHaveLength(2);
  app.store.undo();
  expect(app.store.project === first).toBe(true);
});

it.each(['knob', 'fader'].flatMap((kind) => ['pointer', 'pending pointer', 'key', 'wheel'].map((mode) => [kind, mode])))('ends a %s %s interaction when the browser window loses focus', (kind, mode) => {
  const { old, next } = controls('channel', 'mixer');
  const control = kind === 'knob' ? old : next;
  const store = app.store;
  const initial = store.project;
  control.el.focus();
  if (mode.includes('pointer')) {
    control.pointer('pointerdown');
    if (mode === 'pointer') control.pointer('pointermove', 292);
  } else control[mode]();
  const edited = store.project;
  window.dispatchEvent(new Event('blur'));
  expect(store.gesture === null).toBe(true);
  expect(control.el.classList.contains('dragging')).toBe(false);
  expect(store.undoStack).toHaveLength(mode === 'pending pointer' ? 0 : 1);
  control.pointer('pointermove', 276);
  control.pointer('pointerup', 276);
  vi.advanceTimersByTime(500);
  expect(store.project === edited).toBe(true);
  control.pointer('pointerdown');
  control.pointer('pointermove', 298);
  control.pointer('pointerup', 298);
  expect(store.project === edited).toBe(false);
  store.undo();
  expect(store.project === edited).toBe(true);
  if (mode !== 'pending pointer') store.undo();
  expect(store.project === initial).toBe(true);
});
