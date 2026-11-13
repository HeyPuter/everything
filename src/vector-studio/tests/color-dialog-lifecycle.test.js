import { describe, expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { Emitter } from '../src/lib/emitter.js';
import { recolorDialog } from '../src/features/paint/edit-colors-ui.js';
import { addGroup, addSwatch, swatchesOf } from '../src/features/paint/swatch-model.js';

async function setup(command) {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  let group, swatch;
  ed.doc.transact('Swatches', () => {
    group = addGroup(ed.doc, 'Brand');
    swatch = addSwatch(ed.doc, { name: 'Red', paint: { type: 'solid', color: '#cc3333' }, global: true, group });
  });
  const node = createPath(rectangle(0, 0, 40, 30), true, { fill: { type: 'solid', color: '#cc3333', swatchId: swatch } });
  ed.doc.transact('Artwork', () => ed.doc.insert(node, ed.targetLayer().id));
  ed.select([node.id]);
  const swatches = swatchesOf(ed.doc);
  app.collab ||= new Emitter();
  const pending = command === 'group' ? recolorDialog(app, { group }) : app.commands.run(command);
  const dialog = document.querySelector('dialog[open]');
  const input = dialog.querySelector('.rc-new') || dialog.querySelector('input[type=range]');
  input.value = input.type === 'color' ? '#00ff00' : '-60';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(ed.doc.get(node.id).fill).not.toEqual(node.fill);
  return { app, ed, node, swatches, pending, dialog, input };
}
const cancel = (dialog) => dialog.querySelector('.dialog-close').click();

for (const command of ['color.saturate', 'color.adjust', 'color.recolor', 'group']) {
  describe(`${command} preview editing context`, () => {
    it('rolls back art and swatches when permission is revoked', async () => {
      const { app, ed, node, swatches, pending, dialog } = await setup(command);
      try {
        ed.doc.readOnly = true;
        app.collab.emit('role', ed);
        expect(ed.doc.get(node.id).fill).toEqual(node.fill);
        expect(swatchesOf(ed.doc)).toEqual(swatches);
        expect(ed.doc.tx).toBeNull();
        expect(ed.selection.size).toBe(0);
        expect(dialog.isConnected).toBe(false);
      } finally { cancel(dialog); await pending; }
    });
    it('cancels when another document becomes active', async () => {
      const { app, ed, node, swatches, pending, dialog } = await setup(command);
      try {
        app.newDocument();
        expect(ed.doc.get(node.id).fill).toEqual(node.fill);
        expect(swatchesOf(ed.doc)).toEqual(swatches);
        expect(ed.doc.tx).toBeNull();
        expect(dialog.isConnected).toBe(false);
      } finally { cancel(dialog); await pending; }
    });
    it('preserves a newer selection while rolling back', async () => {
      const { ed, node, pending, dialog } = await setup(command);
      try {
        ed.clearSelection();
        expect(ed.doc.get(node.id).fill).toEqual(node.fill);
        expect(ed.selection.size).toBe(0);
        expect(dialog.isConnected).toBe(false);
      } finally { cancel(dialog); await pending; }
    });
    it('ignores stale controls after a newer transaction starts', async () => {
      const { ed, node, swatches, pending, dialog, input } = await setup(command);
      ed.doc.tx.cancel();
      const replacement = ed.doc.begin('Newer edit');
      try {
        ed.doc.updateRoot({ name: 'Newer edit' });
        input.value = input.type === 'color' ? '#0000ff' : '-80';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(ed.doc.get(node.id).fill).toEqual(node.fill);
        expect(swatchesOf(ed.doc)).toEqual(swatches);
        expect(ed.doc.tx).toBe(replacement);
        expect(ed.doc.root.name).toBe('Newer edit');
        expect(dialog.isConnected).toBe(false);
      } finally { cancel(dialog); await pending; replacement.cancel(); }
    });
  });
}
