import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { newWindow } from '../src/features/workspace/window.js';
import { serializeDocument } from '../src/features/files/format.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ name: 'Saved' });
  const bytes = await serializeDocument(ed.doc);
  const read = deferred();
  const getFile = vi.fn(() => read.promise);
  ed.file = { kind: 'local', name: 'Original.vstudio', handle: { getFile } };
  ed.doc.transact('Edit', () => ed.doc.updateRoot({ name: 'Edited' }));
  app.dialogs.confirm = async () => true;
  return { app, ed, getFile, read, bytes };
}
async function closeAll(app) {
  for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
}

it.each([false, true])('does not resurrect a closed Revert source (remaining shared window: %s)', async (shared) => {
  const { app, ed, getFile, read, bytes } = await setup();
  try {
    const sibling = shared ? newWindow(app, ed) : null;
    const background = app.newDocument({ name: 'Other' });
    const pending = app.files.service.revert(ed);
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
    await app.closeDocument(ed, { force: true });
    const open = [...app.editors];
    read.resolve(new Blob([bytes]));
    expect((await pending) === false).toBe(true);
    expect(app.editors.length).toBe(open.length);
    expect(app.editors.every((editor, index) => editor === open[index])).toBe(true);
    expect(app.editor === background).toBe(true);
    if (sibling) expect(sibling.doc.root.name).toBe('Edited');
  } finally {
    await closeAll(app);
  }
});

it('does not replace a document saved under another file while its old file is loading', async () => {
  const { app, ed, getFile, read, bytes } = await setup();
  const savePicker = window.showSaveFilePicker;
  const openPicker = window.showOpenFilePicker;
  window.showOpenFilePicker = async () => [];
  window.showSaveFilePicker = async () => ({
    name: 'New.vstudio',
    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
  });
  try {
    const pending = app.files.service.revert(ed);
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
    expect(await app.files.service.saveAs(ed)).toBe(true);
    expect(ed.file.name).toBe('New.vstudio');
    read.resolve(new Blob([bytes]));
    expect((await pending) === false).toBe(true);
    expect(app.editor === ed).toBe(true);
    expect(ed.file.name).toBe('New.vstudio');
    expect(ed.doc.root.name).toBe('Edited');
    expect(ed.doc.dirty).toBe(false);
  } finally {
    window.showSaveFilePicker = savePicker;
    window.showOpenFilePicker = openPicker;
    await closeAll(app);
  }
});


it('does not start reading if the editor closes while confirmation is pending', async () => {
  const { app, ed, getFile } = await setup();
  const confirmation = deferred();
  app.dialogs.confirm = () => confirmation.promise;
  try {
    const pending = app.files.service.revert(ed);
    await app.closeDocument(ed, { force: true });
    confirmation.resolve(true);
    expect((await pending) === false).toBe(true);
    expect(getFile).not.toHaveBeenCalled();
    expect(app.editors).toHaveLength(0);
  } finally {
    await closeAll(app);
  }
});

it('does not display a stale read error after its editor closes', async () => {
  const { app, ed, getFile, read } = await setup();
  app.dialogs.alert = vi.fn(async () => {});
  try {
    const pending = app.files.service.revert(ed);
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
    await app.closeDocument(ed, { force: true });
    read.reject(new Error('Read failed'));
    expect((await pending) === false).toBe(true);
    expect(app.dialogs.alert).not.toHaveBeenCalled();
    expect(app.editors).toHaveLength(0);
  } finally {
    await closeAll(app);
  }
});

it.each(['read', 'parse'])('still reports a %s error for an open, unchanged editor', async (failure) => {
  const { app, ed, getFile, read } = await setup();
  app.dialogs.alert = vi.fn(async () => {});
  try {
    const pending = app.files.service.revert(ed);
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
    if (failure === 'read') read.reject(new Error('Read failed'));
    else read.resolve(new Blob(['not a document']));
    expect((await pending) === false).toBe(true);
    expect(app.dialogs.alert).toHaveBeenCalledOnce();
    expect(app.editor === ed).toBe(true);
    expect(ed.doc.root.name).toBe('Edited');
  } finally {
    await closeAll(app);
  }
});
