import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { styleAt } from '../src/model/text-runs.js';
import { createPath, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { setArrangement, newWindow } from '../src/features/workspace/window.js';

let app, listeners, documentListeners;
beforeEach(async () => {
  vi.useFakeTimers();
  listeners = vi.spyOn(window, 'addEventListener');
  documentListeners = vi.spyOn(document, 'addEventListener');
  app = await bootAppWithFeatures();
  // Match native dialog focus restoration, which the minimal jsdom stub omits.
  const focus = new WeakMap(), proto = HTMLDialogElement.prototype;
  const show = proto.showModal, close = proto.close;
  vi.spyOn(proto, 'showModal').mockImplementation(function () {
    focus.set(this, document.activeElement);
    return show.call(this);
  });
  vi.spyOn(proto, 'close').mockImplementation(function (...args) {
    const result = close.apply(this, args), target = focus.get(this);
    if (target?.isConnected) target.focus();
    return result;
  });
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
function drawing(editor, width = 40, color = '#ff0000') {
  const node = createPath(rectangle(10, 10, width, 40), true, { fill: { type: 'solid', color } });
  editor.doc.transact('Rectangle', () => editor.doc.insert(node, editor.targetLayer().id));
  editor.select([node.id]);
  return node;
}
function field(editor, panelId, value) {
  app.activate(editor);
  app.openPanel(panelId);
  const panel = app.dock.panels.get(panelId);
  panel.update();
  const input = panel.el.querySelector(panelId === 'transform' ? 'input[aria-label="W"]' : 'input[aria-label="Hexadecimal color"]');
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}
function pointer(target, type) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  target.dispatchEvent(e);
}

it.each(['floating title', 'wheel'])('commits a pending Transform value to its original document when switching through %s', (action) => {
  const first = app.newDocument();
  drawing(first, 40);
  const other = app.newDocument();
  drawing(other, 80);
  setArrangement(app, null, { float: true });
  const input = field(first, 'transform', '120');
  const host = app.views.get(other).host;
  if (action === 'wheel') host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
  else { pointer(host.querySelector('.float-head'), 'pointerdown'); pointer(host.querySelector('.float-head'), 'pointerup'); }
  expect(app.editor).toBe(other);
  vi.advanceTimersByTime(20);
  input.blur();
  expect(other.selectionFrame().w).toBe(80);
  expect(first.selectionFrame().w).toBe(120);
  first.doc.undo();
  expect(first.selectionFrame().w).toBe(40);
});

it.each(['floating title', 'wheel'])('keeps a pending Color hex edit in its original document after a %s switch', (action) => {
  const first = app.newDocument(), a = drawing(first);
  const other = app.newDocument(), b = drawing(other, 80, '#00ff00');
  setArrangement(app, null, { float: true });
  const input = field(first, 'color', '0000FF');
  const host = app.views.get(other).host;
  if (action === 'wheel') host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
  else { pointer(host.querySelector('.float-head'), 'pointerdown'); pointer(host.querySelector('.float-head'), 'pointerup'); }
  vi.advanceTimersByTime(20);
  input.blur();
  expect(other.doc.get(b.id).fill.color).toBe('#00ff00');
  expect(first.doc.get(a.id).fill.color).toBe('#0000ff');
  first.doc.undo();
  expect(first.doc.get(a.id).fill.color).toBe('#ff0000');
});

it('refreshes the focused field for the new document and applies a fresh draft there', () => {
  const first = app.newDocument();
  drawing(first, 40);
  const other = app.newDocument();
  drawing(other, 80);
  const input = field(first, 'transform', '120');
  app.activate(other);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('80 pt');
  input.value = '160';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.blur();
  expect(first.selectionFrame().w).toBe(120);
  expect(other.selectionFrame().w).toBe(160);
});

it('keeps a draft on its original selection when activating another window of the same document', () => {
  const first = app.newDocument(), a = drawing(first, 40);
  const other = newWindow(app, first), b = drawing(other, 80);
  first.select([a.id]);
  other.select([b.id]);
  const input = field(first, 'transform', '120');
  app.activate(other);
  input.blur();
  expect(first.selectionFrame().w).toBe(120);
  expect(other.selectionFrame().w).toBe(80);
});

it('leaves a draft alone when activating the already active document', () => {
  const editor = app.newDocument();
  drawing(editor, 40);
  const input = field(editor, 'transform', '120');
  const revision = editor.doc.revision;
  app.activate(editor);
  expect(input.value).toBe('120');
  expect(document.activeElement).toBe(input);
  expect(editor.doc.revision).toBe(revision);
  input.blur();
  expect(editor.selectionFrame().w).toBe(120);
});

it('commits a field before checking whether a document needs a close prompt, and preserves it after Cancel', async () => {
  const editor = app.newDocument();
  drawing(editor, 40);
  editor.doc.markSaved();
  const input = field(editor, 'transform', '120');
  const closing = app.closeDocument(editor);
  const dialog = document.querySelector('dialog[open]');
  expect(dialog).not.toBeNull();
  expect(editor.selectionFrame().w).toBe(120);
  [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Cancel').click();
  expect(await closing).toBe(false);
  expect(app.editor).toBe(editor);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('120 pt');
});

it('saves the pending field value when closing through Save', async () => {
  const editor = app.newDocument();
  drawing(editor, 40);
  editor.doc.markSaved();
  field(editor, 'transform', '120');
  const saved = [];
  app.commands.get('file.save').run = () => { saved.push(editor.selectionFrame().w); editor.doc.markSaved(); return true; };
  const closing = app.closeDocument(editor);
  const dialog = document.querySelector('dialog[open]');
  expect(dialog).not.toBeNull();
  [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Save').click();
  expect(await closing).toBe(true);
  expect(saved).toEqual([120]);
  expect(app.editors).not.toContain(editor);
});

it('refreshes Color hex before restoring focus for the next edit', () => {
  const editor = app.newDocument(), first = drawing(editor);
  const other = app.newDocument(), second = drawing(other, 80, '#00ff00');
  const input = field(editor, 'color', '0000FF');
  app.activate(other);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('00FF00');
  input.value = 'FFFFFF';
  input.blur();
  expect(editor.doc.get(first.id).fill.color).toBe('#0000ff');
  expect(other.doc.get(second.id).fill.color).toBe('#ffffff');
});

it('preserves exact values and history for untouched fields', () => {
  const editor = app.newDocument();
  drawing(editor, 40.123456);
  const other = app.newDocument();
  drawing(other, 80);
  app.activate(editor);
  app.openPanel('transform');
  const panel = app.dock.panels.get('transform');
  panel.update();
  panel.el.querySelector('input[aria-label="W"]').focus();
  const revision = editor.doc.revision;
  app.activate(other);
  expect(editor.selectionFrame().w).toBeCloseTo(40.123456, 6);
  expect(editor.doc.revision).toBe(revision);
});

it.each(['no selection', 'view only'])('moves focus to the canvas if the new field is unavailable (%s)', (state) => {
  const editor = app.newDocument();
  drawing(editor, 40);
  const other = app.newDocument();
  if (state === 'view only') { drawing(other, 80); other.doc.readOnly = true; }
  const input = field(editor, 'transform', '120');
  app.activate(other);
  expect(editor.selectionFrame().w).toBe(120);
  expect(document.activeElement).toBe(app.canvasHost);
  expect(document.activeElement).not.toBe(input);
});

it('preserves focus chosen by an editor-activation listener', () => {
  const editor = app.newDocument();
  drawing(editor);
  const other = app.newDocument();
  drawing(other);
  field(editor, 'transform', '120');
  const input = document.createElement('input');
  document.body.append(input);
  app.on('active-editor', () => input.focus());
  app.activate(other);
  expect(document.activeElement).toBe(input);
});

it('does not blur text controls outside document panels', () => {
  const editor = app.newDocument();
  drawing(editor);
  const other = app.newDocument();
  drawing(other);
  app.activate(editor);
  const input = document.createElement('input');
  input.value = 'Search draft';
  app.root.append(input);
  input.focus();
  const blur = vi.fn();
  input.addEventListener('blur', blur);
  app.activate(other);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('Search draft');
  expect(blur).not.toHaveBeenCalled();
});


it.each(['document switch', 'close prompt'])('keeps a pending Character edit on its selected characters during %s', async (action) => {
  const editor = app.newDocument();
  const node = createText('abcd', 10, 40, { char: { fontSize: 12 } });
  editor.doc.transact('Text', () => editor.doc.insert(node, editor.targetLayer().id));
  const other = app.newDocument();
  drawing(other);
  app.activate(editor);
  app.setTool('type');
  const session = app.getTool('type').editText(node.id);
  session.setSelection(1, 3);
  app.openPanel('character');
  const panel = app.dock.panels.get('character');
  panel.update();
  const input = panel.el.querySelector('input[aria-label="Font size"]');
  input.focus();
  input.value = '24';
  // Native text edits emit change when focus leaves; jsdom value assignment does not.
  input.addEventListener('blur', () => input.dispatchEvent(new Event('change', { bubbles: true })), { once: true });
  if (action === 'document switch') app.activate(other);
  else {
    const closing = app.closeDocument(editor);
    const dialog = document.querySelector('dialog[open]');
    [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Cancel').click();
    expect(await closing).toBe(false);
  }
  const result = editor.doc.get(node.id);
  expect(styleAt(result, 0).fontSize).toBe(12);
  expect(styleAt(result, 1).fontSize).toBe(24);
  expect(styleAt(result, 2).fontSize).toBe(24);
  expect(styleAt(result, 3).fontSize).toBe(12);
});

it('finishes an open canvas transaction before applying a pending panel value', () => {
  const editor = app.newDocument(), node = drawing(editor, 40);
  const other = app.newDocument();
  drawing(other, 80);
  field(editor, 'transform', '120');
  const tx = editor.doc.begin('Canvas edit');
  editor.doc.update(node.id, { fill: { type: 'solid', color: '#0000ff' } });
  const tool = app.tool, commit = tool.commit;
  tool.commit = () => { tx.commit(); tool.commit = commit; };
  app.activate(other);
  expect(editor.doc.tx).toBeNull();
  expect(editor.selectionFrame().w).toBe(120);
  expect(other.selectionFrame().w).toBe(80);
  editor.doc.undo();
  expect(editor.selectionFrame().w).toBe(40);
  expect(editor.doc.get(node.id).fill.color).toBe('#0000ff');
  editor.doc.undo();
  expect(editor.doc.get(node.id).fill.color).toBe('#ff0000');
});
