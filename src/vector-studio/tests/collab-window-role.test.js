import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { CollabSession } from '../src/features/collab/session.js';
import { newWindow } from '../src/features/workspace/window.js';

let app, listeners, documentListeners;
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  documentListeners = vi.spyOn(document, 'addEventListener');
  app = await bootAppWithFeatures();
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
function drawing(editor) {
  const path = createPath(rectangle(10, 10, 40, 40), true);
  editor.doc.transact('Rectangle', () => editor.doc.insert(path, editor.targetLayer().id));
  editor.selectAnchors(path.id, [0]);
  return path;
}
function shared() {
  const owner = app.newDocument(), node = drawing(owner);
  const session = new CollabSession({ transport: { call: vi.fn() }, user: { uuid: 'test', username: 'Test' }, timers: false });
  session.role = 'editor';
  app.collab.sessions.set(owner, session);
  const second = newWindow(app, owner);
  second.selectAnchors(node.id, [1]);
  return { owner, second, node, session };
}

it.each(['viewer', 'commenter'])('clears selections and anchor handles in every window when access becomes %s', (role) => {
  const { owner, second, node, session } = shared();
  const third = newWindow(app, owner);
  third.selectAnchors(node.id, [2]);
  app.activate(second);
  session.role = role;
  app.collab.applyRole(owner);
  for (const editor of [owner, second, third]) {
    expect(editor.doc.readOnly).toBe(true);
    expect([...editor.selection]).toEqual([]);
    expect(editor.anchors.size).toBe(0);
  }
  vi.advanceTimersByTime(20);
  expect(app.taskbar.querySelector('[aria-label="Fill"]')).toBeNull();
  expect(app.toolId).toBe('hand');
});

it('does not throw when an arrow key follows permission loss in a second window', () => {
  const { owner, second, node, session } = shared();
  const before = structuredClone(second.doc.get(node.id));
  const revision = second.doc.revision;
  const errors = [];
  window.addEventListener('error', (event) => { errors.push(event.error); event.preventDefault(); });
  app.canvasHost.focus();
  session.role = 'viewer';
  app.collab.applyRole(owner);
  app.canvasHost.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  expect(errors).toEqual([]);
  expect(second.doc.revision).toBe(revision);
  expect(second.doc.get(node.id)).toEqual(before);
});

it('preserves the active selection and tool in an unrelated document', () => {
  const { owner, second, session } = shared();
  const other = app.newDocument(), node = drawing(other);
  app.setTool('direct-selection');
  session.role = 'viewer';
  app.collab.applyRole(owner);
  expect([...other.selection]).toEqual([node.id]);
  expect(other.anchors.size).toBe(1);
  expect(other.doc.readOnly).toBe(false);
  expect(app.editor).toBe(other);
  expect(app.toolId).toBe('direct-selection');
  expect(second.selection.size).toBe(0);
});

it.each(['owner', 'editor'])('preserves every window selection when access remains %s', (role) => {
  const { owner, second, node, session } = shared();
  session.role = role;
  app.collab.applyRole(owner);
  for (const editor of [owner, second]) {
    expect([...editor.selection]).toEqual([node.id]);
    expect(editor.anchors.size).toBe(1);
    expect(editor.doc.readOnly).toBe(false);
  }
});

it('allows selecting and editing from the second window when editing access returns', () => {
  const { owner, second, node, session } = shared();
  session.role = 'viewer';
  app.collab.applyRole(owner);
  session.role = 'editor';
  app.collab.applyRole(owner);
  app.setTool('selection');
  second.clearSelection();
  second.select([node.id]);
  app.canvasHost.focus();
  const x = second.selectionBounds().x;
  app.canvasHost.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  expect(second.selectionBounds().x).toBeGreaterThan(x);
  second.doc.undo();
  expect(second.selectionBounds().x).toBe(x);
});
