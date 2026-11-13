import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { addPattern } from '../src/features/patterns/model.js';
import { paintState } from '../src/features/paint/ui-common.js';

let app, editor, panel, input, listeners, documentListeners;
const solid = (color) => ({ type: 'solid', color });
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  documentListeners = vi.spyOn(document, 'addEventListener');
  app = await bootAppWithFeatures();
  editor = app.newDocument();
  paintState.stop = 0;
  app.openPanel('color');
  panel = app.dock.panels.get('color');
  input = panel.hex;
});
afterEach(() => {
  app.root.remove();
  for (const args of listeners.mock.calls) window.removeEventListener(...args);
  for (const args of documentListeners.mock.calls) document.removeEventListener(...args);
  paintState.stop = 0;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function add(key, paint) {
  const node = createPath(rectangle(0, 0, 40, 40), true, { [key]: paint });
  editor.doc.transact('Rectangle', () => editor.doc.insert(node, editor.targetLayer().id));
  return node.id;
}
function show(key, ids) {
  editor.focusPaint = key;
  editor.select(ids);
  panel.update();
  input.focus();
}
function typeAndEnter(value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

it.each(['fill', 'stroke'])('applies the explicitly typed fallback to an absent %s and supports Undo', (key) => {
  const id = add(key, null);
  show(key, [id]);
  const color = key === 'fill' ? '#ffffff' : '#000000';
  expect(input.value).toBe(color.slice(1).toUpperCase());
  typeAndEnter(input.value);
  expect(editor.doc.get(id)[key]).toEqual(solid(color));
  editor.doc.undo();
  expect(editor.doc.get(id)[key]).toBe(null);
});

it.each(['fill', 'stroke'])('applies the fallback color to every object in a mixed %s selection', (key) => {
  const a = add(key, solid('#ff0000'));
  const b = add(key, null);
  show(key, [a, b]);
  expect(input.placeholder).toBe('Mixed');
  expect(input.value).toBe('');
  const color = key === 'fill' ? '#ffffff' : '#000000';
  typeAndEnter(color.slice(1));
  expect(editor.doc.get(a)[key]).toEqual(solid(color));
  expect(editor.doc.get(b)[key]).toEqual(solid(color));
  panel.update();
  expect(input.value).toBe(color.slice(1).toUpperCase());
  expect(input.placeholder).toBe('');
  editor.doc.undo();
  expect(editor.doc.get(a)[key]).toEqual(solid('#ff0000'));
  expect(editor.doc.get(b)[key]).toBe(null);
});

it('applies a remembered fallback color when it is explicitly retyped', () => {
  editor.lastSolid = { fill: '#123456' };
  const id = add('fill', null);
  show('fill', [id]);
  typeAndEnter(input.value);
  expect(editor.doc.get(id).fill).toEqual(solid('#123456'));
});

it('applies the fallback to the drawing style when no artwork is selected', () => {
  editor.setStyle({ fill: null });
  show('fill', []);
  const revision = editor.doc.revision;
  typeAndEnter('FFFFFF');
  expect(editor.style.fill).toEqual(solid('#ffffff'));
  expect(editor.doc.revision).toBe(revision);
});

it.each(['none', 'mixed'])('does not apply a fallback merely by focusing and leaving a %s field', (state) => {
  const a = add('fill', null);
  const ids = state === 'mixed' ? [a, add('fill', solid('#ff0000'))] : [a];
  show('fill', ids);
  const revision = editor.doc.revision;
  input.blur();
  expect(editor.doc.get(a).fill).toBe(null);
  expect(editor.doc.revision).toBe(revision);
});

it.each([
  ['solid', { type: 'solid', color: '#123456', swatchId: 'brand', tint: 0.5 }],
  ['linear', { type: 'linear', angle: 30, stops: [{ offset: 0, color: '#123456', swatchId: 'brand' }, { offset: 1, color: '#000000' }] }],
  ['freeform', { type: 'freeform', points: [{ x: 0, y: 0, color: '#123456' }, { x: 1, y: 1, color: '#000000' }], swatchId: 'brand' }],
])('preserves an unchanged %s paint and its swatch links when the actual color is retyped', (_, paint) => {
  const id = add('fill', paint);
  show('fill', [id]);
  const revision = editor.doc.revision;
  typeAndEnter('123456');
  input.blur();
  expect(editor.doc.get(id).fill).toEqual(paint);
  expect(editor.doc.revision).toBe(revision);
});

it('replaces a pattern with the explicitly typed fallback and restores it with Undo', () => {
  const tile = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#ff0000') });
  editor.doc.transact('Pattern', () => addPattern(editor.doc, { id: 'red-tile', width: 10, height: 10, art: { roots: [tile.id], nodes: [tile] } }));
  const paint = { type: 'pattern', id: 'red-tile' };
  const id = add('fill', paint);
  show('fill', [id]);
  typeAndEnter('FFFFFF');
  expect(editor.doc.get(id).fill).toEqual(solid('#ffffff'));
  editor.doc.undo();
  expect(editor.doc.get(id).fill).toEqual(paint);
});
