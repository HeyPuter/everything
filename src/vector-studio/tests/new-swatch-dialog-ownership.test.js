import { describe, expect, it } from 'vitest';
import { paintSetup } from './panels-paint-helpers.js';
import { createSwatchFromFocused } from '../src/features/paint/swatches-panel.js';
import { swatchesOf } from '../src/features/paint/swatch-model.js';

const accept = (dialog) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
async function setup() {
  const { app, ed, doc, add } = await paintSetup();
  const first = add({ fill: { type: 'solid', color: '#cc3333' } });
  const second = add({ fill: { type: 'solid', color: '#3333cc' } });
  ed.select([first]);
  const history = doc.undoStack.length, before = swatchesOf(doc);
  const pending = createSwatchFromFocused(app);
  const dialog = document.querySelector('dialog[open]');
  dialog.querySelector('#swo-type').value = 'global';
  return { app, ed, doc, first, second, history, before, pending, dialog };
}

describe('New Swatch ownership', () => {
  for (const change of ['selection', 'tab round trip', 'new transaction']) {
    it(`does not apply a global swatch after a ${change}`, async () => {
      const { app, ed, doc, first, second, history, before, pending, dialog } = await setup();
      let tx;
      if (change === 'selection') ed.select([second]);
      if (change === 'tab round trip') { app.newDocument(); app.activate(ed); }
      if (change === 'new transaction') { tx = doc.begin('Newer edit'); doc.updateRoot({ name: 'Newer edit' }); }
      try {
        accept(dialog);
        expect(await pending).toBeNull();
        expect(swatchesOf(doc)).toEqual(before);
        expect(doc.get(first).fill).toEqual({ type: 'solid', color: '#cc3333' });
        expect(doc.get(second).fill).toEqual({ type: 'solid', color: '#3333cc' });
        expect(doc.undoStack).toHaveLength(history);
        if (tx) expect(doc.tx).toBe(tx);
      } finally { tx?.cancel(); }
    });
  }
  it('links the original artwork to a new global swatch in one undo step', async () => {
    const { doc, first, second, history, pending, dialog } = await setup();
    accept(dialog);
    const id = await pending;
    expect(id).toBeTruthy();
    expect(doc.get(first).fill.swatchId).toBe(id);
    expect(doc.get(second).fill).toEqual({ type: 'solid', color: '#3333cc' });
    expect(doc.undoStack).toHaveLength(history + 1);
    doc.undo();
    expect(doc.get(first).fill).toEqual({ type: 'solid', color: '#cc3333' });
    expect(swatchesOf(doc).some((s) => s.id === id)).toBe(false);
  });
});
