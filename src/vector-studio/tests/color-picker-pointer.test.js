import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createColorPicker } from '../src/ui/color-picker.js';
import { installCanvasStub } from './helpers.js';

let picker, area, input, commit;
beforeEach(() => {
  installCanvasStub();
  input = vi.fn();
  commit = vi.fn();
  picker = createColorPicker({ value: '#ff0000', onInput: input, onCommit: commit });
  document.body.append(picker.el);
  area = picker.el.querySelector('.cp-sv-wrap');
  area.setPointerCapture = vi.fn();
  picker.el.querySelector('canvas').getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
function pointer(type, id = 1, x = 100, y = 0, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperty(event, 'pointerId', { value: id });
  area.dispatchEvent(event);
}

it.each([1, 2])('does not choose a color with mouse button %s', (button) => {
  pointer('pointerdown', 1, 0, 100, button);
  pointer('pointermove', 1, 0, 100);
  pointer('pointerup');
  expect(picker.value).toBe('#ff0000');
  expect(input).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
  expect(area.setPointerCapture).not.toHaveBeenCalled();
});

it('ignores another pointer’s movement during a color drag', () => {
  pointer('pointerdown');
  pointer('pointermove', 1, 0, 0);
  pointer('pointermove', 2, 0, 100);
  expect(picker.value).toBe('#ffffff');
  expect(input).toHaveBeenCalledTimes(2);
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('ignores another pointer’s %s while retaining the original drag', (ending) => {
  pointer('pointerdown');
  pointer(ending, 2);
  expect(commit).not.toHaveBeenCalled();
  pointer('pointermove', 1, 0, 0);
  expect(picker.value).toBe('#ffffff');
  pointer('pointerup');
  expect(commit).toHaveBeenCalledExactlyOnceWith('#ffffff');
  pointer('pointermove', 1, 0, 100);
  expect(picker.value).toBe('#ffffff');
});

it('does not start another drag while the first pointer owns the picker', () => {
  pointer('pointerdown');
  pointer('pointerdown', 2, 0, 100);
  expect(picker.value).toBe('#ff0000');
  expect(area.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  pointer('pointermove', 1, 0, 0);
  pointer('pointerup');
  expect(commit).toHaveBeenCalledExactlyOnceWith('#ffffff');
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('stops after %s and allows a fresh drag', (ending) => {
  pointer('pointerdown');
  pointer('pointermove', 1, 0, 0);
  pointer(ending);
  pointer('pointermove', 1, 0, 100);
  expect(picker.value).toBe('#ffffff');
  expect(commit).toHaveBeenCalledExactlyOnceWith('#ffffff');
  pointer('pointerdown', 3, 100, 100);
  pointer('pointerup', 3);
  expect(picker.value).toBe('#000000');
  expect(commit).toHaveBeenCalledTimes(2);
});

it('aborts failed capture without changing color or leaving an active drag', () => {
  const errors = [];
  const onError = (event) => { errors.push(event.error); event.preventDefault(); };
  window.addEventListener('error', onError);
  try {
    area.setPointerCapture.mockImplementationOnce(() => { throw new DOMException('Inactive pointer', 'NotFoundError'); });
    pointer('pointerdown', 1, 0, 100);
    pointer('pointermove', 1, 0, 100);
    expect(errors).toEqual([]);
    expect(input).not.toHaveBeenCalled();
    expect(picker.value).toBe('#ff0000');
    pointer('pointerdown', 2, 0, 0);
    pointer('pointerup', 2);
    expect(commit).toHaveBeenCalledExactlyOnceWith('#ffffff');
  } finally { window.removeEventListener('error', onError); }
});

it('clamps ordinary drags to the color field and focuses its keyboard slider', () => {
  pointer('pointerdown', 1, -20, -10);
  expect(picker.value).toBe('#ffffff');
  expect(document.activeElement).toBe(picker.el.querySelector('[role="slider"]'));
  pointer('pointermove', 1, 120, 120);
  pointer('pointerup');
  expect(commit).toHaveBeenCalledExactlyOnceWith('#000000');
});


it('supports a local drag when pointer capture is unavailable', () => {
  area.setPointerCapture = undefined;
  pointer('pointerdown', 1, 0, 0);
  pointer('pointermove', 1, 100, 100);
  pointer('pointerup');
  pointer('pointermove', 1, 0, 0);
  expect(picker.value).toBe('#000000');
  expect(commit).toHaveBeenCalledExactlyOnceWith('#000000');
});
