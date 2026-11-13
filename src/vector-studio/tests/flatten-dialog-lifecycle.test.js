import { describe, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { Emitter } from '../src/lib/emitter.js';
import { flattenDialog, flattenSelection } from '../src/features/effects/flatten.js';
import { runGeom } from '../src/features/geometry/engine/index.js';

vi.mock('../src/features/geometry/engine/index.js', async (original) => ({ ...await original(), runGeom: vi.fn() }));
const result = () => [{ subpaths: [{ anchors: rectangle(0, 0, 40, 30), closed: true }], cover: [0] }];
const button = (dialog, label) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === label).click();
async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const node = createPath(rectangle(0, 0, 40, 30), true, { opacity: 0.5, fill: { type: 'solid', color: '#cc3333' }, stroke: null });
  ed.doc.transact('Artwork', () => ed.doc.insert(node, ed.targetLayer().id));
  ed.select([node.id]);
  app.collab ||= new Emitter();
  return { app, ed, node };
}

for (const mode of ['base dialog', 'menu command']) describe(`Flatten Transparency context: ${mode}`, () => {
  for (const change of ['document', 'close', 'selection', 'permission']) {
    it(`cancels the prompt after a ${change} change`, async () => {
      const { app, ed, node } = await setup();
      const pending = mode === 'base dialog' ? flattenDialog(app) : app.commands.run('object.flatten');
      const dialog = document.querySelector('dialog[open]');
      try {
        if (change === 'document') app.newDocument();
        if (change === 'close') await app.closeDocument(ed, { force: true });
        if (change === 'selection') ed.clearSelection();
        if (change === 'permission') { ed.doc.readOnly = true; app.collab.emit('role', ed); }
        expect(dialog.isConnected).toBe(false);
      } finally { button(dialog, 'Cancel'); await pending; }
      expect(ed.doc.get(node.id).opacity).toBe(0.5);
    });
  }
  for (const switchTab of [true, false]) {
    it(switchTab ? 'discards geometry after switching away and back' : 'applies unchanged artwork in one undo step', async () => {
      let finish;
      runGeom.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const { app, ed, node } = await setup();
      const pending = mode === 'base dialog' ? flattenDialog(app) : app.commands.run('object.flatten');
      const dialog = document.querySelector('dialog[open]');
      const history = ed.doc.undoStack.length;
      button(dialog, 'OK');
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      if (switchTab) { app.newDocument(); app.activate(ed); }
      finish(result());
      expect(await pending).toBe(!switchTab);
      if (switchTab) {
        expect(ed.doc.get(node.id).opacity).toBe(0.5);
        expect(ed.doc.undoStack).toHaveLength(history);
      } else {
        expect(ed.doc.has(node.id)).toBe(false);
        expect(ed.doc.undoStack).toHaveLength(history + 1);
        ed.doc.undo();
        expect(ed.doc.get(node.id).opacity).toBe(0.5);
      }
    });
  }
  it('does not join a newer transaction when geometry finishes', async () => {
    const { ed, node } = await setup();
    let finish;
    const pending = flattenSelection(ed, { balance: 75 }, { run: () => new Promise((resolve) => { finish = resolve; }) });
    const tx = ed.doc.begin('Newer edit');
    ed.doc.updateRoot({ name: 'Newer edit' });
    try {
      finish(result());
      expect((await pending).error).toBeTruthy();
      expect(ed.doc.get(node.id).opacity).toBe(0.5);
      expect(ed.doc.tx).toBe(tx);
      expect(ed.doc.root.name).toBe('Newer edit');
    } finally { tx.cancel(); }
  });
});
