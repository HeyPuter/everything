import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';
import { setArrangement, newWindow } from '../src/features/workspace/window.js';

let app, listeners;
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  app = await bootAppWithFeatures();
});
afterEach(() => {
  app.root.remove();
  for (const args of listeners.mock.calls) window.removeEventListener(...args);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function text(editor, size) {
  const node = createText('Example', 10, 10, { char: { fontSize: size } });
  editor.doc.transact('Text', () => editor.doc.insert(node, editor.targetLayer().id));
  editor.select([node.id]);
  return node;
}
function pending(editor, value = '48') {
  app.activate(editor);
  vi.advanceTimersByTime(20);
  const input = app.taskbar.querySelector('input[aria-label="Font size"]');
  input.focus();
  input.value = value;
  return input;
}
function pointer(target, type) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
}

it.each(['floating title', 'wheel over another canvas'])('keeps a pending font edit with its document when switching through %s', (action) => {
  const a = app.newDocument(), first = text(a, 12);
  const b = app.newDocument(), second = text(b, 24);
  setArrangement(app, null, { float: true });
  const input = pending(a);
  const host = app.views.get(b).host;
  if (action === 'floating title') {
    pointer(host.querySelector('.float-head'), 'pointerdown');
    pointer(host.querySelector('.float-head'), 'pointerup');
  } else host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
  expect(app.editor).toBe(b);
  vi.advanceTimersByTime(20);
  input.blur();
  expect(b.doc.get(second.id).char.fontSize).toBe(24);
  expect(a.doc.get(first.id).char.fontSize).toBe(48);
  a.doc.undo();
  expect(a.doc.get(first.id).char.fontSize).toBe(12);
  expect(b.doc.get(second.id).char.fontSize).toBe(24);
});

it('does not apply a closed document’s pending font value to the surviving document', async () => {
  const a = app.newDocument(), first = text(a, 12);
  const b = app.newDocument(), second = text(b, 24);
  const input = pending(a);
  await app.closeDocument(a, { force: true });
  vi.advanceTimersByTime(20);
  input.blur();
  expect(b.doc.get(second.id).char.fontSize).toBe(24);
  expect(a.doc.get(first.id).char.fontSize).toBe(12);
});

it('keeps a pending font edit attached to its original text when the selection changes', () => {
  const editor = app.newDocument(), first = text(editor, 12), second = text(editor, 24);
  editor.select([first.id]);
  const input = pending(editor);
  editor.select([second.id]);
  vi.advanceTimersByTime(20);
  input.blur();
  expect(editor.doc.get(second.id).char.fontSize).toBe(24);
  expect(editor.doc.get(first.id).char.fontSize).toBe(48);
});

it('does not reuse the old selection when committing a new edit after switching windows', () => {
  const a = app.newDocument(), first = text(a, 12);
  const b = newWindow(app, a), second = text(b, 24);
  pending(a);
  app.activate(b);
  vi.advanceTimersByTime(20);
  const input = app.taskbar.querySelector('input[aria-label="Font size"]');
  expect(input.value).toContain('24');
  input.focus();
  input.value = '36';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(a.doc.get(first.id).char.fontSize).toBe(48);
  expect(b.doc.get(second.id).char.fontSize).toBe(36);
});

it('commits to the original document even if blur precedes the scheduled toolbar refresh', () => {
  const a = app.newDocument(), first = text(a, 12);
  const b = app.newDocument(), second = text(b, 24);
  const input = pending(a);
  app.activate(b);
  input.blur();
  expect(a.doc.get(first.id).char.fontSize).toBe(48);
  expect(b.doc.get(second.id).char.fontSize).toBe(24);
  vi.advanceTimersByTime(20);
  expect(app.taskbar.querySelector('input[aria-label="Font size"]').value).toContain('24');
});

it('finishes a pending edit before replacing the font field with a different selection context', () => {
  const editor = app.newDocument(), node = text(editor, 12);
  pending(editor);
  editor.clearSelection();
  vi.advanceTimersByTime(20);
  expect(app.taskbar.querySelector('input[aria-label="Font size"]')).toBeNull();
  expect(editor.doc.get(node.id).char.fontSize).toBe(48);
});

it.each(['locked', 'hidden', 'deleted'])('does not edit an original target that became %s', (state) => {
  const editor = app.newDocument(), first = text(editor, 12), second = text(editor, 24);
  editor.select([first.id]);
  const input = pending(editor);
  editor.doc.transact('Make unavailable', () => {
    if (state === 'deleted') editor.doc.remove(first.id);
    else editor.doc.update(first.id, { [state]: true });
  });
  editor.select([second.id]);
  const revision = editor.doc.revision;
  vi.advanceTimersByTime(20);
  input.blur();
  expect(editor.doc.revision).toBe(revision);
  expect(editor.doc.get(second.id).char.fontSize).toBe(24);
  if (state !== 'deleted') expect(editor.doc.get(first.id).char.fontSize).toBe(12);
});

it('switches an unchanged font field without creating an extra edit', () => {
  const a = app.newDocument(), first = text(a, 12);
  const b = app.newDocument(), second = text(b, 24);
  const revision = a.doc.revision;
  pending(a, '12 pt');
  app.activate(b);
  vi.advanceTimersByTime(20);
  expect(a.doc.revision).toBe(revision);
  expect(a.doc.get(first.id).char.fontSize).toBe(12);
  expect(b.doc.get(second.id).char.fontSize).toBe(24);
  const input = app.taskbar.querySelector('input[aria-label="Font size"]');
  expect(input.value).toContain('24');
  expect(document.activeElement).toBe(input);
});
