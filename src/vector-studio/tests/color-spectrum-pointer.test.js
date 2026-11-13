import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app, editor, node, spectrum, listeners, documentListeners;
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  documentListeners = vi.spyOn(document, 'addEventListener');
  app = await bootAppWithFeatures();
  editor = app.newDocument();
  node = createPath(rectangle(0, 0, 40, 40), true, { fill: { type: 'solid', color: '#123456' } });
  editor.doc.transact('Rectangle', () => editor.doc.insert(node, editor.targetLayer().id));
  editor.select([node.id]);
  app.openPanel('color');
  const panel = app.dock.panels.get('color');
  panel.update();
  spectrum = panel.spectrum;
  spectrum.setPointerCapture = vi.fn();
  spectrum.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
});
afterEach(() => {
  app.root.remove();
  for (const args of listeners.mock.calls) window.removeEventListener(...args);
  for (const args of documentListeners.mock.calls) document.removeEventListener(...args);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function pointer(type, id = 1, x = 0, y = 50, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperty(event, 'pointerId', { value: id });
  spectrum.dispatchEvent(event);
}
const color = () => editor.doc.get(node.id).fill.color;

it.each([1, 2])('does not paint with mouse button %s', (button) => {
  const revision = editor.doc.revision;
  pointer('pointerdown', 1, 0, 100, button);
  pointer('pointermove', 1, 0, 100);
  pointer('pointerup');
  expect(color()).toBe('#123456');
  expect(editor.doc.revision).toBe(revision);
  expect(spectrum.setPointerCapture).not.toHaveBeenCalled();
});

it('ignores another pointer’s movement during a spectrum drag', () => {
  pointer('pointerdown');
  pointer('pointermove', 1, 0, 0);
  pointer('pointermove', 2, 0, 100);
  expect(color()).toBe('#ffffff');
  pointer('pointerup');
  editor.doc.undo();
  expect(color()).toBe('#123456');
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('ignores another pointer’s %s while retaining the original drag', (ending) => {
  pointer('pointerdown');
  pointer(ending, 2);
  pointer('pointermove', 1, 0, 0);
  expect(color()).toBe('#ffffff');
  pointer('pointerup');
  pointer('pointermove', 1, 0, 100);
  expect(color()).toBe('#ffffff');
});

it('ignores another start without splitting the current undo gesture', () => {
  pointer('pointerdown');
  pointer('pointerdown', 2, 0, 100);
  expect(color()).toBe('#ff0000');
  expect(spectrum.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  pointer('pointermove', 1, 0, 0);
  pointer('pointerup');
  editor.doc.undo();
  expect(color()).toBe('#123456');
  editor.doc.redo();
  expect(color()).toBe('#ffffff');
});

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('stops after %s and gives a fresh drag its own Undo step', (ending) => {
  pointer('pointerdown');
  pointer('pointermove', 1, 0, 0);
  pointer(ending);
  pointer('pointermove', 1, 0, 100);
  expect(color()).toBe('#ffffff');
  pointer('pointerdown', 3, 0, 100);
  pointer('pointerup', 3);
  expect(color()).toBe('#000000');
  editor.doc.undo();
  expect(color()).toBe('#ffffff');
  editor.doc.undo();
  expect(color()).toBe('#123456');
});

it('aborts failed capture without changing artwork or leaving an active drag', () => {
  const errors = [];
  const onError = (event) => { errors.push(event.error); event.preventDefault(); };
  window.addEventListener('error', onError);
  try {
    spectrum.setPointerCapture.mockImplementationOnce(() => { throw new DOMException('Inactive pointer', 'NotFoundError'); });
    pointer('pointerdown', 1, 0, 100);
    pointer('pointermove', 1, 0, 100);
    expect(errors).toEqual([]);
    expect(color()).toBe('#123456');
    pointer('pointerdown', 2, 0, 0);
    pointer('pointerup', 2);
    expect(color()).toBe('#ffffff');
    editor.doc.undo();
    expect(color()).toBe('#123456');
  } finally { window.removeEventListener('error', onError); }
});

it('clamps ordinary drags to the spectrum and keeps one Undo step', () => {
  pointer('pointerdown', 1, -20, -10);
  expect(color()).toBe('#ffffff');
  pointer('pointermove', 1, 120, 120);
  pointer('pointerup');
  expect(color()).toBe('#000000');
  editor.doc.undo();
  expect(color()).toBe('#123456');
});

it('supports a local drag when pointer capture is unavailable', () => {
  spectrum.setPointerCapture = undefined;
  pointer('pointerdown', 1, 0, 0);
  pointer('pointermove', 1, 100, 100);
  pointer('pointerup');
  pointer('pointermove', 1, 0, 0);
  expect(color()).toBe('#000000');
});
