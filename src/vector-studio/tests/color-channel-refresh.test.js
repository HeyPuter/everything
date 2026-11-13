import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { colorSliders } from '../src/features/paint/ui-common.js';
import { MODES, formatChannel } from '../src/features/paint/color-modes.js';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

const modes = ['rgb', 'gray', 'hsb', 'cmyk', 'web'];
function setup(mode = 'rgb') {
  const input = vi.fn(), commit = vi.fn(), start = vi.fn();
  const sliders = colorSliders({ mode, onInput: input, onCommit: commit, onStart: start });
  document.body.append(sliders.el);
  sliders.setColor('#ff0000');
  const field = sliders.el.querySelector('.cs-field');
  field.focus();
  return { sliders, field, input, commit, start };
}
function type(field, value) {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
function enter(field) {
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

describe('Color channel fields after a model refresh', () => {
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
  it.each(modes)('does not restore a stale %s channel on blur', (mode) => {
    const { sliders, field, input, commit, start } = setup(mode);
    sliders.setColor('#00ff00');
    const values = sliders.values;
    field.blur();
    expect(sliders.values).toEqual(values);
    expect(input).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each(modes)('shows the new %s channel and does not apply it again on Enter', (mode) => {
    const { sliders, field, input } = setup(mode);
    sliders.setColor('#00ff00');
    expect(field.value).toBe(formatChannel(MODES[mode].channels[0], sliders.values[0]));
    expect(document.activeElement).toBe(field);
    enter(field);
    expect(input).not.toHaveBeenCalled();
  });

  it.each([[0, 3, 'forward', 0, 2], [1, 2, 'backward', 1, 2], [1, 1, 'none', 1, 1]])('preserves channel text selection %s–%s during refresh', (start, end, direction, nextStart, nextEnd) => {
    const { sliders, field } = setup();
    field.setSelectionRange(start, end, direction);
    sliders.setColor('#123456');
    expect(field.value).toBe('18');
    expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([nextStart, nextEnd, direction]);
  });

  it('preserves an actual channel draft while other channels refresh', () => {
    const { sliders, field, input } = setup();
    type(field, '128');
    sliders.setColor('#00ff00');
    expect(field.value).toBe('128');
    field.blur();
    expect(input).toHaveBeenCalledExactlyOnceWith('#80ff00', [128, 255, 0]);
    expect(sliders.values).toEqual([128, 255, 0]);
  });

  it('honors explicitly retyping the displayed channel before the model changes', () => {
    const { sliders, field, input } = setup();
    type(field, '255');
    sliders.setColor('#00ff00');
    expect(field.value).toBe('255');
    field.blur();
    expect(input).toHaveBeenCalledExactlyOnceWith('#ffff00', [255, 255, 0]);
  });

  it('restores the current model value after invalid input without painting', () => {
    const { sliders, field, input } = setup();
    type(field, 'invalid');
    sliders.setColor('#00ff00');
    expect(field.value).toBe('invalid');
    field.blur();
    expect(field.value).toBe('0');
    expect(input).not.toHaveBeenCalled();
  });

  it('treats a completed channel edit as untouched on later refreshes', () => {
    const { sliders, field, input } = setup();
    type(field, '128');
    enter(field);
    input.mockClear();
    sliders.setColor('#00ff00');
    field.blur();
    expect(sliders.values).toEqual([0, 255, 0]);
    expect(input).not.toHaveBeenCalled();
  });

  it('keeps exact fractional channels when an untouched field is committed', () => {
    const { sliders, field, input } = setup('cmyk');
    sliders.setColor('#336699');
    const values = sliders.values;
    enter(field);
    field.blur();
    expect(sliders.values).toEqual(values);
    expect(input).not.toHaveBeenCalled();
  });

  it('preserves another channel draft during a channel commit', () => {
    const { sliders, field } = setup();
    const green = sliders.el.querySelectorAll('.cs-field')[1];
    type(field, '128');
    // A focused draft must survive a programmatic update from another control.
    green.value = '64';
    enter(green);
    expect(field.value).toBe('128');
    field.blur();
    expect(sliders.values).toEqual([128, 64, 0]);
  });
});

describe('Color channel refresh in an actual document', () => {
  let app, editor, node, panel, field, listeners, documentListeners;
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
  function refresh() {
    editor.doc.transact('Updated color', () => editor.doc.update(node.id, { fill: { type: 'solid', color: '#00ff00' } }));
    panel.update();
  }
  it.each(['blur', 'Enter', 'document switch'])('preserves newer artwork and history on %s from an untouched channel field', (action) => {
    refresh();
    const revision = editor.doc.revision;
    if (action === 'blur') field.blur();
    else if (action === 'Enter') enter(field);
    else app.newDocument();
    expect(editor.doc.get(node.id).fill.color).toBe('#00ff00');
    expect(editor.doc.revision).toBe(revision);
  });
  it('applies a real draft on top of the newer color with independent Undo', () => {
    type(field, '128');
    refresh();
    field.blur();
    expect(editor.doc.get(node.id).fill.color).toBe('#80ff00');
    editor.doc.undo();
    expect(editor.doc.get(node.id).fill.color).toBe('#00ff00');
  });
});
