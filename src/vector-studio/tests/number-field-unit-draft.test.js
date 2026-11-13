import { afterEach, expect, it, vi } from 'vitest';
import { numberField } from '../src/ui/widgets.js';
import { unitOptions } from '../src/lib/units.js';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app, listeners;
afterEach(() => {
  unitOptions.bareUnit = null;
  app?.root.remove();
  for (const args of listeners?.mock.calls || []) window.removeEventListener(...args);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  app = listeners = null;
});
function field(unit = 'in', options = {}) {
  const commit = vi.fn();
  const f = numberField({ label: 'Length', value: 72, unit, onCommit: commit, ...options });
  document.body.append(f.el);
  f.input.focus();
  return { ...f, commit };
}
function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const key = (input, key) => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

it.each([
  ['in', 'pt', '2', 144],
  ['pt', 'in', '2', 2],
  ['in', 'pt', '2 + 1', 216],
])('keeps a pending %s expression in its original units after changing display to %s', (unit, next, draft, expected) => {
  const f = field(unit);
  type(f.input, draft);
  f.setUnit(next);
  expect(f.input.value).toBe(draft);
  f.input.blur();
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(expected);
  expect(f.input.value).toContain(next);
});

it('keeps the original draft unit across multiple display-unit changes and model refreshes', () => {
  const f = field();
  type(f.input, '2');
  f.setUnit('cm');
  f.set(90);
  f.setUnit('mm');
  f.setUnit('pt');
  f.input.blur();
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(144);
});

it('uses the draft unit for subsequent live input callbacks', () => {
  const values = [];
  const f = field('in', { onInput: (v) => { values.push(v); f.set(v); } });
  type(f.input, '2');
  f.setUnit('pt');
  type(f.input, '3');
  expect(values).toEqual([144, 216]);
  f.input.blur();
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.input.value).toBe('216 pt');
});

it('steps the pending expression in its original display unit, then uses the refreshed unit', () => {
  const f = field();
  type(f.input, '2');
  f.setUnit('pt');
  key(f.input, 'ArrowUp');
  expect(f.commit).toHaveBeenLastCalledWith(216);
  expect(f.input.value).toBe('216 pt');
  key(f.input, 'ArrowUp');
  expect(f.commit).toHaveBeenLastCalledWith(217);
});

it('honors explicit suffixes in a pending expression', () => {
  const f = field();
  type(f.input, '3 cm');
  f.setUnit('pt');
  f.input.blur();
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(3 * (72 / 2.54));
});

it('uses new units for a new edit after an untouched field refresh', () => {
  const f = field();
  f.setUnit('pt');
  expect(f.input.value).toBe('72 pt');
  type(f.input, '2');
  f.input.blur();
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(2);
});

it('uses new units for a new draft after cancelling the old draft', () => {
  const f = field();
  type(f.input, '2');
  f.setUnit('pt');
  key(f.input, 'Escape');
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.input.value).toBe('72 pt');
  f.input.focus();
  type(f.input, '3');
  f.input.blur();
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(3);
});

it('uses new units for a new draft after committing the old draft', () => {
  const f = field();
  type(f.input, '2');
  f.setUnit('pt');
  key(f.input, 'Enter');
  expect(f.commit).toHaveBeenLastCalledWith(144);
  type(f.input, '3');
  key(f.input, 'Enter');
  expect(f.commit).toHaveBeenLastCalledWith(3);
});

it('continues honoring a fixed bare-number unit preference', () => {
  unitOptions.bareUnit = 'cm';
  const f = field();
  type(f.input, '2');
  f.setUnit('pt');
  f.input.blur();
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(2 * (72 / 2.54));
});

it('preserves the intended artwork width when document units change during a Transform edit', async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  app = await bootAppWithFeatures();
  const editor = app.newDocument({ units: 'in' });
  const node = createPath(rectangle(0, 0, 72, 72), true);
  editor.doc.transact('Rectangle', () => editor.doc.insert(node, editor.targetLayer().id));
  editor.select([node.id]);
  app.openPanel('transform');
  const panel = app.dock.panels.get('transform');
  panel.update();
  const input = panel.el.querySelector('input[aria-label="W"]');
  expect(input.value).toBe('1 in');
  input.focus();
  type(input, '2');
  editor.doc.transact('Document units', () => editor.doc.updateRoot({ units: 'pt' }));
  panel.update();
  input.blur();
  expect(editor.selectionFrame().w).toBeCloseTo(144);
  editor.doc.undo();
  expect(editor.selectionFrame().w).toBeCloseTo(72);
  expect(editor.doc.root.units).toBe('pt');
});
