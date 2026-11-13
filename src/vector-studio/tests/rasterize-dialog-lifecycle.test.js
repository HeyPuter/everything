import { describe, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { Emitter } from '../src/lib/emitter.js';
import { rasterizeObjectDialog } from '../src/features/effects/raster.js';
import { renderRegion } from '../src/features/io/raster.js';

vi.mock('../src/features/io/raster.js', async (original) => ({ ...await original(), renderRegion: vi.fn() }));

const button = (dialog, label) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === label).click();
async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const node = createPath(rectangle(0, 0, 40, 30), true);
  ed.doc.transact('Artwork', () => ed.doc.insert(node, ed.targetLayer().id));
  ed.select([node.id]);
  app.collab ||= new Emitter();
  const pending = rasterizeObjectDialog(app);
  const dialog = document.querySelector('dialog[open]');
  return { app, ed, node, pending, dialog };
}

describe('Rasterize dialog context', () => {
  for (const change of ['document', 'close', 'selection', 'permission']) {
    it(`cancels the prompt after a ${change} change`, async () => {
      const { app, ed, node, pending, dialog } = await setup();
      try {
        if (change === 'document') app.newDocument();
        if (change === 'close') await app.closeDocument(ed, { force: true });
        if (change === 'selection') ed.clearSelection();
        if (change === 'permission') { ed.doc.readOnly = true; app.collab.emit('role', ed); }
        expect(dialog.isConnected).toBe(false);
      } finally { button(dialog, 'Cancel'); await pending; }
      expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
    });
  }
  for (const switchTab of [true, false]) {
    it(switchTab ? 'discards a pending image after switching away and back' : 'applies a completed image in the original context', async () => {
      let finish;
      renderRegion.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const { app, ed, node, pending, dialog } = await setup();
      const history = ed.doc.undoStack.length, assets = ed.doc.assets.size;
      button(dialog, 'OK');
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      if (switchTab) { app.newDocument(); app.activate(ed); }
      finish({ width: 40, height: 30, getContext: () => ({}), convertToBlob: async () => new Blob(['png'], { type: 'image/png' }) });
      expect(await pending).toBe(!switchTab);
      if (switchTab) {
        expect(ed.doc.get(node.id).anchors).toEqual(node.anchors);
        expect(ed.doc.undoStack).toHaveLength(history);
        expect(ed.doc.assets.size).toBe(assets);
      } else {
        expect(ed.doc.has(node.id)).toBe(false);
        expect(ed.doc.undoStack).toHaveLength(history + 1);
      }
    });
  }
});
