import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { numberField } from '../src/ui/widgets.js';

let f, label, commit;
beforeEach(() => {
  commit = vi.fn();
  f = numberField({ label: 'Width', kind: 'number', value: 100, onCommit: commit });
  document.body.append(f.el);
  label = f.el.querySelector('label');
  label.setPointerCapture = vi.fn();
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
function pointer(type, id = 1, x = 10, button = 0, shiftKey = false) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button, shiftKey });
  Object.defineProperty(event, 'pointerId', { value: id });
  label.dispatchEvent(event);
}

it.each([1, 2])('does not scrub with mouse button %s', (button) => {
  pointer('pointerdown', 1, 10, button);
  pointer('pointermove', 1, 30);
  pointer('pointerup');
  expect(f.input.value).toBe('100');
  expect(commit).not.toHaveBeenCalled();
  expect(label.setPointerCapture).not.toHaveBeenCalled();
});

it('ignores another pointer’s movement during a scrub', () => {
  pointer('pointerdown');
  pointer('pointermove', 1, 30);
  pointer('pointermove', 2, 90);
  expect(f.input.value).toBe('110');
  expect(commit).toHaveBeenCalledExactlyOnceWith(110, { live: true });
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('ignores another pointer’s %s and keeps the original scrub active', (ending) => {
  pointer('pointerdown');
  pointer(ending, 2);
  expect(document.activeElement).not.toBe(f.input);
  pointer('pointermove', 1, 30);
  expect(commit).toHaveBeenCalledExactlyOnceWith(110, { live: true });
  pointer('pointerup');
  pointer('pointermove', 1, 90);
  expect(commit).toHaveBeenCalledOnce();
});

it('does not start a second scrub while the original pointer owns the label', () => {
  pointer('pointerdown');
  pointer('pointerdown', 2, 100);
  pointer('pointermove', 1, 30);
  expect(commit).toHaveBeenCalledExactlyOnceWith(110, { live: true });
  expect(label.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1);
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('stops scrubbing after %s and supports a fresh scrub', (ending) => {
  pointer('pointerdown');
  pointer('pointermove', 1, 30);
  pointer(ending);
  pointer('pointermove', 1, 90);
  expect(commit).toHaveBeenCalledExactlyOnceWith(110, { live: true });
  pointer('pointerdown', 3);
  pointer('pointermove', 3, 30);
  pointer('pointerup', 3);
  expect(f.input.value).toBe('120');
  expect(commit).toHaveBeenCalledTimes(2);
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('only focuses the input for a completed click (%s)', (ending) => {
  pointer('pointerdown');
  pointer(ending);
  expect(document.activeElement === f.input).toBe(ending === 'pointerup');
  expect(commit).not.toHaveBeenCalled();
});

it('handles failed pointer capture without an error or a lingering scrub', () => {
  const errors = [];
  const onError = (event) => { errors.push(event.error); event.preventDefault(); };
  window.addEventListener('error', onError);
  try {
    label.setPointerCapture.mockImplementationOnce(() => { throw new DOMException('Inactive pointer', 'NotFoundError'); });
    pointer('pointerdown');
    pointer('pointermove', 1, 30);
    expect(errors).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
    pointer('pointerdown', 2);
    pointer('pointermove', 2, 30);
    pointer('pointerup', 2);
    expect(commit).toHaveBeenCalledExactlyOnceWith(110, { live: true });
  } finally { window.removeEventListener('error', onError); }
});

it('preserves accelerated Shift scrubbing', () => {
  pointer('pointerdown');
  pointer('pointermove', 1, 30, 0, true);
  pointer('pointerup');
  expect(commit).toHaveBeenCalledExactlyOnceWith(200, { live: true });
});

it('supports a local scrub when pointer capture is unavailable', () => {
  label.setPointerCapture = undefined;
  pointer('pointerdown');
  pointer('pointermove', 1, 30);
  pointer('pointerup');
  pointer('pointermove', 1, 90);
  expect(commit).toHaveBeenCalledExactlyOnceWith(110, { live: true });
});
