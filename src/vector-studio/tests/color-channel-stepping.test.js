import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { colorSliders } from '../src/features/paint/ui-common.js';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

function setup(mode = 'rgb', index = 0, hex = '#336699') {
  const input = vi.fn(), commit = vi.fn(), start = vi.fn();
  const sliders = colorSliders({ mode, onInput: input, onCommit: commit, onStart: start });
  document.body.append(sliders.el);
  sliders.setColor(hex);
  const field = sliders.el.querySelectorAll('.cs-field')[index];
  field.focus();
  return { sliders, field, input, commit, start };
}
function type(field, value) {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
function key(field, key, shiftKey = false) {
  field.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
}

describe('Color channel arrow keys', () => {
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

  it.each([['gray', 0], ['hsb', 1], ['cmyk', 0]])('preserves fractional %s channel values when stepping up and down', (mode, index) => {
    const { sliders, field, input, commit } = setup(mode, index);
    const original = sliders.values;
    expect(original[index]).not.toBe(Math.round(original[index]));
    key(field, 'ArrowUp');
    expect(sliders.values[index]).toBeCloseTo(original[index] + 1, 10);
    key(field, 'ArrowDown');
    expect(sliders.values).toEqual(original);
    expect(input).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(2);
    key(field, 'Enter');
    field.blur();
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['rgb', '128', 129],
    ['gray', '20.5', 21.5],
    ['hsb', '50.5', 51.5],
    ['cmyk', '20.5', 21.5],
    ['web', '66', 153],
  ])('steps the typed %s draft rather than the previous model channel', (mode, draft, expected) => {
    const { sliders, field, input } = setup(mode);
    type(field, draft);
    key(field, 'ArrowUp');
    expect(sliders.values[0]).toBe(expected);
    expect(input).toHaveBeenCalledTimes(1);
  });

  it.each([['ArrowUp', 30.5], ['ArrowDown', 10.5]])('supports Shift+%s on a fractional draft', (arrow, expected) => {
    const { sliders, field } = setup('cmyk');
    type(field, '20.5');
    key(field, arrow, true);
    expect(sliders.values[0]).toBe(expected);
  });

  it('starts from a pending draft after the model is refreshed', () => {
    const { sliders, field } = setup();
    type(field, '128');
    sliders.setColor('#00ff00');
    key(field, 'ArrowDown');
    expect(sliders.values).toEqual([127, 255, 0]);
  });

  it('starts from the current model after an untouched field refresh', () => {
    const { sliders, field } = setup();
    sliders.setColor('#00ff00');
    key(field, 'ArrowUp');
    expect(sliders.values).toEqual([1, 255, 0]);
  });

  it('keeps an explicitly retyped rounded channel as the stepping base', () => {
    const { sliders, field } = setup('cmyk');
    type(field, field.value);
    key(field, 'ArrowUp');
    expect(sliders.values[0]).toBe(68);
  });

  it('falls back to the exact model value when stepping invalid text', () => {
    const { sliders, field } = setup('cmyk');
    const original = sliders.values[0];
    type(field, 'invalid');
    key(field, 'ArrowUp');
    expect(sliders.values[0]).toBeCloseTo(original + 1, 10);
  });

  it.each([['#000000', 'ArrowDown', 0], ['#ffffff', 'ArrowUp', 255]])('avoids callbacks when %s is already at the %s limit', (hex, arrow, expected) => {
    const { sliders, field, input, commit, start } = setup('rgb', 0, hex);
    key(field, arrow);
    expect(sliders.values[0]).toBe(expected);
    expect(input).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps range input and ordinary Enter commits working after stepping', () => {
    const { sliders, field, commit } = setup();
    key(field, 'ArrowUp');
    type(field, '128');
    key(field, 'Enter');
    expect(sliders.values[0]).toBe(128);
    const range = sliders.el.querySelector('.cs-range');
    range.value = '64';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sliders.values[0]).toBe(64);
    expect(field.value).toBe('64');
    expect(commit).toHaveBeenCalledTimes(3);
  });
});

describe('Color channel stepping on artwork', () => {
  let app, editor, node, field, listeners, documentListeners;
  beforeEach(async () => {
    vi.useFakeTimers();
    listeners = vi.spyOn(window, 'addEventListener');
    documentListeners = vi.spyOn(document, 'addEventListener');
    app = await bootAppWithFeatures();
    editor = app.newDocument();
    node = createPath(rectangle(0, 0, 40, 40), true, { fill: { type: 'solid', color: '#336699' } });
    editor.doc.transact('Rectangle', () => editor.doc.insert(node, editor.targetLayer().id));
    editor.select([node.id]);
    app.openPanel('color');
    const panel = app.dock.panels.get('color');
    panel.setMode('rgb');
    field = panel.sliders.el.querySelector('.cs-field');
    field.focus();
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
  it('applies the stepped draft to the artwork with one Undo step and no extra blur edit', () => {
    type(field, '128');
    key(field, 'ArrowUp');
    expect(editor.doc.get(node.id).fill.color).toBe('#816699');
    const revision = editor.doc.revision;
    field.blur();
    expect(editor.doc.revision).toBe(revision);
    editor.doc.undo();
    expect(editor.doc.get(node.id).fill.color).toBe('#336699');
    editor.doc.redo();
    expect(editor.doc.get(node.id).fill.color).toBe('#816699');
  });
});
