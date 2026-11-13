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
  const f = numberField({ label: 'Value', kind: 'number', value: 12, onCommit: commit, ...options });
  document.body.append(f.el);
  f.input.focus();
  return { ...f, commit };
}
function key(input, key) {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

it.each(['number', 'length', 'angle', 'percent'])('refreshes an untouched focused %s field without committing its obsolete value', (kind) => {
  const f = field({ kind });
  f.set(24);
  expect(f.input.value).toContain('24');
  f.input.blur();
  expect(f.commit).not.toHaveBeenCalled();
});

it('shows a new Mixed value in an untouched focused field without replacing it on blur', () => {
  const f = field();
  f.set('mixed');
  expect(f.input.value).toBe('');
  expect(f.input.placeholder).toBe('Mixed');
  f.input.blur();
  expect(f.commit).not.toHaveBeenCalled();
});

it('updates units in an untouched focused field without making an edit', () => {
  const f = field({ kind: 'length', value: 72 });
  f.setUnit('in');
  expect(f.input.value).toBe('1 in');
  f.input.blur();
  expect(f.commit).not.toHaveBeenCalled();
});

it('keeps the refreshed value selected so typing still replaces the whole value', () => {
  const f = field();
  expect([f.input.selectionStart, f.input.selectionEnd]).toEqual([0, 2]);
  f.set(2400);
  expect([f.input.selectionStart, f.input.selectionEnd]).toEqual([0, 4]);
});

it('preserves a partial selection during a model refresh', () => {
  const f = field({ value: 1234 });
  f.input.setSelectionRange(1, 3, 'backward');
  f.set(56789);
  expect([f.input.selectionStart, f.input.selectionEnd, f.input.selectionDirection]).toEqual([1, 3, 'backward']);
});

it('preserves a typed draft across repeated model refreshes until it is committed', () => {
  const f = field();
  f.input.value = '48';
  f.set(24);
  f.set(36);
  expect(f.input.value).toBe('48');
  f.input.blur();
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(48);
});

it('preserves an explicitly retyped value that matches the previous display', () => {
  const f = field();
  f.input.value = '12';
  f.input.dispatchEvent(new Event('input', { bubbles: true }));
  f.set(24);
  expect(f.input.value).toBe('12');
  f.input.blur();
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(12);
});

it('cancels a typed draft to the latest model value', () => {
  const f = field();
  f.input.value = '48';
  f.set(24);
  key(f.input, 'Escape');
  expect(f.input.value).toBe('24');
  expect(f.commit).not.toHaveBeenCalled();
});

it('preserves intermediate typing while an input callback refreshes the model', () => {
  const f = field({ onInput: (v) => f.set(v) });
  f.input.value = '18.';
  f.input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(f.input.value).toBe('18.');
  f.input.value = '18.5';
  f.input.dispatchEvent(new Event('input', { bubbles: true }));
  f.input.blur();
  expect(f.input.value).toBe('18.5');
  expect(f.commit).not.toHaveBeenCalled();
});

it('preserves an invalid draft through refresh and restores the current value on blur', () => {
  const f = field();
  f.input.value = '-';
  f.set(24);
  expect(f.input.value).toBe('-');
  f.input.blur();
  expect(f.input.value).toBe('24');
  expect(f.commit).not.toHaveBeenCalled();
});

it('keeps a typed explicit-unit draft when display units change', () => {
  const f = field({ kind: 'length', value: 72 });
  f.input.value = '2 in';
  f.setUnit('cm');
  expect(f.input.value).toBe('2 in');
  f.input.blur();
  expect(f.commit).toHaveBeenCalledExactlyOnceWith(144);
});

it('recognizes the displayed value as clean after scrubbing', () => {
  const f = field();
  const label = f.el.querySelector('label');
  label.setPointerCapture = () => {};
  for (const [type, x] of [['pointerdown', 10], ['pointermove', 30], ['pointerup', 30]]) {
    const event = new MouseEvent(type, { clientX: x, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    label.dispatchEvent(event);
  }
  expect(f.commit).toHaveBeenCalledWith(22, { live: true });
  f.commit.mockClear();
  f.set(60);
  expect(f.input.value).toBe('60');
  f.input.blur();
  expect(f.commit).not.toHaveBeenCalled();
});

it.each(['Enter', 'ArrowUp'])('recognizes the displayed value as clean after %s', (ending) => {
  const f = field();
  f.input.value = '48';
  key(f.input, ending);
  f.commit.mockClear();
  f.set(60);
  expect(f.input.value).toBe('60');
  f.input.blur();
  expect(f.commit).not.toHaveBeenCalled();
});

it('does not revert updated artwork when an untouched task-bar font field loses focus', async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  app = await bootAppWithFeatures();
  const editor = app.newDocument();
  const node = createText('Example', 10, 10);
  editor.doc.transact('Text', () => editor.doc.insert(node, editor.targetLayer().id));
  editor.select([node.id]);
  vi.advanceTimersByTime(20);
  const input = app.taskbar.querySelector('input[aria-label="Font size"]');
  input.focus();
  editor.doc.transact('Updated elsewhere', () => editor.doc.update(node.id, { char: { ...editor.doc.get(node.id).char, fontSize: 24 } }));
  const revision = editor.doc.revision;
  vi.advanceTimersByTime(20);
  input.blur();
  expect(editor.doc.get(node.id).char.fontSize).toBe(24);
  expect(editor.doc.revision).toBe(revision);
});
