import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { installTaskbar } from '../src/features/artboards/taskbar.js';

let app, grip, listeners, persist;
beforeEach(() => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  app = bootApp();
  installTaskbar(app);
  app.newDocument();
  vi.advanceTimersByTime(20);
  grip = app.taskbar.querySelector('.tb-grip');
  grip.setPointerCapture = vi.fn();
  for (const [key, value] of Object.entries({ offsetLeft: 10, offsetTop: 20, offsetWidth: 100, offsetHeight: 34 })) {
    Object.defineProperty(app.taskbar, key, { configurable: true, value });
  }
  Object.defineProperties(app.taskbar.parentElement, { clientWidth: { configurable: true, value: 600 }, clientHeight: { configurable: true, value: 400 } });
  persist = vi.spyOn(app.prefs, 'set');
});
afterEach(() => {
  app.root.remove();
  for (const args of listeners.mock.calls) window.removeEventListener(...args);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function pointer(type, id = 1, x = 10, y = 10, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperty(event, 'pointerId', { value: id });
  grip.dispatchEvent(event);
}
const position = () => app.prefs.get('taskbarPos');

it('ignores another pointer’s movement during a task-bar drag', () => {
  pointer('pointerdown');
  pointer('pointermove', 1, 30, 40);
  expect(position()).toEqual({ x: 30, y: 50 });
  pointer('pointermove', 2, 90, 90);
  expect(position()).toEqual({ x: 30, y: 50 });
  expect([app.taskbar.style.left, app.taskbar.style.top]).toEqual(['30px', '50px']);
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('ignores another pointer’s %s and keeps the original drag active', (ending) => {
  pointer('pointerdown');
  pointer(ending, 2);
  pointer('pointermove', 1, 30, 40);
  expect(position()).toEqual({ x: 30, y: 50 });
  expect(persist).not.toHaveBeenCalled();
  pointer('pointerup');
  expect(persist).toHaveBeenCalledExactlyOnceWith('taskbarPos', { x: 30, y: 50 });
});

it('does not start a second drag while the first pointer owns the grip', () => {
  pointer('pointerdown');
  pointer('pointerdown', 2, 100, 100);
  pointer('pointermove', 1, 30, 40);
  expect(position()).toEqual({ x: 30, y: 50 });
  expect(grip.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  pointer('pointerup');
  expect(persist).toHaveBeenCalledOnce();
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('ends a drag on %s and allows a fresh drag', (ending) => {
  pointer('pointerdown');
  pointer('pointermove', 1, 30, 40);
  pointer(ending);
  pointer('pointermove', 1, 90, 90);
  expect(position()).toEqual({ x: 30, y: 50 });
  expect(persist).toHaveBeenCalledOnce();
  pointer('pointerdown', 3);
  pointer('pointermove', 3, 50, 60);
  pointer('pointerup', 3);
  expect(position()).toEqual({ x: 50, y: 70 });
  expect(persist).toHaveBeenCalledTimes(2);
});

it.each([1, 2])('does not drag with mouse button %s', (button) => {
  pointer('pointerdown', 1, 10, 10, button);
  pointer('pointermove', 1, 30, 40);
  pointer('pointerup');
  expect(position()).toBeFalsy();
  expect(grip.setPointerCapture).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
});

it('does not leave a drag active when acquiring pointer capture fails', () => {
  grip.setPointerCapture.mockImplementationOnce(() => { throw new DOMException('Inactive pointer', 'NotFoundError'); });
  pointer('pointerdown');
  pointer('pointermove', 1, 30, 40);
  expect(position()).toBeFalsy();
  expect(persist).not.toHaveBeenCalled();
  pointer('pointerdown', 2);
  pointer('pointermove', 2, 30, 40);
  pointer('pointerup', 2);
  expect(position()).toEqual({ x: 30, y: 50 });
  expect(persist).toHaveBeenCalledOnce();
});

it('still supports a local drag when pointer capture is unavailable', () => {
  grip.setPointerCapture = undefined;
  pointer('pointerdown');
  pointer('pointermove', 1, 30, 40);
  pointer('pointerup');
  pointer('pointermove', 1, 90, 90);
  expect(position()).toEqual({ x: 30, y: 50 });
  expect(persist).toHaveBeenCalledOnce();
});
