import { describe, expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { Emitter } from '../src/lib/emitter.js';

async function setup(command) {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const node = createPath(rectangle(0, 0, 40, 30), true);
  ed.doc.transact('Artwork', () => ed.doc.insert(node, ed.targetLayer().id));
  ed.select([node.id]);
  app.collab ||= new Emitter();
  const pending = app.commands.run(command);
  const dialog = document.querySelector('dialog[open]');
  expect(ed.doc.get(node.id).effects).not.toEqual(node.effects);
  return { app, ed, node, pending, dialog };
}
const cancel = (dialog) => dialog.querySelector('.dialog-close').click();

for (const command of ['effect.dropShadow', 'effect.roughen']) {
  describe(`${command} editing context`, () => {
    it('rolls back and closes when permission is revoked', async () => {
      const { app, ed, node, pending, dialog } = await setup(command);
      try {
        ed.doc.readOnly = true;
        app.collab.emit('role', ed);
        expect(ed.doc.get(node.id).effects).toEqual(node.effects);
        expect(ed.doc.tx).toBeNull();
        expect(ed.selection.size).toBe(0);
        expect(dialog.isConnected).toBe(false);
      } finally { cancel(dialog); await pending; }
    });
    it('cancels when another document becomes active', async () => {
      const { app, ed, node, pending, dialog } = await setup(command);
      try {
        app.newDocument();
        expect(ed.doc.get(node.id).effects).toEqual(node.effects);
        expect(ed.doc.tx).toBeNull();
        expect(dialog.isConnected).toBe(false);
      } finally { cancel(dialog); await pending; }
    });
    it('preserves a newer selection while rolling back', async () => {
      const { ed, node, pending, dialog } = await setup(command);
      try {
        ed.clearSelection();
        expect(ed.doc.get(node.id).effects).toEqual(node.effects);
        expect(ed.selection.size).toBe(0);
        expect(dialog.isConnected).toBe(false);
      } finally { cancel(dialog); await pending; }
    });
    it('ignores stale controls after a newer transaction starts', async () => {
      const { ed, node, pending, dialog } = await setup(command);
      ed.doc.tx.cancel();
      const replacement = ed.doc.begin('Newer edit');
      try {
        ed.doc.updateRoot({ name: 'Newer edit' });
        const input = dialog.querySelector('input[type=text]');
        input.value = '25';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(ed.doc.get(node.id).effects).toEqual(node.effects);
        expect(ed.doc.tx).toBe(replacement);
        expect(ed.doc.root.name).toBe('Newer edit');
        expect(dialog.isConnected).toBe(false);
      } finally { cancel(dialog); await pending; replacement.cancel(); }
    });
  });
}
