import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGradientSlider } from '../src/features/paint/gradient-slider.js';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { paintState } from '../src/features/paint/ui-common.js';

const initial = () => ({ type: 'linear', angle: 0, stops: [
  { offset: 0, color: '#ff0000', opacity: 1 },
  { offset: 0.5, color: '#00ff00', opacity: 1 },
  { offset: 1, color: '#0000ff', opacity: 1 },
] });
let capture, starts, change, slider, paint;
const originalCapture = Element.prototype.setPointerCapture;
const originalRelease = Element.prototype.releasePointerCapture;
beforeEach(() => {
  capture = null;
  // jsdom does not implement pointer capture. Route subsequent owner events to
  // the requested element, but do not pretend a detached element retains it.
  // https://www.w3.org/TR/pointerevents/#implicit-release-of-pointer-capture
  Element.prototype.setPointerCapture = vi.fn(function (id) { capture = { el: this, id }; });
  Element.prototype.releasePointerCapture = vi.fn(function (id) {
    if (capture?.el === this && capture.id === id) capture = null;
  });
  starts = vi.fn();
  paint = initial();
  change = vi.fn((next) => { paint = next; });
  slider = createGradientSlider({ onChange: change, onGestureStart: starts });
  document.body.append(slider.el);
  slider.el.querySelector('.gs-bar').getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 10 });
  slider.set(paint);
});
afterEach(() => {
  if (originalCapture) Element.prototype.setPointerCapture = originalCapture;
  else delete Element.prototype.setPointerCapture;
  if (originalRelease) Element.prototype.releasePointerCapture = originalRelease;
  else delete Element.prototype.releasePointerCapture;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function pointer(target, type, { id = 1, x = 0, y = 10, button = 0, altKey = false } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button, altKey });
  Object.defineProperty(event, 'pointerId', { value: id });
  if (type === 'lostpointercapture' && capture?.id === id) capture = null;
  target.dispatchEvent(event);
  // Browsers implicitly release capture after pointerup/pointercancel.
  if (['pointerup', 'pointercancel'].includes(type) && capture?.id === id) capture = null;
}
const handle = (kind) => slider.el.querySelector(kind === 'stop' ? '.gs-stop' : '.gs-mid');
const owner = (fallback) => capture?.el.isConnected ? capture.el : fallback;
const value = (kind) => kind === 'stop' ? paint.stops.find((s) => s.color === '#ff0000').offset : paint.stops[0].midpoint ?? 0.5;

it.each([1, 2])('does not add a stop with mouse button %s', (button) => {
  pointer(slider.el.querySelector('.gs-stops'), 'pointerdown', { button, x: 25 });
  expect(change).not.toHaveBeenCalled();
  expect(starts).not.toHaveBeenCalled();
});
for (const kind of ['stop', 'midpoint']) {
  it.each([1, 2])(`does not start a ${kind} drag with mouse button %s`, (button) => {
    const target = handle(kind);
    pointer(target, 'pointerdown', { button });
    pointer(owner(target), 'pointermove', { x: 20 });
    pointer(owner(target), 'pointerup');
    expect(change).not.toHaveBeenCalled();
    expect(starts).not.toHaveBeenCalled();
    expect(capture).toBeNull();
  });
  it(`ignores a foreign pointer's movement during a ${kind} drag`, () => {
    const target = handle(kind);
    pointer(target, 'pointerdown');
    pointer(owner(target), 'pointermove', { x: 10 });
    const before = structuredClone(paint);
    pointer(target, 'pointermove', { id: 2, x: 40 });
    expect(paint).toEqual(before);
    pointer(owner(target), 'pointerup');
  });
  it.each(['pointerup', 'pointercancel', 'lostpointercapture'])(`ignores a foreign %s during a ${kind} drag`, (ending) => {
    const target = handle(kind);
    pointer(target, 'pointerdown');
    pointer(target, ending, { id: 2 });
    expect(change).not.toHaveBeenCalled();
    pointer(owner(target), 'pointermove', { x: 20 });
    expect(value(kind)).toBeCloseTo(kind === 'stop' ? 0.2 : 0.4);
    pointer(owner(target), 'pointerup');
  });
  it.each(['pointerup', 'pointercancel', 'lostpointercapture'])(`ends a ${kind} drag after %s`, (ending) => {
    const target = handle(kind);
    pointer(target, 'pointerdown');
    pointer(owner(target), 'pointermove', { x: 10 });
    pointer(owner(target), ending);
    const before = structuredClone(paint);
    pointer(target, 'pointermove', { x: 40 });
    expect(paint).toEqual(before);
    expect(capture).toBeNull();
    pointer(handle(kind), 'pointerdown', { id: 3 });
    pointer(owner(handle(kind)), 'pointermove', { id: 3, x: 20 });
    pointer(owner(handle(kind)), 'pointerup', { id: 3 });
    expect(value(kind)).toBeCloseTo(kind === 'stop' ? 0.2 : 0.4);
    expect(starts).toHaveBeenCalledTimes(2);
  });
  it(`rejects a competing stop or midpoint start during a ${kind} drag`, () => {
    const target = handle(kind);
    pointer(target, 'pointerdown');
    pointer(handle(kind === 'stop' ? 'midpoint' : 'stop'), 'pointerdown', { id: 2 });
    pointer(slider.el.querySelector('.gs-stops'), 'pointerdown', { id: 3, x: 25 });
    expect(starts).toHaveBeenCalledTimes(1);
    expect(paint.stops).toHaveLength(3);
    pointer(owner(target), 'pointermove', { x: 20 });
    expect(value(kind)).toBeCloseTo(kind === 'stop' ? 0.2 : 0.4);
    pointer(owner(target), 'pointerup');
  });
}

it.each(['pointercancel', 'lostpointercapture'])('does not delete the pending off-bar stop on %s', (ending) => {
  const target = handle('stop');
  pointer(target, 'pointerdown');
  pointer(owner(target), 'pointermove', { x: 20 });
  pointer(owner(target), 'pointermove', { x: 20, y: 60 });
  pointer(owner(target), ending);
  expect(paint.stops).toHaveLength(3);
  expect(value('stop')).toBeCloseTo(0.2);
  expect(slider.el.querySelector('.removing')).toBeNull();
});


for (const kind of ['stop', 'midpoint']) {
  it(`abandons a ${kind} drag when capture fails and permits retry`, () => {
    Element.prototype.setPointerCapture.mockImplementationOnce(() => { throw new DOMException('Inactive pointer', 'NotFoundError'); });
    const errors = [];
    const onError = (event) => { errors.push(event.error); event.preventDefault(); };
    window.addEventListener('error', onError);
    try {
      const target = handle(kind);
      pointer(target, 'pointerdown');
      pointer(target, 'pointermove', { x: 20 });
      expect(errors).toEqual([]);
      expect(change).not.toHaveBeenCalled();
      expect(starts).not.toHaveBeenCalled();
      pointer(target, 'pointerdown', { id: 2 });
      pointer(owner(target), 'pointermove', { id: 2, x: 20 });
      pointer(owner(target), 'pointerup', { id: 2 });
      expect(value(kind)).toBeCloseTo(kind === 'stop' ? 0.2 : 0.4);
    } finally { window.removeEventListener('error', onError); }
  });
  it(`supports a local ${kind} drag without pointer capture APIs`, () => {
    Element.prototype.setPointerCapture = undefined;
    Element.prototype.releasePointerCapture = undefined;
    const errors = [];
    const onError = (event) => { errors.push(event.error); event.preventDefault(); };
    window.addEventListener('error', onError);
    try {
      const target = handle(kind);
      pointer(target, 'pointerdown');
      pointer(target, 'pointermove', { x: 20 });
      pointer(target, 'pointerup');
      expect(errors).toEqual([]);
      expect(value(kind)).toBeCloseTo(kind === 'stop' ? 0.2 : 0.4);
    } finally { window.removeEventListener('error', onError); }
  });
}

it('removes a stop on an ordinary off-bar release and retains the two-stop minimum', () => {
  const target = handle('stop');
  pointer(target, 'pointerdown');
  pointer(owner(target), 'pointermove', { y: 60 });
  pointer(owner(target), 'pointerup', { y: 60 });
  expect(paint.stops.map((s) => s.color)).toEqual(['#00ff00', '#0000ff']);
  const next = handle('stop');
  pointer(next, 'pointerdown');
  pointer(owner(next), 'pointermove', { y: 60 });
  pointer(owner(next), 'pointerup', { y: 60 });
  expect(paint.stops).toHaveLength(2);
});

it('keeps capture attached while Alt-drag adds and moves a duplicate', () => {
  const target = handle('stop');
  pointer(target, 'pointerdown', { altKey: true });
  pointer(owner(target), 'pointermove', { x: 20 });
  expect(paint.stops).toHaveLength(4);
  expect(capture?.el.isConnected).toBe(true);
  pointer(owner(slider.el), 'pointermove', { x: 80 });
  pointer(owner(slider.el), 'pointerup', { x: 80 });
  expect(paint.stops.filter((s) => s.color === '#ff0000').map((s) => s.offset)).toEqual([0, 0.8]);
  expect(slider.selected).toBe(2);
});

it('preserves keyboard movement, deletion and color editing', () => {
  const edit = vi.fn();
  const keyboardSlider = createGradientSlider({ onChange: change, onEditStop: edit });
  document.body.append(keyboardSlider.el);
  keyboardSlider.set(initial());
  let target = keyboardSlider.el.querySelector('.gs-stop');
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
  expect(value('stop')).toBeCloseTo(0.1);
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(edit).toHaveBeenCalledWith(0, target);
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  expect(paint.stops).toHaveLength(2);
});

it.each([false, true])('coalesces real panel edits with Alt duplication %s and independent Undo after cancellation', async (duplicate) => {
  vi.useFakeTimers();
  const listeners = vi.spyOn(window, 'addEventListener');
  const docListeners = vi.spyOn(document, 'addEventListener');
  const app = await bootAppWithFeatures();
  try {
    paintState.stop = 0;
    const editor = app.newDocument();
    const node = createPath(rectangle(0, 0, 40, 40), true, { fill: initial() });
    editor.doc.transact('Rectangle', () => editor.doc.insert(node, editor.targetLayer().id));
    editor.select([node.id]);
    app.openPanel('gradient');
    const panel = app.dock.panels.get('gradient');
    panel.update();
    slider = panel.slider;
    slider.el.querySelector('.gs-bar').getBoundingClientRect = () => ({ left: 0, width: 100 });
    const target = handle('stop');
    pointer(target, 'pointerdown', { altKey: duplicate });
    pointer(owner(target), 'pointermove', { x: 10 });
    pointer(owner(target), 'pointermove', { x: 20 });
    pointer(owner(target), 'pointercancel');
    const stoppedPaint = structuredClone(editor.doc.get(node.id).fill);
    expect(stoppedPaint.stops.filter((s) => s.color === '#ff0000').map((s) => s.offset)).toEqual(duplicate ? [0, 0.2] : [0.2]);
    const mid = handle('midpoint');
    pointer(mid, 'pointerdown', { id: 2 });
    pointer(owner(mid), 'pointermove', { id: 2, x: duplicate ? 4 : 26 });
    pointer(owner(mid), 'pointerup', { id: 2 });
    expect(editor.doc.get(node.id).fill.stops[0].midpoint).toBeCloseTo(0.2);
    editor.doc.undo();
    expect(editor.doc.get(node.id).fill).toEqual(stoppedPaint);
    editor.doc.undo();
    expect(editor.doc.get(node.id).fill).toEqual(initial());
  } finally {
    app.root.remove();
    for (const args of listeners.mock.calls) window.removeEventListener(...args);
    for (const args of docListeners.mock.calls) document.removeEventListener(...args);
    paintState.stop = 0;
    paintState.lastGradient = null;
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});


it.each(['pointercancel', 'lostpointercapture'])('does not apply an unplaced duplicate after %s', (ending) => {
  const target = handle('stop');
  pointer(target, 'pointerdown', { altKey: true });
  pointer(owner(target), ending);
  expect(paint).toEqual(initial());
  expect(change).not.toHaveBeenCalled();
  expect(slider.selected).toBeLessThan(3);
});

it('keeps dragging the same color through stop reordering and clamps its position', () => {
  const target = handle('stop');
  pointer(target, 'pointerdown');
  pointer(owner(target), 'pointermove', { x: 75 });
  expect(paint.stops.map((s) => s.color)).toEqual(['#00ff00', '#ff0000', '#0000ff']);
  expect(slider.selected).toBe(1);
  pointer(owner(target), 'pointermove', { x: 120 });
  expect(value('stop')).toBe(1);
  pointer(owner(target), 'pointermove', { x: -20 });
  expect(value('stop')).toBe(0);
  expect(slider.selected).toBe(0);
  pointer(owner(target), 'pointerup');
});

it('cleans up even when releasing capture throws', () => {
  Element.prototype.releasePointerCapture.mockImplementation(() => { throw new DOMException('Already released', 'NotFoundError'); });
  const errors = [];
  const onError = (event) => { errors.push(event.error); event.preventDefault(); };
  window.addEventListener('error', onError);
  try {
    const target = handle('stop');
    pointer(target, 'pointerdown');
    pointer(owner(target), 'pointermove', { x: 20 });
    pointer(owner(target), 'pointerup');
    pointer(target, 'pointermove', { x: 40 });
    expect(errors).toEqual([]);
    expect(value('stop')).toBeCloseTo(0.2);
    pointer(target, 'pointerdown', { id: 2 });
    pointer(owner(target), 'pointermove', { id: 2, x: 30 });
    pointer(owner(target), 'pointerup', { id: 2 });
    expect(value('stop')).toBeCloseTo(0.3);
  } finally { window.removeEventListener('error', onError); }
});
