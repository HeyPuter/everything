import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app, panel, editor, node, input, listeners, documentListeners;
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  documentListeners = vi.spyOn(document, 'addEventListener');
  app = await bootAppWithFeatures();
  editor = app.newDocument();
  node = createPath(rectangle(0, 0, 40, 40), true, { fill: { type: 'solid', color: '#ff0000' } });
  editor.doc.transact('Rectangle', () => editor.doc.insert(node, editor.targetLayer().id));
  editor.select([node.id]);
  app.openPanel('color');
  panel = app.dock.panels.get('color');
  panel.update();
  input = panel.el.querySelector('[aria-label="Hexadecimal color"]');
  input.focus();
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
function update(color = '#00ff00') {
  editor.doc.transact('Updated color', () => editor.doc.update(node.id, { fill: { type: 'solid', color } }));
  panel.update();
}
function type(value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function enter() { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }

it.each(['blur', 'Enter', 'document switch'])('does not overwrite a newer color when an untouched field finishes via %s', (action) => {
  update();
  const revision = editor.doc.revision;
  if (action === 'blur') input.blur();
  else if (action === 'Enter') enter();
  else app.newDocument();
  expect(editor.doc.get(node.id).fill.color).toBe('#00ff00');
  expect(editor.doc.revision).toBe(revision);
});

it('shows the new model color in an untouched focused field', () => {
  update();
  expect(input.value).toBe('00FF00');
  expect(document.activeElement).toBe(input);
});

it.each([[0, 6, 'forward'], [1, 4, 'backward'], [3, 3, 'none']])('preserves text selection %s–%s when refreshing an untouched field', (start, end, direction) => {
  input.setSelectionRange(start, end, direction);
  update('#123456');
  expect(input.value).toBe('123456');
  expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([start, end, direction]);
});

it('preserves an actual typed draft while the model changes', () => {
  type('0000FF');
  update();
  expect(input.value).toBe('0000FF');
  input.blur();
  expect(editor.doc.get(node.id).fill.color).toBe('#0000ff');
  editor.doc.undo();
  expect(editor.doc.get(node.id).fill.color).toBe('#00ff00');
});

it('honors explicitly retyping the displayed color before a model update', () => {
  type('FF0000');
  update();
  expect(input.value).toBe('FF0000');
  input.blur();
  expect(editor.doc.get(node.id).fill.color).toBe('#ff0000');
});

it('restores the latest model color after an invalid draft', () => {
  type('nothex');
  update();
  input.blur();
  expect(input.value).toBe('00FF00');
  expect(editor.doc.get(node.id).fill.color).toBe('#00ff00');
});

it('treats a committed edit as untouched on subsequent model refreshes', () => {
  type('0000FF');
  enter();
  update();
  const revision = editor.doc.revision;
  input.blur();
  expect(editor.doc.get(node.id).fill.color).toBe('#00ff00');
  expect(editor.doc.revision).toBe(revision);
});
