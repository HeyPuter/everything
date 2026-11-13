import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { closePopover, openPaintPopover } from '../src/ui/popover.js';
import { newWindow } from '../src/features/workspace/window.js';

let app, listeners, documentListeners;
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  documentListeners = vi.spyOn(document, 'addEventListener');
  app = await bootAppWithFeatures();
});
afterEach(() => {
  closePopover();
  app.root.remove();
  for (const args of listeners.mock.calls) window.removeEventListener(...args);
  for (const args of documentListeners.mock.calls) document.removeEventListener(...args);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function drawing(editor, color = '#ff0000') {
  const node = createPath(rectangle(10, 10, 40, 40), true, { fill: { type: 'solid', color } });
  editor.doc.transact('Rectangle', () => editor.doc.insert(node, editor.targetLayer().id));
  editor.select([node.id]);
  return node;
}
function open(editor) {
  app.activate(editor);
  vi.advanceTimersByTime(20);
  const anchor = app.taskbar.querySelector('[aria-label="Fill"]');
  expect(anchor).not.toBeNull();
  anchor.click();
  const pop = document.querySelector('.popover');
  expect(pop).not.toBeNull();
  return pop;
}
function color(pop, value) {
  const input = pop.querySelector('.cp-hex');
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function eyedropper() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  vi.stubGlobal('EyeDropper', class { open() { return promise; } });
  return async () => { resolve({ sRGBHex: '#0000ff' }); await promise; await Promise.resolve(); };
}

it.each(['other document', 'another window'])('closes the old paint editor when activating %s', (destination) => {
  const first = app.newDocument(), node = drawing(first);
  const second = destination === 'other document' ? app.newDocument() : newWindow(app, first);
  if (destination === 'other document') drawing(second, '#00ff00');
  const pop = open(first);
  const revision = first.doc.revision;
  app.activate(second);
  expect(pop.isConnected).toBe(false);
  color(pop, '0000FF');
  expect(first.doc.get(node.id).fill.color).toBe('#ff0000');
  expect(first.doc.revision).toBe(revision);
});

it('closes a paint editor when its document is closed', async () => {
  const editor = app.newDocument();
  drawing(editor);
  const pop = open(editor);
  await app.closeDocument(editor, { force: true });
  expect(pop.isConnected).toBe(false);
});

it('does not retarget an open color editor to a changed selection', () => {
  const editor = app.newDocument(), first = drawing(editor), second = drawing(editor, '#00ff00');
  editor.select([first.id]);
  const pop = open(editor);
  editor.select([second.id]);
  expect(pop.isConnected).toBe(false);
  color(pop, '0000FF');
  expect(editor.doc.get(first.id).fill.color).toBe('#ff0000');
  expect(editor.doc.get(second.id).fill.color).toBe('#00ff00');
});

it.each(['hand', 'zoom'])('closes the paint editor when permission is revoked while already using %s', (tool) => {
  const editor = app.newDocument();
  drawing(editor);
  app.setTool(tool);
  const pop = open(editor);
  const style = structuredClone(editor.style);
  app.collab.sessions.set(editor, { role: 'viewer' });
  app.collab.applyRole(editor);
  expect(pop.isConnected).toBe(false);
  color(pop, '0000FF');
  expect(editor.style).toEqual(style);
});

it.each(['Escape', 'selection change', 'document switch'])('ignores an eyedropper result after %s invalidates its paint editor', async (action) => {
  const resolve = eyedropper();
  const editor = app.newDocument(), first = drawing(editor), second = drawing(editor, '#00ff00');
  const other = app.newDocument();
  drawing(other);
  editor.select([first.id]);
  const pop = open(editor);
  pop.querySelector('[aria-label="Pick a color from the screen"]').click();
  if (action === 'Escape') pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  else if (action === 'selection change') editor.select([second.id]);
  else app.activate(other);
  const revision = editor.doc.revision;
  await resolve();
  expect(editor.doc.get(first.id).fill.color).toBe('#ff0000');
  expect(editor.doc.get(second.id).fill.color).toBe('#00ff00');
  expect(editor.doc.revision).toBe(revision);
});

it('keeps normal interactive color edits open, coalesced and undoable', () => {
  const editor = app.newDocument(), node = drawing(editor);
  const pop = open(editor);
  color(pop, '00FF00');
  vi.advanceTimersByTime(20);
  expect(pop.isConnected).toBe(true);
  color(pop, '0000FF');
  expect(editor.doc.get(node.id).fill.color).toBe('#0000ff');
  editor.doc.undo();
  expect(editor.doc.get(node.id).fill.color).toBe('#ff0000');
});

it('keeps the popup open for the same selection and unrelated role changes', () => {
  const editor = app.newDocument(), node = drawing(editor);
  const other = app.newDocument();
  drawing(other);
  const pop = open(editor);
  editor.select([node.id]);
  app.collab.sessions.set(other, { role: 'viewer' });
  app.collab.applyRole(other);
  expect(pop.isConnected).toBe(true);
  color(pop, '0000FF');
  expect(editor.doc.get(node.id).fill.color).toBe('#0000ff');
});

it('supports editing the current style with no selection', () => {
  const editor = app.newDocument();
  const anchor = document.createElement('button');
  app.root.append(anchor);
  openPaintPopover(app, anchor, 'fill');
  const pop = document.querySelector('.popover');
  color(pop, '00FF00');
  expect(editor.style.fill.color).toBe('#00ff00');
  expect(pop.isConnected).toBe(true);
});

it.each(['locked', 'hidden', 'deleted'])('closes when its selected target becomes %s', (state) => {
  const editor = app.newDocument(), node = drawing(editor);
  const pop = open(editor);
  editor.doc.transact('Unavailable', () => state === 'deleted' ? editor.doc.remove(node.id) : editor.doc.update(node.id, { [state]: true }));
  const revision = editor.doc.revision;
  expect(pop.isConnected).toBe(false);
  color(pop, '0000FF');
  expect(editor.doc.revision).toBe(revision);
});

it('closes a focused paint editor when Home opens', () => {
  const editor = app.newDocument();
  drawing(editor);
  const pop = open(editor);
  app.showHome();
  expect(pop.isConnected).toBe(false);
  expect(document.activeElement).not.toBe(document.body);
});

it('returns focus to the new canvas only when the obsolete popup held focus', () => {
  const editor = app.newDocument();
  drawing(editor);
  const other = app.newDocument();
  drawing(other);
  const pop = open(editor);
  expect(pop.contains(document.activeElement)).toBe(true);
  app.activate(other);
  expect(document.activeElement).toBe(app.canvasHost);
});

it('preserves focus outside the popup when a selection change invalidates it', () => {
  const editor = app.newDocument(), first = drawing(editor), second = drawing(editor);
  editor.select([first.id]);
  open(editor);
  const outside = document.createElement('input');
  document.body.append(outside);
  outside.focus();
  editor.select([second.id]);
  expect(document.activeElement).toBe(outside);
});

it('applies an eyedropper result when its original paint editor is still active', async () => {
  const resolve = eyedropper();
  const editor = app.newDocument(), node = drawing(editor);
  const pop = open(editor);
  pop.querySelector('[aria-label="Pick a color from the screen"]').click();
  await resolve();
  expect(editor.doc.get(node.id).fill.color).toBe('#0000ff');
  expect(pop.isConnected).toBe(true);
});

it('discards an old eyedropper result without closing a replacement popup', async () => {
  const resolve = eyedropper();
  const first = app.newDocument(), node = drawing(first);
  const other = app.newDocument(), otherNode = drawing(other, '#00ff00');
  const old = open(first);
  old.querySelector('[aria-label="Pick a color from the screen"]').click();
  const current = open(other);
  await resolve();
  expect(current.isConnected).toBe(true);
  expect(first.doc.get(node.id).fill.color).toBe('#ff0000');
  color(current, '0000FF');
  expect(other.doc.get(otherNode.id).fill.color).toBe('#0000ff');
});

it('closes a default-style popup on permission loss even without a selection event', () => {
  const editor = app.newDocument();
  app.setTool('hand');
  const anchor = document.createElement('button');
  app.root.append(anchor);
  openPaintPopover(app, anchor, 'fill');
  const pop = document.querySelector('.popover');
  const style = structuredClone(editor.style);
  app.collab.sessions.set(editor, { role: 'viewer' });
  app.collab.applyRole(editor);
  expect(pop.isConnected).toBe(false);
  color(pop, '0000FF');
  expect(editor.style).toEqual(style);
});

it('checks large selections with linear work during an interactive color change', () => {
  const editor = app.newDocument();
  const nodes = Array.from({ length: 100 }, (_, i) => createPath(rectangle(i * 5, 0, 4, 4), true, { fill: { type: 'solid', color: '#ff0000' } }));
  editor.doc.transact('Rectangles', () => { for (const node of nodes) editor.doc.insert(node, editor.targetLayer().id); });
  editor.select(nodes.map((node) => node.id));
  const pop = open(editor);
  const checks = vi.spyOn(editor, 'inIsolation');
  color(pop, '0000FF');
  expect(nodes.every((node) => editor.doc.get(node.id).fill.color === '#0000ff')).toBe(true);
  expect(pop.isConnected).toBe(true);
  expect(checks.mock.calls.length).toBeLessThanOrEqual(nodes.length * 4);
});
