import { expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { newWindow } from '../src/features/workspace/window.js';
import { serializeDocument } from '../src/features/files/format.js';

async function closeAll(app) {
  for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
}

it('keeps each shared window view settings and active artboard when reverting content', async () => {
  const app = await bootAppWithFeatures();
  try {
    const first = app.newDocument({ name: 'Artwork' });
    first.doc.transact('Artboards', () => first.doc.updateRoot({ artboards: [
      { x: 0, y: 0, w: 200, h: 200, name: 'One' },
      { x: 250, y: 0, w: 200, h: 200, name: 'Two' },
    ] }));
    const bytes = await serializeDocument(first.doc);
    first.file = { kind: 'local', name: 'Artwork.vstudio', handle: { getFile: async () => new Blob([bytes]) } };
    const second = newWindow(app, first);
    first.setViewOption('mode', 'outline');
    first.setViewOption('grid', true);
    first.setViewOption('snapToGrid', true);
    first.setActiveArtboard(1);
    first.view.set({ zoom: 2, panX: 40, panY: 60, rotation: 25 });
    second.setViewOption('pixelPreview', true);
    second.setViewOption('rulers', false);
    second.setViewOption('overprint', true);
    second.view.set({ zoom: 3, panX: 80, panY: 90, rotation: 45 });
    const expected = [first, second].map((ed) => ({ options: { ...ed.viewOptions }, board: ed.activeArtboard, view: ed.view.snapshot() }));
    first.doc.transact('Rename', () => first.doc.updateRoot({ name: 'Unsaved' }));
    app.dialogs.confirm = async () => true;
    const active = await app.files.service.revert(second);
    expect(active.doc.root.name).toBe('Artwork');
    expect(active.doc.dirty).toBe(false);
    expect(app.editor === active).toBe(true);
    for (const [index, ed] of app.editors.entries()) {
      expect.soft(ed.viewOptions).toEqual(expected[index].options);
      expect.soft(ed.activeArtboard).toBe(expected[index].board);
      expect.soft(ed.view.snapshot()).toEqual(expected[index].view);
    }
  } finally {
    await closeAll(app);
  }
});

it('clamps an active artboard removed by reverting to the saved document', async () => {
  const app = await bootAppWithFeatures();
  try {
    const ed = app.newDocument();
    const bytes = await serializeDocument(ed.doc);
    ed.file = { kind: 'local', name: 'Artwork.vstudio', handle: { getFile: async () => new Blob([bytes]) } };
    ed.doc.transact('Add artboard', () => ed.doc.updateRoot({ artboards: [...ed.doc.artboards, { x: 250, y: 0, w: 200, h: 200, name: 'Unsaved' }] }));
    ed.setActiveArtboard(1);
    app.dialogs.confirm = async () => true;
    const reverted = await app.files.service.revert(ed);
    expect(reverted.doc.artboards).toHaveLength(1);
    expect(reverted.activeArtboard).toBe(0);
  } finally {
    await closeAll(app);
  }
});
