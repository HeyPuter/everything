import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app, listeners;
beforeEach(() => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  app = bootApp();
});
afterEach(() => {
  vi.unstubAllGlobals();
  app.root.remove();
  for (const args of listeners.mock.calls) window.removeEventListener(...args);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function drawing(name) {
  const editor = app.newDocument();
  const node = createPath(rectangle(0, 0, 100, 80), true, { name });
  editor.doc.transact('Add rectangle', () => editor.doc.insert(node, editor.targetLayer().id));
  return { editor, node };
}

it.each(['unavailable', 'replaced'])('ignores a delayed description when its document is %s', (state) => {
  const { editor, node } = drawing('Selected');
  vi.advanceTimersByTime(300);
  const timers = vi.spyOn(globalThis, 'setTimeout');
  editor.select([node.id]);
  const callback = timers.mock.calls.findLast(([, delay]) => delay === 250)[0];
  vi.stubGlobal('document', state === 'unavailable' ? undefined : document.implementation.createHTMLDocument());
  expect(() => callback()).not.toThrow();
  expect(app.canvasDesc.textContent).toBe('No selection');
});

it('debounces changes and announces the latest selection while the canvas has focus', () => {
  const { editor, node } = drawing('Selected');
  app.canvasHost.focus();
  editor.select([node.id]);
  vi.advanceTimersByTime(150);
  editor.select([]);
  vi.advanceTimersByTime(150);
  expect(app.canvasDesc.textContent).toBe('No selection');
  editor.select([node.id]);
  vi.advanceTimersByTime(280);
  expect(app.canvasDesc.textContent).toBe(app.describeSelection(editor));
  expect(document.getElementById('live-region').textContent).toBe(app.describeSelection(editor));
});

it('describes the newly active document instead of the outgoing selection', () => {
  const a = drawing('First'), b = drawing('Second');
  app.activate(a.editor);
  a.editor.select([a.node.id]);
  app.activate(b.editor);
  b.editor.select([b.node.id]);
  vi.advanceTimersByTime(300);
  expect(app.canvasDesc.textContent).toBe(app.describeSelection(b.editor));
});

it('updates the description without announcing over a focused panel control', () => {
  const { editor, node } = drawing('Selected');
  const control = document.createElement('input');
  app.root.append(control);
  control.focus();
  editor.select([node.id]);
  vi.advanceTimersByTime(300);
  expect(app.canvasDesc.textContent).toBe(app.describeSelection(editor));
  expect(document.getElementById('live-region').textContent).toBe('');
});

it.each(['detached', 'closed'])('ignores a pending description after the app is %s', (state) => {
  const { editor, node } = drawing('Selected');
  editor.select([node.id]);
  if (state === 'detached') app.root.remove();
  else app.closeDocument(editor, { force: true });
  vi.advanceTimersByTime(300);
  expect(app.canvasDesc.textContent).toBe('No selection');
});

it('keeps the active selection description pending when a background document selects an object', () => {
  const a = drawing('Active'), b = drawing('Background');
  app.activate(a.editor);
  vi.advanceTimersByTime(300);
  app.canvasHost.focus();
  a.editor.select([a.node.id]);
  vi.advanceTimersByTime(100);
  b.editor.select([b.node.id]);
  vi.advanceTimersByTime(180);
  expect(app.canvasDesc.textContent).toBe(app.describeSelection(a.editor));
  expect(document.getElementById('live-region').textContent).toBe(app.describeSelection(a.editor));
});
