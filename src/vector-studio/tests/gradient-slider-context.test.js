import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { setArrangement, newWindow } from '../src/features/workspace/window.js';
import { paintState } from '../src/features/paint/ui-common.js';

const gradient = (color = '#ff0000') => ({ type: 'linear', angle: 0, stops: [
  { offset: 0, color, opacity: 1 }, { offset: 0.5, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#000000', opacity: 1 },
] });
let app, editor, node, panel, slider, listeners, documentListeners;
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  documentListeners = vi.spyOn(document, 'addEventListener');
  app = await bootAppWithFeatures();
  paintState.stop = 0;
  paintState.lastGradient = null;
  editor = app.newDocument();
  node = drawing(editor);
  app.openPanel('gradient');
  panel = app.dock.panels.get('gradient');
  panel.update();
  slider = panel.slider.el;
  slider.setPointerCapture = vi.fn();
  slider.releasePointerCapture = vi.fn();
  slider.querySelector('.gs-bar').getBoundingClientRect = () => ({ left: 0, width: 100 });
});
afterEach(() => {
  app.root.remove();
  for (const args of listeners.mock.calls) window.removeEventListener(...args);
  for (const args of documentListeners.mock.calls) document.removeEventListener(...args);
  paintState.stop = 0;
  paintState.lastGradient = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function drawing(ed, color) {
  const n = createPath(rectangle(0, 0, 40, 40), true, { fill: gradient(color) });
  ed.doc.transact('Rectangle', () => ed.doc.insert(n, ed.targetLayer().id));
  ed.select([n.id]);
  return n;
}
function pointer(type, { target = slider, id = 1, x = 10 } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 10 });
  Object.defineProperty(event, 'pointerId', { value: id });
  target.dispatchEvent(event);
}
function start(kind, id = 1) {
  pointer('pointerdown', { target: slider.querySelector(kind === 'stop' ? '.gs-stop' : '.gs-mid'), id });
  pointer('pointermove', { id });
}
const fill = (ed = editor, n = node) => structuredClone(ed.doc.get(n.id).fill);
const stale = () => { pointer('pointermove', { x: 40 }); pointer('pointerup'); };

for (const kind of ['stop', 'midpoint']) {
  it.each(['another document', 'shared window'])(`ends a ${kind} drag on wheel activation of %s`, (destination) => {
    const other = destination === 'shared window' ? newWindow(app, editor) : app.newDocument();
    const otherNode = drawing(other, '#00ff00');
    editor.select([node.id]);
    app.activate(editor);
    setArrangement(app, null, { float: true });
    start(kind);
    const edited = fill();
    app.views.get(other).host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
    expect(app.editor).toBe(other);
    stale();
    expect(fill(other, otherNode)).toEqual(gradient('#00ff00'));
    expect(fill()).toEqual(edited);
    expect(slider.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
    panel.update();
    start(kind, 2);
    pointer('pointerup', { id: 2 });
    expect(fill(other, otherNode)).not.toEqual(gradient('#00ff00'));
  });

  it(`does not revive a ${kind} drag after switching away and back`, () => {
    const other = app.newDocument();
    drawing(other, '#00ff00');
    app.activate(editor);
    start(kind);
    const edited = fill();
    app.activate(other);
    app.activate(editor);
    stale();
    expect(fill()).toEqual(edited);
    editor.doc.undo();
    expect(fill()).toEqual(gradient());
  });

  it(`ends a ${kind} drag on selection changes`, () => {
    const other = drawing(editor, '#00ff00');
    editor.select([node.id]);
    start(kind);
    const edited = fill();
    editor.select([other.id]);
    stale();
    expect(fill(editor, other)).toEqual(gradient('#00ff00'));
    expect(fill()).toEqual(edited);
  });

  it.each(['locked', 'hidden', 'deleted'])(`ends a ${kind} drag when its target becomes %s`, (state) => {
    start(kind);
    editor.doc.transact('Unavailable', () => state === 'deleted' ? editor.doc.remove(node.id) : editor.doc.update(node.id, { [state]: true }));
    const revision = editor.doc.revision, style = structuredClone(editor.style);
    stale();
    expect(editor.doc.revision).toBe(revision);
    expect(editor.style).toEqual(style);
    expect(slider.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  });

  it(`ends a ${kind} drag when switching fill to stroke`, () => {
    editor.doc.transact('Stroke', () => editor.doc.update(node.id, { stroke: gradient('#00ff00') }));
    start(kind);
    const edited = fill();
    editor.focusPaint = 'stroke';
    editor.emit('style');
    stale();
    expect(editor.doc.get(node.id).stroke).toEqual(gradient('#00ff00'));
    expect(fill()).toEqual(edited);
  });

  it(`ends a ${kind} drag when Home is shown`, () => {
    start(kind);
    const edited = fill();
    app.showHome();
    stale();
    expect(fill()).toEqual(edited);
  });

  it.each(['panel', 'options'])(`ends a ${kind} drag when its %s closes`, (part) => {
    start(kind);
    const edited = fill();
    if (part === 'panel') {
      app.dock.closeFlyout(false);
      app.openPanel('gradient');
    } else {
      panel.setOptionsShown(false);
      panel.setOptionsShown(true);
    }
    stale();
    expect(fill()).toEqual(edited);
  });

  it(`ends a ${kind} drag when editing access is revoked and restored`, () => {
    start(kind);
    const edited = fill();
    app.collab.sessions.set(editor, { role: 'viewer' });
    app.collab.applyRole(editor);
    expect(slider.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
    app.collab.sessions.set(editor, { role: 'editor' });
    app.collab.applyRole(editor);
    editor.select([node.id]);
    stale();
    expect(fill()).toEqual(edited);
  });

  it.each(['replace', 'freeform', 'undo'])(`ends a ${kind} drag when another edit performs %s`, (action) => {
    start(kind);
    if (action === 'undo') editor.doc.undo();
    else editor.doc.transact('Other gradient', () => editor.doc.update(node.id, { fill: action === 'replace' ? gradient('#00ff00') : { type: 'freeform', points: [{ x: 0, y: 0, color: '#00ff00' }] } }));
    const current = fill();
    stale();
    expect(fill()).toEqual(current);
    expect(slider.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  });

  it(`keeps a ${kind} drag active through ordinary refreshes and unrelated changes`, () => {
    start(kind);
    vi.advanceTimersByTime(20);
    editor.select([node.id]);
    editor.doc.transact('Rename', () => editor.doc.updateRoot({ name: 'Renamed' }));
    pointer('pointermove', { x: 20 });
    pointer('pointerup');
    expect(kind === 'stop' ? fill().stops[0].offset : fill().stops[0].midpoint).toBeCloseTo(kind === 'stop' ? 0.2 : 0.4);
  });
}

it('supports a gradient drag for drawing defaults', () => {
  editor.select([]);
  editor.style.fill = gradient();
  panel.update();
  start('stop');
  vi.advanceTimersByTime(20);
  pointer('pointermove', { x: 20 });
  pointer('pointerup');
  expect(editor.style.fill.stops[0].offset).toBeCloseTo(0.2);
  expect(fill()).toEqual(gradient());
});

it('ends the drag when its document closes and permits editing a new document', async () => {
  start('stop');
  await app.closeDocument(editor, { force: true });
  const other = app.newDocument(), otherNode = drawing(other, '#00ff00');
  stale();
  expect(fill(other, otherNode)).toEqual(gradient('#00ff00'));
  panel.update();
  start('stop', 2);
  pointer('pointerup', { id: 2 });
  expect(fill(other, otherNode).stops[0].offset).toBeCloseTo(0.1);
});

it('detects a changed individual gradient while the selection remains mixed', () => {
  const other = drawing(editor, '#00ff00');
  editor.select([node.id, other.id]);
  panel.update();
  pointer('pointerdown', { target: slider.querySelector('.gs-stop') });
  editor.doc.transact('Other paint', () => editor.doc.update(other.id, { fill: gradient('#0000ff') }));
  stale();
  expect(fill()).toEqual(gradient());
  expect(fill(editor, other)).toEqual(gradient('#0000ff'));
});

it('does not let an old context callback cancel a replacement drag', () => {
  const other = drawing(editor, '#00ff00');
  editor.select([node.id]);
  const off = editor.on('selection', () => {
    off();
    pointer('pointercancel');
    panel.update();
    start('stop', 2);
  });
  start('stop');
  const edited = fill();
  editor.select([other.id]);
  pointer('pointermove', { id: 2, x: 20 });
  pointer('pointerup', { id: 2 });
  expect(fill(editor, other).stops[0].offset).toBeCloseTo(0.2);
  expect(fill()).toEqual(edited);
});

it('stops a default-style drag when another control replaces the gradient', () => {
  editor.select([]);
  editor.setStyle({ fill: gradient() });
  panel.update();
  start('stop');
  editor.setStyle({ fill: gradient('#00ff00') });
  stale();
  expect(editor.style.fill).toEqual(gradient('#00ff00'));
});

it('validates a large selection with linear work during a live edit', () => {
  const nodes = Array.from({ length: 100 }, () => drawing(editor));
  editor.select(nodes.map((n) => n.id));
  panel.update();
  start('stop');
  const checks = vi.spyOn(editor, 'inIsolation');
  pointer('pointermove', { x: 20 });
  pointer('pointerup');
  expect(nodes.every((n) => fill(editor, n).stops[0].offset === 0.2)).toBe(true);
  expect(checks.mock.calls.length).toBeLessThanOrEqual(nodes.length * 8);
});

it('continues a drag when another document changes or loses editing access', () => {
  const other = app.newDocument();
  drawing(other, '#00ff00');
  app.activate(editor);
  start('stop');
  other.doc.transact('Other edit', () => other.doc.updateRoot({ name: 'Other' }));
  app.collab.sessions.set(other, { role: 'viewer' });
  app.collab.applyRole(other);
  pointer('pointermove', { x: 20 });
  pointer('pointerup');
  expect(fill().stops[0].offset).toBeCloseTo(0.2);
});
