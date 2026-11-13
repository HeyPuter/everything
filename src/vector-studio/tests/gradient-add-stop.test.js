import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { paintState } from '../src/features/paint/ui-common.js';

const gradient = () => ({ type: 'linear', angle: 20, stops: [
  { offset: 0, color: '#ff0000', opacity: 1 },
  { offset: 0.5, color: '#00ff00', opacity: 1 },
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
const fill = () => structuredClone(editor.doc.get(node.id).fill);
function add() {
  // A native button supplies Enter/Space activation. jsdom does not synthesize
  // the browser's click default action from a KeyboardEvent, so invoke it here.
  const button = panel.el.querySelector('button[aria-label="Add Stop"]');
  expect(button, 'A keyboard-reachable Add Stop action').not.toBeNull();
  expect(button.tabIndex).toBe(0);
  expect(button.disabled).toBe(false);
  button.focus();
  expect(document.activeElement).toBe(button);
  button.click();
}
function pointer(target, type, x = 10) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 10 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
}

it.each([0, 1, 2])('adds a sampled stop beside selected stop %s through an accessible action', (index) => {
  const selected = panel.slider.el.querySelectorAll('.gs-stop')[index];
  selected.focus();
  const offset = index === 0 ? 0.25 : 0.75;
  const color = index === 0 ? '#808000' : '#008080';
  add();
  const paint = fill();
  expect(paint.stops).toHaveLength(4);
  const inserted = paint.stops[panel.slider.selected];
  expect(inserted).toEqual({ offset, color, opacity: 1 });
  expect(paint.stops.filter((s) => s !== inserted)).toEqual(gradient().stops);
  expect(paint.angle).toBe(20);
  const control = panel.slider.el.querySelectorAll('.gs-stop')[panel.slider.selected];
  expect(document.activeElement).toBe(control);
  expect(paintState.stop).toBe(panel.slider.selected);
  expect(panel.location.input.value).toBe(`${offset * 100}%`);
  control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  expect(fill().stops.find((s) => s.color === color).offset).toBeCloseTo(offset + 0.01);
  editor.doc.undo();
  expect(fill()).toEqual(paint);
  editor.doc.undo();
  expect(fill()).toEqual(gradient());
  editor.doc.redo();
  expect(fill()).toEqual(paint);
});

it('adds to stroke while preserving the fill', () => {
  editor.doc.transact('Stroke', () => editor.doc.update(node.id, { stroke: gradient() }));
  editor.focusPaint = 'stroke';
  editor.emit('style');
  panel.update();
  add();
  expect(editor.doc.get(node.id).stroke.stops).toHaveLength(4);
  expect(fill()).toEqual(gradient());
});

it('adds to drawing defaults without changing existing artwork', () => {
  editor.select([]);
  editor.setStyle({ fill: gradient() });
  panel.update();
  add();
  expect(editor.style.fill.stops).toHaveLength(4);
  expect(editor.style.fill.stops[1].offset).toBe(0.25);
  expect(fill()).toEqual(gradient());
});

it('applies the preview gradient when adding to a solid fill', () => {
  editor.doc.transact('Solid', () => editor.doc.update(node.id, { fill: { type: 'solid', color: '#123456' } }));
  panel.update();
  const preview = structuredClone(panel.paint);
  add();
  expect(fill().type).toBe('linear');
  expect(fill().stops).toHaveLength(preview.stops.length + 1);
  editor.doc.undo();
  expect(fill()).toEqual({ type: 'solid', color: '#123456' });
});

it('samples opacity and nonlinear blend color without altering the existing stops', () => {
  const paint = { type: 'linear', stops: [
    { offset: 0, color: '#ff0000', opacity: 0.2, midpoint: 0.25 },
    { offset: 1, color: '#0000ff', opacity: 0.8 },
  ] };
  editor.doc.transact('Gradient', () => editor.doc.update(node.id, { fill: paint }));
  panel.update();
  add();
  const result = fill().stops;
  expect(result[0]).toEqual(paint.stops[0]);
  expect(result[2]).toEqual(paint.stops[1]);
  expect(result[1].offset).toBe(0.5);
  expect(result[1].opacity).toBeGreaterThan(0.5);
  expect(result[1].color).not.toBe('#800080');
});

it.each(['stop', 'midpoint'])('ends a held %s drag before adding a stop and keeps Undo separate', (kind) => {
  const slider = panel.slider.el;
  pointer(slider.querySelector(kind === 'stop' ? '.gs-stop' : '.gs-mid'), 'pointerdown');
  pointer(slider, 'pointermove');
  const dragged = fill();
  add();
  const added = fill();
  expect(added.stops).toHaveLength(4);
  pointer(slider, 'pointermove', 40);
  pointer(slider, 'pointerup', 40);
  expect(fill()).toEqual(added);
  editor.doc.undo();
  expect(fill()).toEqual(dragged);
  editor.doc.undo();
  expect(fill()).toEqual(gradient());
});

it('keeps repeated additions sorted and selects each new stop', () => {
  for (let i = 0; i < 4; i++) {
    add();
    const offsets = fill().stops.map((s) => s.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(document.activeElement).toBe(panel.slider.el.querySelectorAll('.gs-stop')[panel.slider.selected]);
  }
  expect(fill().stops).toHaveLength(7);
  for (let i = 0; i < 4; i++) editor.doc.undo();
  expect(fill()).toEqual(gradient());
});

it('keeps the existing pointer insertion behavior', () => {
  pointer(panel.slider.el.querySelector('.gs-stops'), 'pointerdown', 25);
  expect(fill().stops[1]).toEqual({ offset: 0.25, color: '#808000', opacity: 1 });
  expect(document.activeElement).toBe(panel.slider.el.querySelectorAll('.gs-stop')[1]);
});
