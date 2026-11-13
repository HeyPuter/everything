import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGradientSlider } from '../src/features/paint/gradient-slider.js';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { paintState } from '../src/features/paint/ui-common.js';

const gradient = () => ({ type: 'linear', angle: 25, stops: [
  { offset: 0, color: '#ff0000', opacity: 0.4, midpoint: 0.3 },
  { offset: 0.5, color: '#00ff00', opacity: 0.7, midpoint: 0.8 },
  { offset: 1, color: '#0000ff', opacity: 1 },
] });
let app, editor, node, panel, listeners, documentListeners;
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  documentListeners = vi.spyOn(document, 'addEventListener');
  app = await bootAppWithFeatures();
  paintState.stop = 0;
  paintState.lastGradient = null;
  editor = app.newDocument();
  node = createPath(rectangle(0, 0, 40, 40), true, { fill: gradient() });
  editor.doc.transact('Rectangle', () => editor.doc.insert(node, editor.targetLayer().id));
  editor.select([node.id]);
  app.openPanel('gradient');
  panel = app.dock.panels.get('gradient');
  panel.update();
  panel.slider.el.setPointerCapture = vi.fn();
  panel.slider.el.releasePointerCapture = vi.fn();
  panel.slider.el.querySelector('.gs-bar').getBoundingClientRect = () => ({ left: 0, width: 100 });
});
afterEach(() => {
  app.root.remove();
  for (const args of listeners.mock.calls) window.removeEventListener(...args);
  for (const args of documentListeners.mock.calls) document.removeEventListener(...args);
  paintState.stop = 0;
  paintState.lastGradient = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function pointer(target, type, { altKey = false, x = 0 } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 10, altKey });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
}
const fill = () => structuredClone(editor.doc.get(node.id).fill);
function duplicate(index, { move = false } = {}) {
  const el = panel.slider.el;
  pointer(el.querySelectorAll('.gs-stop')[index], 'pointerdown', { altKey: true, x: index * 50 });
  if (move) pointer(el, 'pointermove', { x: index * 50 });
  pointer(el, 'pointerup', { x: index * 50 });
}

it.each([0, 1, 2])('keeps Alt-click duplicate %s sorted and selected without movement', (index) => {
  const source = gradient().stops[index];
  duplicate(index);
  const paint = fill();
  const expected = gradient().stops;
  expected.splice(index + 1, 0, structuredClone(source));
  expect(paint).toEqual({ ...gradient(), stops: expected });
  expect(panel.slider.selected).toBe(index + 1);
  expect(paintState.stop).toBe(index + 1);
  expect(panel.location.input.value).toBe(`${source.offset * 100}%`);
  expect(panel.opacity.input.value).toBe(`${source.opacity * 100}%`);
  const stops = [...panel.slider.el.querySelectorAll('.gs-stop')];
  expect(stops.map((stop) => Number(stop.getAttribute('aria-valuenow')))).toEqual(expected.map((s) => s.offset * 100));
  expect(stops[index + 1].classList.contains('selected')).toBe(true);
  // Every nonzero adjacent interval still has a visible midpoint control.
  expect([...panel.slider.el.querySelectorAll('.gs-mid')].map((mid) => mid.hidden)).toEqual(expected.slice(1).map((s, i) => s.offset === expected[i].offset));
  editor.doc.undo();
  expect(fill()).toEqual(gradient());
  editor.doc.redo();
  expect(fill()).toEqual(paint);
});

it.each([0, 1, 2])('moves only Alt-click duplicate %s in the subsequent keyboard edit', (index) => {
  duplicate(index);
  const duplicated = fill();
  const selected = panel.slider.el.querySelectorAll('.gs-stop')[panel.slider.selected];
  selected.focus();
  selected.dispatchEvent(new KeyboardEvent('keydown', { key: index === 2 ? 'ArrowLeft' : 'ArrowRight', bubbles: true, cancelable: true }));
  const copies = fill().stops.filter((s) => s.color === gradient().stops[index].color);
  const offsets = [index * 0.5, index * 0.5 + (index === 2 ? -0.01 : 0.01)].sort((a, b) => a - b);
  expect(copies.map((s) => s.offset)).toEqual(offsets);
  expect(fill().stops.map((s) => s.offset)).toEqual([...fill().stops.map((s) => s.offset)].sort((a, b) => a - b));
  editor.doc.undo();
  expect(fill()).toEqual(duplicated);
  editor.doc.undo();
  expect(fill()).toEqual(gradient());
});

it('preserves sorted duplicate placement when a same-position pointermove precedes release', () => {
  duplicate(0, { move: true });
  expect(fill().stops.map((s) => s.offset)).toEqual([0, 0, 0.5, 1]);
  expect(panel.slider.selected).toBe(1);
});

it('keeps the duplicate selected in a standalone slider without model feedback', () => {
  let paint = gradient();
  const slider = createGradientSlider({ onChange: (next) => { paint = next; } });
  document.body.append(slider.el);
  slider.set(paint);
  pointer(slider.el.querySelector('.gs-stop'), 'pointerdown', { altKey: true });
  pointer(slider.el, 'pointerup');
  expect(paint.stops.map((s) => s.offset)).toEqual([0, 0, 0.5, 1]);
  expect(slider.selected).toBe(1);
});
