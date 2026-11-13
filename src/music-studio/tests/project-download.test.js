import { it, expect, vi } from 'vitest';
import { ProjectFiles } from '../src/storage/files.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';
import { downloadBlob } from '../src/io/download.js';

vi.mock('../src/io/download.js', async (original) => ({ ...await original(), downloadBlob: vi.fn() }));

it('keeps the filename of the project whose samples are being bundled', async () => {
  let finish;
  const exportFile = vi.fn(() => new Promise((r) => { finish = r; }));
  const original = { ...newProject(), name: 'Original' };
  const app = { store: new Store(original), file: { name: 'Original' }, notify: vi.fn() };
  const files = new ProjectFiles(app, { exportFile });
  const pending = files.download();
  app.store.load({ ...newProject(), name: 'New project' });
  app.file = { name: 'New project' };
  const blob = new Blob(['original project']);
  finish({ blob, missing: [], skipped: false });
  await pending;
  expect(exportFile.mock.calls[0][0]).toBe(original);
  expect(downloadBlob).toHaveBeenCalledWith(blob, 'Original.msproj');
});
