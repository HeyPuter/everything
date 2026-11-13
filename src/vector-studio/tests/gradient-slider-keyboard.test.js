import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGradientSlider } from '../src/features/paint/gradient-slider.js';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { paintState } from '../src/features/paint/ui-common.js';

const initial = () => ({ type: 'linear', angle: 0, stops: [
  { offset: 0.1, color: '#ff0000', midpoint: 0.35 },
  { offset: 0.5, color: '#00ff00', midpoint: 0.6 },
  { offset: 0.9, color: '#0000ff' },
] });
let paint, slider, change, start;
beforeEach(() => {
  paint = initial();
  change = vi.fn((next) => { paint = next; });
  start = vi.fn();
  slider = createGradientSlider({ onChange: change, onGestureStart: start });
  document.body.append(slider.el);
  slider.set(paint);
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
function key(target, name, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

it('includes every stop in sequential keyboard focus and keeps selection in sync', () => {
  const stops = [...slider.el.querySelectorAll('.gs-stop')];
  expect(stops.map((stop) => stop.tabIndex)).toEqual([0, 0, 0]);
  stops.forEach((stop, index) => {
    stop.focus();
    expect(document.activeElement).toBe(stop);
    expect(slider.selected).toBe(index);
    expect(stop.getAttribute('aria-label')).toBe(`Stop ${index + 1}`);
  });
});

it('exposes focusable midpoint sliders with their interval, value and limits', () => {
  const mids = [...slider.el.querySelectorAll('.gs-mid')];
  expect(mids).toHaveLength(2);
  mids.forEach((mid, index) => {
    expect(mid.getAttribute('role')).toBe('slider');
    expect(mid.tabIndex).toBe(0);
    expect(mid.getAttribute('aria-label')).toBe(`Midpoint between stops ${index + 1} and ${index + 2}`);
    expect(mid.getAttribute('aria-valuemin')).toBe('5');
    expect(mid.getAttribute('aria-valuemax')).toBe('95');
    expect(Number(mid.getAttribute('aria-valuenow'))).toBe(initial().stops[index].midpoint * 100);
    mid.focus();
    expect(document.activeElement).toBe(mid);
  });
});

it.each([
  ['ArrowLeft', 0.49], ['ArrowDown', 0.49], ['ArrowRight', 0.51], ['ArrowUp', 0.51], ['Home', 0], ['End', 1],
])('moves a focused stop using %s and retains its color and focus', (name, expected) => {
  const stop = slider.el.querySelectorAll('.gs-stop')[1];
  stop.focus();
  expect(key(stop, name).defaultPrevented).toBe(true);
  expect(paint.stops.find((s) => s.color === '#00ff00').offset).toBeCloseTo(expected);
  const current = slider.el.querySelectorAll('.gs-stop')[slider.selected];
  expect(document.activeElement).toBe(current);
  expect(current.getAttribute('aria-valuenow')).toBe(String(expected * 100));
  expect(start).toHaveBeenCalledOnce();
});

it.each([
  ['ArrowLeft', false, 0.34], ['ArrowDown', false, 0.34], ['ArrowRight', false, 0.36], ['ArrowUp', false, 0.36],
  ['ArrowLeft', true, 0.25], ['ArrowUp', true, 0.45], ['Home', false, 0.05], ['End', false, 0.95],
])('edits a midpoint with %s (Shift %s)', (name, shift, expected) => {
  const mid = slider.el.querySelector('.gs-mid');
  mid.focus();
  expect(key(mid, name, shift).defaultPrevented).toBe(true);
  expect(paint.stops[0].midpoint).toBeCloseTo(expected);
  expect(paint.stops.map((s) => s.offset)).toEqual([0.1, 0.5, 0.9]);
  expect(document.activeElement).toBe(mid);
  expect(Number(mid.getAttribute('aria-valuenow'))).toBeCloseTo(expected * 100);
  expect(change).toHaveBeenCalledWith(paint, { live: false });
  expect(start).toHaveBeenCalledOnce();
});

it('clamps midpoint stepping and refreshes its accessible value after model changes', () => {
  const mid = slider.el.querySelector('.gs-mid');
  key(mid, 'End');
  key(mid, 'ArrowRight', true);
  expect(paint.stops[0].midpoint).toBe(0.95);
  key(mid, 'Home');
  key(mid, 'ArrowLeft', true);
  expect(paint.stops[0].midpoint).toBe(0.05);
  slider.set({ ...initial(), stops: [{ ...initial().stops[0], midpoint: 0.7 }, ...initial().stops.slice(1)] });
  expect(mid.getAttribute('aria-valuenow')).toBe('70');
});

it('keeps zero-width midpoint intervals hidden and gives a new interval a control', () => {
  slider.set({ ...initial(), stops: [{ ...initial().stops[0], offset: 0.5 }, ...initial().stops.slice(1)] });
  const mid = slider.el.querySelector('.gs-mid');
  expect(mid.hidden).toBe(true);
  slider.set(initial());
  expect(mid.hidden).toBe(false);
  expect(mid.tabIndex).toBe(0);
  key(mid, 'ArrowUp');
  expect(paint.stops[0].midpoint).toBeCloseTo(0.36);
});

it('leaves unrelated keys available to their normal handlers', () => {
  const mid = slider.el.querySelector('.gs-mid');
  expect(key(mid, 'Tab').defaultPrevented).toBe(false);
  expect(key(mid, 'Shift').defaultPrevented).toBe(false);
  expect(change).not.toHaveBeenCalled();
});

it('edits actual artwork through each stop and midpoint, with independent Undo', async () => {
  vi.useFakeTimers();
  const listeners = vi.spyOn(window, 'addEventListener');
  const documentListeners = vi.spyOn(document, 'addEventListener');
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
    const el = panel.slider.el;
    const stop = el.querySelectorAll('.gs-stop')[1];
    expect(stop.tabIndex).toBe(0);
    stop.focus();
    key(stop, 'ArrowUp');
    expect(editor.doc.get(node.id).fill.stops[1].offset).toBeCloseTo(0.51);
    vi.advanceTimersByTime(20); // Dock fields refresh on the next animation frame.
    expect(panel.location.input.value).toBe('51%');
    const mid = el.querySelectorAll('.gs-mid')[1];
    mid.focus();
    key(mid, 'Home');
    expect(editor.doc.get(node.id).fill.stops[1].midpoint).toBe(0.05);
    editor.doc.undo();
    expect(editor.doc.get(node.id).fill.stops[1].midpoint).toBe(0.6);
    expect(editor.doc.get(node.id).fill.stops[1].offset).toBeCloseTo(0.51);
    editor.doc.undo();
    expect(editor.doc.get(node.id).fill).toEqual(initial());
  } finally {
    app.root.remove();
    for (const args of listeners.mock.calls) window.removeEventListener(...args);
    for (const args of documentListeners.mock.calls) document.removeEventListener(...args);
    paintState.stop = 0;
    paintState.lastGradient = null;
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});


it('ends a held stop drag before a midpoint keyboard edit', () => {
  const pointer = (target, type, x) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 10 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    target.dispatchEvent(event);
  };
  slider.el.querySelector('.gs-bar').getBoundingClientRect = () => ({ left: 0, width: 100 });
  pointer(slider.el.querySelector('.gs-stop'), 'pointerdown', 10);
  pointer(slider.el, 'pointermove', 20);
  const mid = slider.el.querySelector('.gs-mid');
  mid.focus();
  key(mid, 'Home');
  pointer(slider.el, 'pointermove', 40);
  pointer(slider.el, 'pointerup', 40);
  expect(paint.stops[0].offset).toBe(0.2);
  expect(paint.stops[0].midpoint).toBe(0.05);
});

it('updates the accessible midpoint value during a pointer drag', () => {
  slider.el.querySelector('.gs-bar').getBoundingClientRect = () => ({ left: 0, width: 100 });
  const mid = slider.el.querySelector('.gs-mid');
  for (const [target, type] of [[mid, 'pointerdown'], [slider.el, 'pointermove'], [slider.el, 'pointerup']]) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 10 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    target.dispatchEvent(event);
  }
  expect(paint.stops[0].midpoint).toBeCloseTo(0.25);
  expect(mid.getAttribute('aria-valuenow')).toBe('25');
  expect(mid.getAttribute('aria-valuetext')).toBe('25%');
});
