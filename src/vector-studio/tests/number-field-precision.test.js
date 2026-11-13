import { afterEach, expect, it, vi } from 'vitest';
import { numberField } from '../src/ui/widgets.js';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';

let app, listeners;
afterEach(() => {
  app?.root.remove();
  for (const args of listeners?.mock.calls || []) window.removeEventListener(...args);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  app = listeners = null;
});
function field(options = {}) {
  const commit = vi.fn();
  const f = numberField({ label: 'Value', kind: 'number', value: 1 / 3, digits: 2, onCommit: commit, ...options });
  document.body.append(f.el);
  f.input.focus();
  return { ...f, commit };
}
const key = (input, key) => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
function type(input, text) {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

for (const kind of ['number', 'length', 'angle', 'percent']) {
  it.each(['blur', 'Enter'])(`does not round an untouched ${kind} value on %s`, (ending) => {
    const f = field({ kind });
    if (ending === 'blur') f.input.blur();
    else key(f.input, ending);
    expect(f.commit).not.toHaveBeenCalled();
  });
}

it.each(['ArrowUp', 'ArrowDown'])('steps the precise model value on %s when no draft was entered', (arrow) => {
  const f = field();
  key(f.input, arrow);
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(1 / 3 + (arrow === 'ArrowUp' ? 1 : -1));
  f.input.blur();
  expect(f.commit).toHaveBeenCalledOnce();
});

it('preserves the precise point value while stepping in display units', () => {
  const f = field({ kind: 'length', unit: 'in' });
  key(f.input, 'ArrowUp');
  expect(f.commit).toHaveBeenLastCalledWith(1 / 3 + 72);
  key(f.input, 'ArrowUp');
  expect(f.commit).toHaveBeenLastCalledWith((1 / 3 + 72) + 72);
  f.input.blur();
  expect(f.commit).toHaveBeenCalledTimes(2);
});

it('cancels a draft without rounding the current model value', () => {
  const f = field();
  type(f.input, '48');
  f.set(Math.PI);
  key(f.input, 'Escape');
  expect(f.commit).not.toHaveBeenCalled();
});

it('does not clamp an untouched model value merely because the field has limits', () => {
  const f = field({ value: 50, min: 0, max: 10 });
  f.input.blur();
  expect(f.commit).not.toHaveBeenCalled();
});

it('accepts intentionally retyped rounded text even when it matches the displayed string', () => {
  const f = field();
  type(f.input, '0.33');
  f.set(2 / 3);
  expect(f.input.value).toBe('0.33');
  f.input.blur();
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(0.33);
});

it('steps a typed draft and still applies the input limits', () => {
  const f = field({ max: 10 });
  type(f.input, '8.25');
  key(f.input, 'ArrowUp');
  expect(f.commit).toHaveBeenLastCalledWith(9.25);
  key(f.input, 'ArrowUp');
  expect(f.commit).toHaveBeenLastCalledWith(10);
  f.input.blur();
  expect(f.commit).toHaveBeenCalledTimes(2);
});

it('keeps exact artwork values and history unchanged when a fractional font field loses focus', async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  app = await bootAppWithFeatures();
  const editor = app.newDocument();
  const size = 12 + 1 / 3;
  const node = createText('Example', 10, 10, { char: { fontSize: size } });
  editor.doc.transact('Text', () => editor.doc.insert(node, editor.targetLayer().id));
  editor.select([node.id]);
  const revision = editor.doc.revision;
  vi.advanceTimersByTime(20);
  const input = app.taskbar.querySelector('input[aria-label="Font size"]');
  input.focus();
  input.blur();
  expect(editor.doc.get(node.id).char.fontSize).toBe(size);
  expect(editor.doc.revision).toBe(revision);
});
