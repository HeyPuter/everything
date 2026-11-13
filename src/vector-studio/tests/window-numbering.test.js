import { expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { newWindow } from '../src/features/workspace/window.js';
import { serializeDocument } from '../src/features/files/format.js';

async function closeAll(app) {
  for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
}

it('keeps shared-window names distinct after an earlier window closes', async () => {
  const app = await bootAppWithFeatures();
  try {
    const first = app.newDocument({ name: 'Artwork' });
    const second = newWindow(app, first);
    const third = newWindow(app, second);
    expect([first.name, second.name, third.name]).toEqual(['Artwork', 'Artwork:2', 'Artwork:3']);
    await app.closeDocument(second, { force: true });
    const fourth = newWindow(app, third);
    expect(fourth.name).toBe('Artwork:4');
    expect(new Set(app.editors.map((ed) => ed.name)).size).toBe(app.editors.length);
    // A different document starts its own window numbers.
    const independent = app.newDocument({ name: 'Other' });
    expect(newWindow(app, independent).name).toBe('Other:2');
  } finally {
    await closeAll(app);
  }
});

it('keeps numbering distinct after the original window closes and the document is reverted', async () => {
  const app = await bootAppWithFeatures();
  try {
    const first = app.newDocument({ name: 'Artwork' });
    const bytes = await serializeDocument(first.doc);
    first.file = { kind: 'local', name: 'Artwork.vstudio', handle: { getFile: async () => new Blob([bytes]) } };
    const second = newWindow(app, first);
    await app.closeDocument(first, { force: true });
    second.doc.transact('Rename', () => second.doc.updateRoot({ name: 'Edited' }));
    app.dialogs.confirm = async () => true;
    const reverted = await app.files.service.revert(second);
    expect(reverted.name).toBe('Artwork.vstudio:2');
    expect(newWindow(app, reverted).name).toBe('Artwork.vstudio:3');
  } finally {
    await closeAll(app);
  }
});
