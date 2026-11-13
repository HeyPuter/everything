import { describe, expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { Emitter } from '../src/lib/emitter.js';

const button = (dialog, label) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === label).click();
const field = (dialog, label) => {
  const l = [...dialog.querySelectorAll('label')].find((el) => el.textContent.trim() === label);
  return document.getElementById(l.htmlFor) || l.querySelector('input');
};
async function setup(preview = true) {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const node = createPath(rectangle(0, 0, 40, 30), true);
  ed.doc.transact('Artwork', () => ed.doc.insert(node, ed.targetLayer().id));
  ed.select([node.id]);
  app.collab ||= new Emitter();
  const pending = app.commands.run('object.transform.move');
  const dialog = document.querySelector('dialog[open]');
  const horizontal = field(dialog, 'Horizontal');
  horizontal.value = '25';
  horizontal.dispatchEvent(new Event('change', { bubbles: true }));
  const toggle = field(dialog, 'Preview');
  toggle.checked = preview;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  if (preview) expect(ed.doc.get(node.id).anchors).not.toEqual(node.anchors);
  return { app, ed, node, pending, dialog, horizontal };
}

describe('Transform dialog editing context', () => {
  it('rolls back its preview when editing permission is revoked', async () => {
    const { app, ed, node, pending, dialog } = await setup();
    try {
      ed.doc.readOnly = true;
      app.collab.emit('role', ed);
      expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
      expect(ed.doc.tx).toBeNull();
      expect(ed.selection.size).toBe(0);
      expect(dialog.isConnected).toBe(false);
    } finally { button(dialog, 'Cancel'); await pending; }
  });
  it('cancels when another document becomes active', async () => {
    const { app, ed, node, pending, dialog } = await setup();
    try {
      app.newDocument();
      expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
      expect(ed.doc.tx).toBeNull();
      expect(dialog.isConnected).toBe(false);
    } finally { button(dialog, 'Cancel'); await pending; }
  });
  it('preserves a new selection when cancelling its preview', async () => {
    const { ed, node, pending, dialog } = await setup();
    try {
      ed.clearSelection();
      expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
      expect(ed.selection.size).toBe(0);
      expect(dialog.isConnected).toBe(false);
    } finally { button(dialog, 'Cancel'); await pending; }
  });
  it('does not write into or cancel a newer transaction', async () => {
    const { ed, node, pending, dialog, horizontal } = await setup();
    ed.doc.tx.cancel();
    const replacement = ed.doc.begin('Newer edit');
    try {
      ed.doc.updateRoot({ name: 'Newer edit' });
      horizontal.value = '50';
      horizontal.dispatchEvent(new Event('change', { bubbles: true }));
      expect(ed.doc.tx).toBe(replacement);
      expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
      expect(ed.doc.root.name).toBe('Newer edit');
      expect(dialog.isConnected).toBe(false);
    } finally { button(dialog, 'Cancel'); await pending; replacement.cancel(); }
  });
  it('cancels on document closure even with Preview off', async () => {
    const { app, ed, node, pending, dialog } = await setup(false);
    await app.closeDocument(ed, { force: true });
    button(dialog, 'OK');
    await pending;
    expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
  });
  it('copies the previewed transform in one undo step', async () => {
    const { ed, node, pending, dialog } = await setup();
    const before = ed.doc.undoStack.length;
    const preview = ed.doc.get(node.id).anchors;
    button(dialog, 'Copy');
    await pending;
    expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
    const copy = ed.doc.get([...ed.selection][0]);
    expect(copy.id).not.toBe(node.id);
    expect(copy.anchors).toEqual(preview);
    expect(ed.doc.undoStack).toHaveLength(before + 1);
    ed.doc.undo();
    expect(ed.doc.has(copy.id)).toBe(false);
  });
});
