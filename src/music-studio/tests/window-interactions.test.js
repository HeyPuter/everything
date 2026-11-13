import { afterEach, expect, it, vi } from 'vitest';
import { closeWindows, getWindow, openWindow } from '../src/ui/windows.js';

afterEach(() => {
  closeWindows();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function setup() {
  const launcher = document.createElement('button');
  launcher.textContent = 'Open editor';
  document.body.append(launcher);
  launcher.focus();
  const control = document.createElement('button');
  control.textContent = 'Parameter';
  const toolbar = document.createElement('button');
  toolbar.textContent = 'Preset';
  const win = openWindow({ key: 'test-editor', title: 'Test editor', body: control, toolbar });
  const head = win.el.querySelector('.win-head');
  head.setPointerCapture = vi.fn();
  head.releasePointerCapture = vi.fn();
  const position = () => [parseFloat(win.el.style.left), parseFloat(win.el.style.top)];
  const pointer = (type, xy = 300, id = 1, target = head, button = 0) => {
    const event = new MouseEvent(type, { button, clientX: xy, clientY: xy, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    target.dispatchEvent(event);
  };
  return { win, head, launcher, control, toolbar, position, pointer };
}

it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'close'])('stops moving an editor window after %s', (end) => {
  const { win, head, position, pointer } = setup();
  const before = position();
  pointer('pointerdown');
  pointer('pointermove', 320);
  expect(position()).toEqual(before.map((n) => n + 20));
  const moved = position();
  if (end === 'close') win.close();
  else if (end === 'blur') window.dispatchEvent(new Event('blur'));
  else pointer(end, 320);
  pointer('pointermove', 350);
  pointer('pointerup', 350);
  expect(position()).toEqual(moved);
  if (end !== 'close') {
    pointer('pointerdown');
    pointer('pointermove', 310);
    pointer('pointerup', 310);
    pointer('lostpointercapture', 310);
    expect(position()).toEqual(moved.map((n) => n + 10));
  } else {
    expect(head.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(getWindow('test-editor')).toBeNull();
  }
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('ignores a competing window-drag pointer and its %s', (end) => {
  const { position, pointer } = setup();
  pointer('pointerdown');
  pointer('pointermove', 320);
  const moved = position();
  pointer('pointerdown', 400, 2);
  pointer('pointermove', 450, 2);
  pointer(end, 450, 2);
  expect(position()).toEqual(moved);
  pointer('pointermove', 330);
  pointer('pointerup', 330);
  expect(position()).toEqual(moved.map((n) => n + 10));
});

it('preserves toolbar clicks, normal focus, and Escape close during a drag', () => {
  const { win, head, launcher, control, toolbar, position, pointer } = setup();
  expect(document.activeElement === control).toBe(true);
  const before = position();
  pointer('pointerdown', 300, 1, toolbar);
  pointer('pointermove', 350);
  pointer('pointerup', 350);
  pointer('pointerdown', 300, 1, head, 2);
  pointer('pointermove', 350);
  pointer('pointerup', 350);
  expect(position()).toEqual(before);
  pointer('pointerdown');
  pointer('pointermove', 310);
  const moved = position();
  control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(win.el.isConnected).toBe(false);
  expect(document.activeElement === launcher).toBe(true);
  pointer('pointermove', 350);
  pointer('pointerup', 350);
  expect(position()).toEqual(moved);
});
