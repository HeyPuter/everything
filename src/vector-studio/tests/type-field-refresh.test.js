import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';

let app, editor, node, panel, listeners, documentListeners;
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  documentListeners = vi.spyOn(document, 'addEventListener');
  app = await bootAppWithFeatures();
  editor = app.newDocument();
  node = createText('Current type', 10, 40);
  node.char.fontSize = 12;
  editor.doc.transact('Text', () => editor.doc.insert(node, editor.targetLayer().id));
  editor.select([node.id]);
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
function field(label, panelId = 'character') {
  app.openPanel(panelId);
  panel = app.dock.panels.get(panelId);
  panel.update();
  const input = panel.el.querySelector(`input[aria-label="${label}"]`);
  input.focus();
  return input;
}
function update(section, prop, value) {
  editor.doc.transact('Updated type', () => editor.doc.update(node.id, { [section]: { ...editor.doc.get(node.id)[section], [prop]: value } }));
  panel.update();
}
function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function enter(input) {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

it.each([
  ['character', 'Font size', 'char', 'fontSize', '24 pt'],
  ['character', 'Tracking', 'char', 'tracking', '24'],
  ['character', 'Horizontal scale', 'char', 'horizontalScale', '24%'],
  ['character', 'Character rotation', 'char', 'rotation', '24°'],
  ['paragraph', 'Left indent', 'para', 'indentLeft', '24 pt'],
])('refreshes the untouched focused %s %s field', (panelId, label, section, prop, text) => {
  const input = field(label, panelId);
  update(section, prop, 24);
  expect(input.value).toBe(text);
  expect(document.activeElement).toBe(input);
  const revision = editor.doc.revision;
  enter(input);
  expect(editor.doc.revision).toBe(revision);
});

it.each([[0, 5, 'forward', 0, 6], [1, 3, 'backward', 1, 3], [2, 2, 'none', 2, 2]])('preserves text selection %s–%s during a type value refresh', (start, end, direction, nextStart, nextEnd) => {
  const input = field('Font size');
  input.setSelectionRange(start, end, direction);
  update('char', 'fontSize', 120);
  expect(input.value).toBe('120 pt');
  expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([nextStart, nextEnd, direction]);
});

it('refreshes the computed Auto leading without turning it into an explicit value', () => {
  const input = field('Leading');
  update('char', 'fontSize', 20);
  expect(input.value).toBe('(24 pt)');
  enter(input);
  expect(editor.doc.get(node.id).char.leading).toBe(null);
});

it('shows Mixed immediately when the selected font sizes become different', () => {
  const input = field('Font size');
  const other = createText('Other type', 10, 80);
  other.char.fontSize = 24;
  editor.doc.transact('Other text', () => editor.doc.insert(other, editor.targetLayer().id));
  editor.select([node.id, other.id]);
  panel.update();
  expect(input.value).toBe('');
  expect(input.placeholder).toBe('Mixed');
  enter(input);
  expect(editor.doc.get(node.id).char.fontSize).toBe(12);
  expect(editor.doc.get(other.id).char.fontSize).toBe(24);
});

it('refreshes an untouched field when Type units change', () => {
  const input = field('Font size');
  app.prefs.set('typeUnits', 'in');
  panel.update();
  expect(input.value).toBe('0.167 in');
  enter(input);
  expect(editor.doc.get(node.id).char.fontSize).toBe(12);
});

it('preserves a real draft while the model changes and gives it an independent Undo step', () => {
  const input = field('Font size');
  type(input, '36');
  update('char', 'fontSize', 24);
  expect(input.value).toBe('36');
  enter(input);
  expect(editor.doc.get(node.id).char.fontSize).toBe(36);
  editor.doc.undo();
  expect(editor.doc.get(node.id).char.fontSize).toBe(24);
});

it('keeps explicitly retyped text even when it matches the old display', () => {
  const input = field('Font size');
  type(input, input.value);
  update('char', 'fontSize', 24);
  expect(input.value).toBe('12 pt');
  enter(input);
  expect(editor.doc.get(node.id).char.fontSize).toBe(12);
});

it('refreshes a completed edit on a later model update', () => {
  const input = field('Font size');
  type(input, '36');
  enter(input);
  update('char', 'fontSize', 24);
  expect(input.value).toBe('24 pt');
  const revision = editor.doc.revision;
  enter(input);
  expect(editor.doc.revision).toBe(revision);
});
