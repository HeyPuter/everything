import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';

let app, editor, node, listeners, documentListeners;
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  documentListeners = vi.spyOn(document, 'addEventListener');
  app = await bootAppWithFeatures();
  editor = app.newDocument();
  node = createText('Precise type', 10, 40);
  node.char.fontSize = 12.345678;
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
  const panel = app.dock.panels.get(panelId);
  panel.update();
  const input = panel.el.querySelector(`input[aria-label="${label}"]`);
  expect(input).not.toBeNull();
  input.focus();
  return input;
}
function key(input, key, shiftKey = false) {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
}
function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function set(section, prop, value) {
  editor.doc.transact('Precise value', () => editor.doc.update(node.id, { [section]: { ...editor.doc.get(node.id)[section], [prop]: value } }));
}

it.each([
  ['character', 'Font size', 'char', 'fontSize'],
  ['character', 'Leading', 'char', 'leading'],
  ['character', 'Tracking', 'char', 'tracking'],
  ['character', 'Horizontal scale', 'char', 'horizontalScale'],
  ['character', 'Vertical scale', 'char', 'verticalScale'],
  ['character', 'Baseline shift', 'char', 'baselineShift'],
  ['character', 'Character rotation', 'char', 'rotation'],
  ['paragraph', 'Left indent', 'para', 'indentLeft'],
  ['paragraph', 'Space before paragraph', 'para', 'spaceBefore'],
])('does not round %s %s when Enter confirms an untouched display', (panelId, label, section, prop) => {
  set(section, prop, 12.345678);
  const input = field(label, panelId);
  const revision = editor.doc.revision;
  key(input, 'Enter');
  expect(editor.doc.get(node.id)[section][prop]).toBe(12.345678);
  expect(editor.doc.revision).toBe(revision);
});

it('preserves automatic leading when its computed display is confirmed', () => {
  const input = field('Leading');
  expect(input.value).toMatch(/^\(/);
  const revision = editor.doc.revision;
  key(input, 'Enter');
  expect(editor.doc.get(node.id).char.leading).toBe(null);
  expect(editor.doc.revision).toBe(revision);
});

it('does not replace mixed explicit leading with Auto when Enter confirms the empty display', () => {
  set('char', 'leading', 16);
  const other = createText('Other type', 10, 80);
  other.char.leading = 24;
  editor.doc.transact('Other text', () => editor.doc.insert(other, editor.targetLayer().id));
  editor.select([node.id, other.id]);
  const input = field('Leading');
  expect(input.placeholder).toBe('Mixed');
  const revision = editor.doc.revision;
  key(input, 'Enter');
  expect(editor.doc.get(node.id).char.leading).toBe(16);
  expect(editor.doc.get(other.id).char.leading).toBe(24);
  expect(editor.doc.revision).toBe(revision);
});

it('steps from the precise font size repeatedly and does not round on later Enter', () => {
  const input = field('Font size');
  key(input, 'ArrowUp');
  key(input, 'ArrowUp');
  expect(editor.doc.get(node.id).char.fontSize).toBeCloseTo(14.345678, 8);
  const revision = editor.doc.revision;
  key(input, 'Enter');
  expect(editor.doc.get(node.id).char.fontSize).toBeCloseTo(14.345678, 8);
  expect(editor.doc.revision).toBe(revision);
});

it('steps from the unrounded computed leading when Auto is displayed', () => {
  const input = field('Leading');
  key(input, 'ArrowUp');
  expect(editor.doc.get(node.id).char.leading).toBeCloseTo(12.345678 * 1.2 + 1, 8);
});

it('keeps converted type units precise when an untouched size is confirmed', () => {
  app.prefs.set('typeUnits', 'in');
  const input = field('Font size');
  key(input, 'Enter');
  expect(editor.doc.get(node.id).char.fontSize).toBe(12.345678);
});

it('preserves the underlying size when a font-height display is confirmed', () => {
  app.prefs.set('showFontHeightOptions', true);
  app.prefs.set('fontSizeReference', 'cap');
  const input = field('Font size');
  key(input, 'Enter');
  expect(editor.doc.get(node.id).char.fontSize).toBe(12.345678);
});

it('honors explicitly retyping the rounded display and supports Undo', () => {
  const input = field('Font size');
  type(input, input.value);
  key(input, 'Enter');
  expect(editor.doc.get(node.id).char.fontSize).toBe(12.346);
  editor.doc.undo();
  expect(editor.doc.get(node.id).char.fontSize).toBe(12.345678);
});

it('accepts a precise draft and preserves it on a second confirmation', () => {
  const input = field('Font size');
  type(input, '24.123456');
  key(input, 'Enter');
  const revision = editor.doc.revision;
  key(input, 'Enter');
  expect(editor.doc.get(node.id).char.fontSize).toBe(24.123456);
  expect(editor.doc.revision).toBe(revision);
});

it('still steps a typed draft and clamps to the field limit', () => {
  const input = field('Font size');
  type(input, '20.123456');
  key(input, 'ArrowUp', true);
  expect(editor.doc.get(node.id).char.fontSize).toBeCloseTo(30.123456, 8);
  type(input, '1296');
  key(input, 'ArrowUp');
  expect(editor.doc.get(node.id).char.fontSize).toBe(1296);
});

it('still accepts native change events and named Auto values', () => {
  const input = field('Leading');
  type(input, '20.123456');
  input.dispatchEvent(new Event('change', { bubbles: true }));
  expect(editor.doc.get(node.id).char.leading).toBe(20.123456);
  type(input, 'Auto');
  input.dispatchEvent(new Event('change', { bubbles: true }));
  expect(editor.doc.get(node.id).char.leading).toBe(null);
});

it('steps mixed sizes individually instead of collapsing them to one value', () => {
  const other = createText('Other type', 10, 80);
  other.char.fontSize = 20.123456;
  editor.doc.transact('Other text', () => editor.doc.insert(other, editor.targetLayer().id));
  editor.select([node.id, other.id]);
  const input = field('Font size');
  key(input, 'ArrowUp');
  expect(editor.doc.get(node.id).char.fontSize).toBeCloseTo(13.345678, 8);
  expect(editor.doc.get(other.id).char.fontSize).toBeCloseTo(21.123456, 8);
});
