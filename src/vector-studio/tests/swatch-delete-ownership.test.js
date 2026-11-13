import { describe, expect, it } from 'vitest';
import { paintSetup } from './panels-paint-helpers.js';
import { VDocument } from '../src/model/document.js';
import { addSwatch, findSwatch } from '../src/features/paint/swatch-model.js';

const confirm = (dialog) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
async function setup() {
  const { app, ed, doc, add, panel } = await paintSetup();
  let first, second;
  doc.transact('Swatches', () => {
    first = addSwatch(doc, { name: 'First', paint: { type: 'solid', color: '#cc3333' }, global: true });
    second = addSwatch(doc, { name: 'Second', paint: { type: 'solid', color: '#3333cc' } });
  });
  const node = add({ fill: { type: 'solid', color: '#cc3333', swatchId: first } });
  const p = panel('swatches');
  p.selected = new Set([first]);
  const pending = p.deleteSelected();
  const dialog = document.querySelector('dialog[open]');
  return { app, ed, doc, p, first, second, node, pending, dialog };
}

describe('Delete Swatches confirmation ownership', () => {
  it('deletes the confirmed swatches and preserves a newer panel selection', async () => {
    const { doc, p, first, second, pending, dialog } = await setup();
    p.selected = new Set([second]);
    confirm(dialog);
    await pending;
    expect(findSwatch(doc, first)).toBeNull();
    expect(findSwatch(doc, second)).toBeTruthy();
    expect(p.selected).toEqual(new Set([second]));
  });
  it('keeps the original targets and leaves another document panel selection alone', async () => {
    const { app, doc, p, first, second, pending, dialog } = await setup();
    const copy = VDocument.fromJSON(doc.toJSON());
    app.addDocument(copy);
    p.selected = new Set([second]);
    confirm(dialog);
    await pending;
    expect(findSwatch(doc, first)).toBeNull();
    expect(findSwatch(doc, second)).toBeTruthy();
    expect(findSwatch(copy, first)).toBeTruthy();
    expect(findSwatch(copy, second)).toBeTruthy();
    expect(p.selected).toEqual(new Set([second]));
  });
  it('ignores confirmation after the originating window closes', async () => {
    const { app, ed, doc, first, pending, dialog } = await setup();
    const history = doc.undoStack.length;
    await app.closeDocument(ed, { force: true });
    confirm(dialog);
    await pending;
    expect(findSwatch(doc, first)).toBeTruthy();
    expect(doc.undoStack).toHaveLength(history);
  });
  it('does not join a newer transaction', async () => {
    const { doc, first, pending, dialog } = await setup();
    const tx = doc.begin('Newer edit');
    try {
      doc.updateRoot({ name: 'Newer edit' });
      confirm(dialog);
      await pending;
      expect(findSwatch(doc, first)).toBeTruthy();
      expect(doc.tx).toBe(tx);
    } finally { tx.cancel(); }
  });
  it('keeps linked colors and restores the swatch link on undo', async () => {
    const { doc, p, first, node, pending, dialog } = await setup();
    const history = doc.undoStack.length;
    confirm(dialog);
    await pending;
    expect(findSwatch(doc, first)).toBeNull();
    expect(doc.get(node).fill).toEqual({ type: 'solid', color: '#cc3333' });
    expect(p.selected.size).toBe(0);
    expect(doc.undoStack).toHaveLength(history + 1);
    doc.undo();
    expect(doc.get(node).fill.swatchId).toBe(first);
    expect(findSwatch(doc, first)).toBeTruthy();
  });
});
