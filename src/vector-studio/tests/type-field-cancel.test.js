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

function escape(input) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  return event;
}
function nativeChangeOnBlur(input) {
  // Native text edits emit change when focus leaves; jsdom value assignment does not.
  input.addEventListener('blur', () => input.dispatchEvent(new Event('change', { bubbles: true })), { once: true });
}

it.each([
  ['character', 'Font size', 'char', 'fontSize'],
  ['character', 'Tracking', 'char', 'tracking'],
  ['character', 'Horizontal scale', 'char', 'horizontalScale'],
  ['character', 'Character rotation', 'char', 'rotation'],
  ['paragraph', 'Left indent', 'para', 'indentLeft'],
])('discards a pending %s %s edit before native change on blur', (panelId, label, section, prop) => {
  const input = field(label, panelId);
  const original = editor.doc.get(node.id)[section][prop];
  const text = input.value, revision = editor.doc.revision;
  type(input, '36');
  nativeChangeOnBlur(input);
  escape(input);
  expect(editor.doc.get(node.id)[section][prop]).toBe(original);
  expect(editor.doc.revision).toBe(revision);
  expect(input.value).toBe(text);
  expect(document.activeElement).not.toBe(input);
});

it('restores the newest model value when cancelling a draft', () => {
  const input = field('Font size');
  type(input, '36');
  update('char', 'fontSize', 24);
  const revision = editor.doc.revision;
  nativeChangeOnBlur(input);
  escape(input);
  expect(input.value).toBe('24 pt');
  expect(editor.doc.get(node.id).char.fontSize).toBe(24);
  expect(editor.doc.revision).toBe(revision);
});

it('keeps computed automatic leading after cancelling a draft', () => {
  const input = field('Leading');
  const text = input.value, revision = editor.doc.revision;
  expect(text).toMatch(/^\(/);
  type(input, '36');
  nativeChangeOnBlur(input);
  escape(input);
  expect(editor.doc.get(node.id).char.leading).toBe(null);
  expect(editor.doc.revision).toBe(revision);
  expect(input.value).toBe(text);
});

it.each(['Enter', 'blur'])('restores computed leading after invalid input is rejected on %s', (action) => {
  const input = field('Leading');
  const text = input.value, revision = editor.doc.revision;
  type(input, 'invalid');
  if (action === 'Enter') enter(input);
  else { nativeChangeOnBlur(input); input.blur(); }
  expect(input.value).toBe(text);
  expect(editor.doc.get(node.id).char.leading).toBe(null);
  expect(editor.doc.revision).toBe(revision);
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  expect(editor.doc.get(node.id).char.leading).toBeCloseTo(15.4, 8);
});

it('restores a newer precise value after invalid Enter without changing history', () => {
  const input = field('Font size');
  type(input, 'invalid');
  update('char', 'fontSize', 24.123456);
  const revision = editor.doc.revision;
  enter(input);
  expect(input.value).toBe('24.123 pt');
  expect(document.activeElement).toBe(input);
  expect(editor.doc.get(node.id).char.fontSize).toBe(24.123456);
  expect(editor.doc.revision).toBe(revision);
  enter(input);
  expect(editor.doc.revision).toBe(revision);
});

it('keeps mixed leading unchanged when a draft is cancelled', () => {
  const input = field('Leading');
  update('char', 'leading', 16);
  const other = createText('Other type', 10, 80);
  other.char.leading = 24;
  editor.doc.transact('Other text', () => editor.doc.insert(other, editor.targetLayer().id));
  editor.select([node.id, other.id]);
  panel.update();
  const revision = editor.doc.revision;
  type(input, '36');
  nativeChangeOnBlur(input);
  escape(input);
  expect(input.value).toBe('');
  expect(input.placeholder).toBe('Mixed');
  expect(editor.doc.get(node.id).char.leading).toBe(16);
  expect(editor.doc.get(other.id).char.leading).toBe(24);
  expect(editor.doc.revision).toBe(revision);
});

it('allows a new edit after cancellation and preserves an ordinary native change', () => {
  const input = field('Font size');
  type(input, '36');
  nativeChangeOnBlur(input);
  escape(input);
  input.focus();
  type(input, '48');
  nativeChangeOnBlur(input);
  input.blur();
  expect(editor.doc.get(node.id).char.fontSize).toBe(48);
  editor.doc.undo();
  expect(editor.doc.get(node.id).char.fontSize).toBe(12);
});
