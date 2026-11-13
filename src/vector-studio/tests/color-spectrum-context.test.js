import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { setArrangement, newWindow } from '../src/features/workspace/window.js';

let app, editor, node, panel, spectrum, listeners, documentListeners;
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  documentListeners = vi.spyOn(document, 'addEventListener');
  app = await bootAppWithFeatures();
  editor = app.newDocument();
  node = drawing(editor);
  app.openPanel('color');
  panel = app.dock.panels.get('color');
  panel.update();
  spectrum = panel.spectrum;
  spectrum.setPointerCapture = vi.fn();
  spectrum.releasePointerCapture = vi.fn();
  spectrum.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
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
function drawing(ed, color = '#123456') {
  const n = createPath(rectangle(0, 0, 40, 40), true, { fill: { type: 'solid', color } });
  ed.doc.transact('Rectangle', () => ed.doc.insert(n, ed.targetLayer().id));
  ed.select([n.id]);
  return n;
}
function pointer(type, id = 1, x = 0, y = 50) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: id });
  spectrum.dispatchEvent(event);
}
const color = (ed = editor, n = node) => ed.doc.get(n.id).fill.color;

it.each(['another document', 'shared window'])('ends a spectrum drag when wheel activation switches to %s', (destination) => {
  const other = destination === 'shared window' ? newWindow(app, editor) : app.newDocument();
  const otherNode = drawing(other, '#00ff00');
  editor.select([node.id]);
  app.activate(editor);
  setArrangement(app, null, { float: true });
  pointer('pointerdown');
  expect(color()).toBe('#ff0000');
  app.views.get(other).host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
  expect(app.editor).toBe(other);
  pointer('pointermove', 1, 0, 100);
  expect(color(other, otherNode)).toBe('#00ff00');
  expect(color()).toBe('#ff0000');
  expect(spectrum.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  pointer('pointerup');
  pointer('pointerdown', 2, 0, 0);
  pointer('pointerup', 2);
  expect(color(other, otherNode)).toBe('#ffffff');
});

it('does not revive the old drag after switching away and back', () => {
  const other = app.newDocument();
  drawing(other, '#00ff00');
  app.activate(editor);
  pointer('pointerdown');
  app.activate(other);
  app.activate(editor);
  pointer('pointermove', 1, 0, 100);
  expect(color()).toBe('#ff0000');
  editor.doc.undo();
  expect(color()).toBe('#123456');
});

it('ends a drag when the selected artwork changes', () => {
  const other = drawing(editor, '#00ff00');
  editor.select([node.id]);
  pointer('pointerdown');
  editor.select([other.id]);
  pointer('pointermove', 1, 0, 100);
  expect(color(editor, other)).toBe('#00ff00');
  expect(color()).toBe('#ff0000');
});

it.each(['locked', 'hidden', 'deleted'])('ends a drag when its target becomes %s', (state) => {
  pointer('pointerdown');
  editor.doc.transact('Unavailable', () => state === 'deleted' ? editor.doc.remove(node.id) : editor.doc.update(node.id, { [state]: true }));
  const revision = editor.doc.revision, style = structuredClone(editor.style);
  pointer('pointermove', 1, 0, 100);
  expect(editor.doc.revision).toBe(revision);
  expect(editor.style).toEqual(style);
  expect(spectrum.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
});

it('ends a drag before changing the focused fill to stroke', () => {
  editor.doc.transact('Stroke', () => editor.doc.update(node.id, { stroke: { type: 'solid', color: '#00ff00' } }));
  pointer('pointerdown');
  editor.focusPaint = 'stroke';
  editor.emit('style');
  pointer('pointermove', 1, 0, 100);
  expect(editor.doc.get(node.id).stroke.color).toBe('#00ff00');
  expect(color()).toBe('#ff0000');
});

it('ends a drag when Home replaces the document view', () => {
  pointer('pointerdown');
  app.showHome();
  const revision = editor.doc.revision;
  pointer('pointermove', 1, 0, 100);
  expect(color()).toBe('#ff0000');
  expect(editor.doc.revision).toBe(revision);
});

it('ends a drag when its panel closes and does not revive it on reopening', () => {
  pointer('pointerdown');
  app.dock.closeFlyout(false);
  expect(panel.visible).toBe(false);
  app.openPanel('color');
  pointer('pointermove', 1, 0, 100);
  expect(color()).toBe('#ff0000');
});

it('ends a drag when the original document closes, allowing a fresh document gesture', async () => {
  pointer('pointerdown');
  await app.closeDocument(editor, { force: true });
  const other = app.newDocument(), otherNode = drawing(other, '#00ff00');
  pointer('pointermove', 1, 0, 100);
  expect(color(other, otherNode)).toBe('#00ff00');
  pointer('pointerdown', 2, 0, 0);
  pointer('pointerup', 2);
  expect(color(other, otherNode)).toBe('#ffffff');
});

it('releases the gesture immediately when collaboration revokes editing access', () => {
  pointer('pointerdown');
  app.collab.sessions.set(editor, { role: 'viewer' });
  app.collab.applyRole(editor);
  expect(spectrum.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  // Returning to editable state must not revive the previous gesture.
  app.collab.sessions.set(editor, { role: 'editor' });
  app.collab.applyRole(editor);
  editor.select([node.id]);
  pointer('pointermove', 1, 0, 100);
  expect(color()).toBe('#ff0000');
});

it('keeps ordinary painting coalesced through document and style refreshes', () => {
  pointer('pointerdown');
  vi.advanceTimersByTime(20);
  editor.select([node.id]);
  pointer('pointermove', 1, 0, 0);
  pointer('pointerup');
  expect(color()).toBe('#ffffff');
  editor.doc.undo();
  expect(color()).toBe('#123456');
  editor.doc.redo();
  expect(color()).toBe('#ffffff');
});

it('keeps a drag active through unrelated document and role changes', () => {
  const other = app.newDocument();
  drawing(other, '#00ff00');
  app.activate(editor);
  pointer('pointerdown');
  other.doc.transact('Other edit', () => other.doc.updateRoot({ name: 'Other' }));
  app.collab.sessions.set(other, { role: 'viewer' });
  app.collab.applyRole(other);
  pointer('pointermove', 1, 0, 0);
  pointer('pointerup');
  expect(color()).toBe('#ffffff');
});

it('supports painting drawing defaults without a selection', () => {
  editor.select([]);
  pointer('pointerdown');
  pointer('pointermove', 1, 0, 0);
  pointer('pointerup');
  expect(editor.style.fill.color).toBe('#ffffff');
  expect(color()).toBe('#123456');
});

it('does not let an already-dispatched old context callback end a replacement gesture', () => {
  const other = drawing(editor, '#00ff00');
  editor.select([node.id]);
  // Emitter snapshots its listeners. This earlier listener replaces the drag
  // before the old selection callback from that same dispatch is reached.
  const off = editor.on('selection', () => {
    off();
    pointer('pointerup');
    pointer('pointerdown', 2, 0, 0);
  });
  pointer('pointerdown');
  editor.select([other.id]);
  pointer('pointermove', 2, 0, 100);
  pointer('pointerup', 2);
  expect(color(editor, other)).toBe('#000000');
  expect(color()).toBe('#ff0000');
});

it('keeps validation linear while recoloring a large selection', () => {
  const nodes = Array.from({ length: 100 }, () => drawing(editor));
  editor.select(nodes.map((n) => n.id));
  pointer('pointerdown');
  const checks = vi.spyOn(editor, 'inIsolation');
  pointer('pointermove', 1, 0, 0);
  pointer('pointerup');
  expect(nodes.every((n) => color(editor, n) === '#ffffff')).toBe(true);
  expect(checks.mock.calls.length).toBeLessThanOrEqual(nodes.length * 5);
});
