import { describe, expect, it } from 'vitest';
import { paintSetup } from './panels-paint-helpers.js';
import { addSwatch, findSwatch } from '../src/features/paint/swatch-model.js';
import { Emitter } from '../src/lib/emitter.js';

const button = (dialog, label) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === label).click();
async function setup() {
  const { app, ed, doc, add, panel } = await paintSetup();
  let id;
  doc.transact('Swatch', () => { id = addSwatch(doc, { name: 'Brand', paint: { type: 'solid', color: '#cc3333' }, global: true }); });
  const node = add({ fill: { type: 'solid', color: '#cc3333', swatchId: id } });
  ed.select([node]);
  const before = doc.undoStack.length;
  app.collab ||= new Emitter();
  const pending = panel('swatches').editSwatch(id);
  const dialog = document.querySelector('dialog[open]');
  const hex = dialog.querySelector('.swo-hex');
  hex.value = '00FF00';
  hex.dispatchEvent(new Event('change', { bubbles: true }));
  expect(doc.get(node).fill.color).toBe('#00ff00');
  return { app, ed, doc, id, node, before, pending, dialog, hex };
}

describe('Swatch Options ownership', () => {
  for (const change of ['permission', 'document', 'close', 'selection']) {
    it(`rolls back the swatch and linked artwork after a ${change} change`, async () => {
      const { app, ed, doc, id, node, before, pending, dialog } = await setup();
      try {
        if (change === 'permission') { doc.readOnly = true; app.collab.emit('role', ed); }
        if (change === 'document') app.newDocument();
        if (change === 'close') await app.closeDocument(ed, { force: true });
        if (change === 'selection') ed.clearSelection();
        expect(findSwatch(doc, id).paint.color).toBe('#cc3333');
        expect(doc.get(node).fill.color).toBe('#cc3333');
        expect(doc.tx).toBeNull();
        expect(doc.undoStack).toHaveLength(before);
        expect(dialog.isConnected).toBe(false);
        if (change === 'selection' || change === 'permission') expect(ed.selection.size).toBe(0);
      } finally { button(dialog, 'Cancel'); await pending; }
    });
  }
  it('ignores stale color changes after a newer transaction begins', async () => {
    const { doc, id, node, pending, dialog, hex } = await setup();
    doc.tx.cancel();
    const tx = doc.begin('Newer edit');
    try {
      doc.updateRoot({ name: 'Newer edit' });
      hex.value = '0000FF';
      hex.dispatchEvent(new Event('change', { bubbles: true }));
      expect(findSwatch(doc, id).paint.color).toBe('#cc3333');
      expect(doc.get(node).fill.color).toBe('#cc3333');
      expect(doc.tx).toBe(tx);
      expect(doc.root.name).toBe('Newer edit');
      expect(dialog.isConnected).toBe(false);
    } finally { button(dialog, 'Cancel'); await pending; tx.cancel(); }
  });
  it('applies the swatch and linked artwork together in one undo step', async () => {
    const { doc, id, node, before, pending, dialog } = await setup();
    button(dialog, 'OK');
    await pending;
    expect(findSwatch(doc, id).paint.color).toBe('#00ff00');
    expect(doc.get(node).fill.color).toBe('#00ff00');
    expect(doc.undoStack).toHaveLength(before + 1);
    doc.undo();
    expect(findSwatch(doc, id).paint.color).toBe('#cc3333');
    expect(doc.get(node).fill.color).toBe('#cc3333');
  });
});
