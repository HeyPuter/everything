import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';

it('updates the surviving window title when the document is saved after its first window closes', async () => {
  const app = await bootAppWithFeatures();
  const first = app.newDocument({ name: 'Artwork' });
  await app.commands.run('window.newWindow');
  const second = app.editor;
  const createURL = URL.createObjectURL;
  URL.createObjectURL = () => 'blob:test';
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    await app.closeDocument(first, { force: true });
    expect(await app.files.service.save(second)).toBe(true);
    expect(second.file.name).toBe('Artwork.vstudio');
    expect(second.name).toBe('Artwork.vstudio:2');
    expect(app.tabsEl.textContent).toContain('Artwork.vstudio:2');
  } finally {
    click.mockRestore();
    URL.createObjectURL = createURL;
    for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
  }
});

it('uses the new file name after reverting and saving a surviving window as another file', async () => {
  const { serializeDocument } = await import('../src/features/files/format.js');
  const app = await bootAppWithFeatures();
  const first = app.newDocument({ name: 'Original' });
  const bytes = await serializeDocument(first.doc);
  first.file = { kind: 'local', name: 'Original.vstudio', handle: { getFile: async () => new Blob([bytes]) } };
  await app.commands.run('window.newWindow');
  const second = app.editor;
  await app.closeDocument(first, { force: true });
  second.doc.transact('Rename', () => second.doc.updateRoot({ name: 'Edited' }));
  app.dialogs.confirm = async () => true;
  const savePicker = window.showSaveFilePicker;
  const openPicker = window.showOpenFilePicker;
  window.showOpenFilePicker = async () => [];
  window.showSaveFilePicker = async () => ({
    name: 'Renamed.vstudio',
    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
  });
  try {
    const reverted = await app.files.service.revert(second);
    expect(reverted.name).toBe('Original.vstudio:2');
    expect(await app.files.service.saveAs(reverted)).toBe(true);
    expect(reverted.file.name).toBe('Renamed.vstudio');
    expect(reverted.name).toBe('Renamed.vstudio:2');
    expect(app.tabsEl.textContent).toContain('Renamed.vstudio:2');
  } finally {
    window.showSaveFilePicker = savePicker;
    window.showOpenFilePicker = openPicker;
    for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
  }
});
