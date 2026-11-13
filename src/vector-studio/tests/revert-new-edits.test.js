import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { serializeDocument } from '../src/features/files/format.js';

it.each(['committed edit', 'unfinished edit', 'comment'])('preserves a newer %s made while the saved file is loading', async (kind) => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ name: 'Saved' });
  const bytes = await serializeDocument(ed.doc);
  let finishRead;
  const read = new Promise((resolve) => { finishRead = resolve; });
  const getFile = vi.fn(() => read);
  ed.file = { kind: 'local', name: 'Artwork.vstudio', handle: { getFile } };
  ed.doc.transact('Edit', () => ed.doc.updateRoot({ name: 'Edited' }));
  app.dialogs.confirm = async () => true;
  app.notify = vi.fn();
  let tx;
  try {
    const pending = app.files.service.revert(ed);
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
    if (kind === 'committed edit') ed.doc.transact('Newer edit', () => ed.doc.updateRoot({ name: 'Newer' }));
    if (kind === 'unfinished edit') {
      tx = ed.doc.begin('Newer drag');
      ed.doc.updateRoot({ name: 'Newer' });
    }
    if (kind === 'comment') app.comments.addThread('Keep this comment', { x: 10, y: 10 });
    finishRead(new Blob([bytes]));
    expect((await pending) === false).toBe(true);
    expect(app.editor === ed).toBe(true);
    expect(app.editors).toHaveLength(1);
    if (kind === 'comment') expect(JSON.stringify(ed.doc.comments)).toContain('Keep this comment');
    else expect(ed.doc.root.name).toBe('Newer');
    if (tx) expect(ed.doc.tx === tx).toBe(true);
    expect(app.notify).toHaveBeenCalledWith(expect.stringMatching(/Revert.*changed/i), expect.any(Object));
  } finally {
    tx?.cancel();
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});

it('still reverts after changing only the viewport and view options while loading', async () => {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ name: 'Saved' });
  const bytes = await serializeDocument(ed.doc);
  let finishRead;
  const read = new Promise((resolve) => { finishRead = resolve; });
  const getFile = vi.fn(() => read);
  ed.file = { kind: 'local', name: 'Artwork.vstudio', handle: { getFile } };
  ed.doc.transact('Edit', () => ed.doc.updateRoot({ name: 'Edited' }));
  app.dialogs.confirm = async () => true;
  try {
    const pending = app.files.service.revert(ed);
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
    ed.view.set({ zoom: 4 });
    ed.setViewOption('grid', true);
    finishRead(new Blob([bytes]));
    const reverted = await pending;
    expect(reverted !== false).toBe(true);
    expect(reverted.doc.root.name).toBe('Saved');
    expect(reverted.view.zoom).toBe(4);
    expect(reverted.viewOptions.grid).toBe(true);
  } finally {
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});
