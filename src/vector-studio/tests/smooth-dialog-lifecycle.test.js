import { describe, expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { anchor } from '../src/model/bezier.js';
import { Emitter } from '../src/lib/emitter.js';

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const node = createPath([anchor(0, 0), anchor(20, 30), anchor(40, 0), anchor(60, 30)], false);
  ed.doc.transact('Artwork', () => ed.doc.insert(node, ed.targetLayer().id));
  ed.select([node.id]);
  app.collab ||= new Emitter();
  const pending = app.commands.run('path.smooth');
  const dialog = document.querySelector('dialog[open]');
  const range = dialog.querySelector('input[type=range]');
  range.value = '35';
  range.dispatchEvent(new Event('input', { bubbles: true }));
  expect(ed.doc.get(node.id).anchors).not.toEqual(node.anchors);
  return { app, ed, node, pending, dialog, range };
}

const finish = (dialog) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();

describe('Smooth dialog editing context', () => {
  it('rolls back its preview when editing permission is revoked', async () => {
    const { app, ed, node, pending, dialog } = await setup();
    try {
      ed.doc.readOnly = true;
      app.collab.emit('role', ed);
      expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
      expect(ed.doc.tx).toBeNull();
      expect(ed.selection.size).toBe(0);
      expect(dialog.isConnected).toBe(false);
    } finally {
      finish(dialog);
      await pending;
    }
    expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
  });

  it('cancels when another document becomes active', async () => {
    const { app, ed, node, pending, dialog } = await setup();
    try {
      app.newDocument();
      expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
      expect(ed.doc.tx).toBeNull();
      expect(dialog.isConnected).toBe(false);
    } finally {
      finish(dialog);
      await pending;
    }
  });
  it('does not write into or cancel a newer transaction', async () => {
    const { ed, node, pending, dialog, range } = await setup();
    ed.doc.tx.cancel();
    const replacement = ed.doc.begin('Newer edit');
    try {
      ed.doc.updateRoot({ name: 'Newer edit' });
      range.value = '50';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      expect(ed.doc.tx).toBe(replacement);
      expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
      expect(ed.doc.root.name).toBe('Newer edit');
      expect(dialog.isConnected).toBe(false);
    } finally {
      finish(dialog);
      await pending;
      replacement.cancel();
    }
  });

  it('keeps a newer selection when cancelling the preview', async () => {
    const { ed, node, pending, dialog } = await setup();
    try {
      ed.clearSelection();
      expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
      expect(ed.selection.size).toBe(0);
      expect(dialog.isConnected).toBe(false);
    } finally {
      finish(dialog);
      await pending;
    }
  });

  it('rolls back when its document is closed', async () => {
    const { app, ed, node, pending, dialog } = await setup();
    try {
      await app.closeDocument(ed, { force: true });
      expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
      expect(ed.doc.tx).toBeNull();
      expect(dialog.isConnected).toBe(false);
    } finally {
      finish(dialog);
      await pending;
    }
  });

});
