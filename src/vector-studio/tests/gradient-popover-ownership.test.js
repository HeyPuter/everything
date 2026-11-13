import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { closePopover } from '../src/ui/popover.js';
import { paintState } from '../src/features/paint/ui-common.js';
import { newWindow } from '../src/features/workspace/window.js';

let app, listeners, documentListeners;
const kinds = ['panel stop', 'panel point', 'canvas stop'];
const gradient = (kind, color = '#ff0000') => kind === 'panel point'
  ? { type: 'freeform', points: [{ x: 0, y: 0, color }, { x: 1, y: 1, color: '#000000' }] }
  : { type: 'linear', angle: 0, stops: [{ offset: 0, color, opacity: 1 }, { offset: 0.5, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#000000', opacity: 1 }] };
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  documentListeners = vi.spyOn(document, 'addEventListener');
  app = await bootAppWithFeatures();
  paintState.stop = 0;
  paintState.lastGradient = null;
});
afterEach(() => {
  closePopover();
  app.root.remove();
  for (const args of listeners.mock.calls) window.removeEventListener(...args);
  for (const args of documentListeners.mock.calls) document.removeEventListener(...args);
  paintState.stop = 0;
  paintState.lastGradient = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function drawing(editor, kind, color) {
  const node = createPath(rectangle(10, 10, 40, 40), true, { fill: gradient(kind, color) });
  editor.doc.transact('Rectangle', () => editor.doc.insert(node, editor.targetLayer().id));
  editor.select([node.id]);
  return node;
}
function open(editor, node, kind) {
  app.activate(editor);
  vi.advanceTimersByTime(20);
  if (kind === 'canvas stop') {
    app.setTool('gradient');
    app.tool.editStop(editor.doc.get(node.id), 0, { native: { target: app.canvasHost, clientX: 100, clientY: 100 } });
  } else {
    app.openPanel('gradient');
    const panel = app.dock.panels.get('gradient');
    panel.update();
    (kind === 'panel point' ? panel.pointBtn : panel.stopBtn).click();
  }
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
const firstColor = (editor, node) => {
  const paint = editor.doc.get(node.id).fill;
  return (paint.stops || paint.points)[0].color;
};

it.each(kinds)('closes %s when another document becomes active', (kind) => {
  const first = app.newDocument(), node = drawing(first, kind);
  const other = app.newDocument(), otherNode = drawing(other, kind, '#00ff00');
  const pop = open(first, node, kind);
  app.activate(other);
  expect(pop.isConnected).toBe(false);
  color(pop, '0000FF');
  expect(firstColor(first, node)).toBe('#ff0000');
  expect(firstColor(other, otherNode)).toBe('#00ff00');
});

it.each(kinds)('closes %s when selecting different artwork', (kind) => {
  const editor = app.newDocument(), node = drawing(editor, kind), other = drawing(editor, kind, '#00ff00');
  editor.select([node.id]);
  const pop = open(editor, node, kind);
  editor.select([other.id]);
  expect(pop.isConnected).toBe(false);
  color(pop, '0000FF');
  expect(firstColor(editor, node)).toBe('#ff0000');
  expect(firstColor(editor, other)).toBe('#00ff00');
});

it.each(kinds)('closes %s on a shared-window switch', (kind) => {
  const editor = app.newDocument(), node = drawing(editor, kind);
  const other = newWindow(app, editor);
  const pop = open(editor, node, kind);
  app.activate(other);
  expect(pop.isConnected).toBe(false);
});

it.each(kinds)('ignores the actual eyedropper result after Escape closes %s', async (kind) => {
  const resolve = eyedropper();
  const editor = app.newDocument(), node = drawing(editor, kind);
  const pop = open(editor, node, kind);
  pop.querySelector('[aria-label="Pick a color from the screen"]').click();
  pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const revision = editor.doc.revision;
  await resolve();
  expect(firstColor(editor, node)).toBe('#ff0000');
  expect(editor.doc.revision).toBe(revision);
});

it.each(kinds)('closes %s when editing permission is revoked', (kind) => {
  const editor = app.newDocument(), node = drawing(editor, kind);
  const pop = open(editor, node, kind);
  app.collab.sessions.set(editor, { role: 'viewer' });
  app.collab.applyRole(editor);
  expect(pop.isConnected).toBe(false);
});

it.each(kinds)('closes %s when its document closes', async (kind) => {
  const editor = app.newDocument(), node = drawing(editor, kind);
  const pop = open(editor, node, kind);
  await app.closeDocument(editor, { force: true });
  expect(pop.isConnected).toBe(false);
});

it.each(kinds)('closes %s when the focused paint changes', (kind) => {
  const editor = app.newDocument(), node = drawing(editor, kind);
  editor.doc.transact('Stroke', () => editor.doc.update(node.id, { stroke: gradient(kind, '#00ff00') }));
  const pop = open(editor, node, kind);
  editor.focusPaint = 'stroke';
  editor.emit('style');
  expect(pop.isConnected).toBe(false);
});

it.each(kinds)('keeps ordinary %s edits open and coalesced into one Undo step', (kind) => {
  const editor = app.newDocument(), node = drawing(editor, kind);
  const pop = open(editor, node, kind);
  color(pop, '00FF00');
  vi.advanceTimersByTime(20);
  expect(pop.isConnected).toBe(true);
  color(pop, '0000FF');
  expect(firstColor(editor, node)).toBe('#0000ff');
  editor.doc.undo();
  expect(firstColor(editor, node)).toBe('#ff0000');
  editor.doc.redo();
  expect(firstColor(editor, node)).toBe('#0000ff');
});

it.each(kinds)('accepts an eyedropper result while %s still owns its editing context', async (kind) => {
  const resolve = eyedropper();
  const editor = app.newDocument(), node = drawing(editor, kind);
  const pop = open(editor, node, kind);
  pop.querySelector('[aria-label="Pick a color from the screen"]').click();
  await resolve();
  expect(firstColor(editor, node)).toBe('#0000ff');
  expect(pop.isConnected).toBe(true);
});

it.each(kinds)('ignores a delayed eyedropper result after switching away from %s', async (kind) => {
  const resolve = eyedropper();
  const editor = app.newDocument(), node = drawing(editor, kind);
  const other = app.newDocument(), otherNode = drawing(other, kind, '#00ff00');
  const pop = open(editor, node, kind);
  pop.querySelector('[aria-label="Pick a color from the screen"]').click();
  app.activate(other);
  const revisions = [editor.doc.revision, other.doc.revision];
  await resolve();
  expect(firstColor(editor, node)).toBe('#ff0000');
  expect(firstColor(other, otherNode)).toBe('#00ff00');
  expect([editor.doc.revision, other.doc.revision]).toEqual(revisions);
});

it.each(kinds)('closes %s when another edit replaces its gradient', (kind) => {
  const editor = app.newDocument(), node = drawing(editor, kind);
  const pop = open(editor, node, kind);
  editor.doc.transact('Replace fill', () => editor.doc.update(node.id, { fill: { type: 'solid', color: '#00ff00' } }));
  expect(pop.isConnected).toBe(false);
  color(pop, '0000FF');
  expect(editor.doc.get(node.id).fill).toEqual({ type: 'solid', color: '#00ff00' });
});

it.each(kinds)('keeps %s open for unrelated document edits and the same selection', (kind) => {
  const editor = app.newDocument(), node = drawing(editor, kind);
  const other = drawing(editor, kind, '#00ff00');
  editor.select([node.id]);
  const pop = open(editor, node, kind);
  editor.doc.transact('Other object', () => editor.doc.update(other.id, { opacity: 0.5 }));
  editor.select([node.id]);
  expect(pop.isConnected).toBe(true);
  color(pop, '0000FF');
  expect(firstColor(editor, node)).toBe('#0000ff');
  expect(firstColor(editor, other)).toBe('#00ff00');
});

it('tracks the specific canvas gradient when selected objects have mixed paints', () => {
  const editor = app.newDocument(), node = drawing(editor, 'canvas stop');
  const other = drawing(editor, 'canvas stop', '#00ff00');
  editor.select([node.id, other.id]);
  const pop = open(editor, node, 'canvas stop');
  editor.doc.transact('Different gradient', () => editor.doc.update(node.id, { fill: gradient('canvas stop', '#abcdef') }));
  expect(pop.isConnected).toBe(false);
  color(pop, '0000FF');
  expect(firstColor(editor, node)).toBe('#abcdef');
  expect(firstColor(editor, other)).toBe('#00ff00');
});

it('edits canvas stop location, opacity and color after reordering, then deletes the same stop', () => {
  const editor = app.newDocument(), node = drawing(editor, 'canvas stop');
  const pop = open(editor, node, 'canvas stop');
  const enter = (label, value) => {
    const input = pop.querySelector(`[aria-label="${label}"]`);
    input.focus();
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  };
  enter('Location', '75');
  expect(editor.doc.get(node.id).fill.stops[1]).toMatchObject({ offset: 0.75, color: '#ff0000' });
  expect(pop.isConnected).toBe(true);
  enter('Opacity', '40');
  color(pop, '00FF00');
  expect(editor.doc.get(node.id).fill.stops[1]).toMatchObject({ offset: 0.75, opacity: 0.4, color: '#00ff00' });
  expect(pop.isConnected).toBe(true);
  [...pop.querySelectorAll('button')].find((button) => button.textContent === 'Delete Stop').click();
  expect(pop.isConnected).toBe(false);
  expect(editor.doc.get(node.id).fill.stops.map((stop) => stop.color)).toEqual(['#ffffff', '#000000']);
  editor.doc.undo();
  expect(editor.doc.get(node.id).fill.stops[1]).toMatchObject({ color: '#00ff00', offset: 0.75, opacity: 0.4 });
  editor.doc.undo();
  expect(editor.doc.get(node.id).fill).toEqual(gradient('canvas stop'));
});

it('preserves global swatch linking and subsequent color edits in the Gradient panel', () => {
  const editor = app.newDocument(), node = drawing(editor, 'panel stop');
  editor.doc.transact('Swatch', () => editor.doc.updateRoot({ swatches: [{ id: 'brand', name: 'Brand', global: true, paint: { type: 'solid', color: '#123456' } }] }));
  const pop = open(editor, node, 'panel stop');
  pop.querySelector('[aria-label="Brand"]').click();
  expect(editor.doc.get(node.id).fill.stops[0]).toMatchObject({ color: '#123456', swatchId: 'brand' });
  expect(pop.isConnected).toBe(true);
  color(pop, '00FF00');
  expect(editor.doc.get(node.id).fill.stops[0].swatchId).toBeUndefined();
  expect(pop.isConnected).toBe(true);
});

it('can apply and continue editing the default gradient without a selection', () => {
  const editor = app.newDocument();
  app.openPanel('gradient');
  const panel = app.dock.panels.get('gradient');
  panel.update();
  panel.stopBtn.click();
  const pop = document.querySelector('.popover');
  color(pop, '123456');
  expect(editor.style.fill.stops[0].color).toBe('#123456');
  vi.advanceTimersByTime(20);
  expect(pop.isConnected).toBe(true);
  color(pop, 'ABCDEF');
  expect(editor.style.fill.stops[0].color).toBe('#abcdef');
  expect(pop.isConnected).toBe(true);
});

it.each(kinds)('does not let an expired %s eyedropper close or edit its replacement popup', async (kind) => {
  const resolve = eyedropper();
  const editor = app.newDocument(), node = drawing(editor, kind);
  const old = open(editor, node, kind);
  old.querySelector('[aria-label="Pick a color from the screen"]').click();
  const current = open(editor, node, kind);
  await resolve();
  expect(current.isConnected).toBe(true);
  expect(firstColor(editor, node)).toBe('#ff0000');
  color(current, '00FF00');
  expect(firstColor(editor, node)).toBe('#00ff00');
});

it.each(kinds)('moves focus to the canvas when %s loses its selection', (kind) => {
  const editor = app.newDocument(), node = drawing(editor, kind), other = drawing(editor, kind, '#00ff00');
  editor.select([node.id]);
  const pop = open(editor, node, kind);
  pop.querySelector('.cp-hex').focus();
  editor.select([other.id]);
  expect(document.activeElement).toBe(app.canvasHost);
});

it('keeps validation linear while applying a gradient color to a large selection', () => {
  const editor = app.newDocument();
  const nodes = Array.from({ length: 100 }, () => drawing(editor, 'panel stop'));
  editor.select(nodes.map((node) => node.id));
  const pop = open(editor, nodes[0], 'panel stop');
  const checks = vi.spyOn(editor, 'inIsolation');
  color(pop, '0000FF');
  expect(nodes.every((node) => firstColor(editor, node) === '#0000ff')).toBe(true);
  expect(pop.isConnected).toBe(true);
  expect(checks.mock.calls.length).toBeLessThanOrEqual(nodes.length * 5);
});
