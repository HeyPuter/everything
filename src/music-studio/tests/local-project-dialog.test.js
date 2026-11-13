import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Library } from '../src/storage/library.js';
import { ProjectFiles } from '../src/storage/files.js';
import { memoryDB } from '../src/storage/idb.js';
import { newProject } from '../src/model/demo.js';
import { openLocalProjects } from '../src/dialogs/open-local.js';
import { downloadBlob } from '../src/io/download.js';

vi.mock('../src/io/download.js', async (original) => ({ ...await original(), downloadBlob: vi.fn() }));
const dialogs = [];
afterEach(async () => {
  document.querySelectorAll('.dialog-head button').forEach((button) => button.click());
  await Promise.all(dialogs.splice(0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

async function setup({ missing = false } = {}) {
  vi.stubGlobal('puter', undefined);
  const db = memoryDB();
  db.persistent = true;
  const lib = new Library({ db, puter: { isSignedIn: () => false } });
  const project = { ...newProject(), name: 'Saved song', samples: missing ? { missing: { id: 'missing', name: 'missing.wav' } } : {} };
  await lib.saveLocal(project, {}, { key: 'saved', name: 'Saved song' });
  const app = new App(document.createElement('div'), { storage: { getItem: () => null, setItem() {} } });
  app.library = lib;
  app.files = new ProjectFiles(app, lib);
  app.notify = vi.fn();
  app.reportError = vi.fn();
  dialogs.push(openLocalProjects(app));
  await vi.waitFor(() => expect(document.querySelector('.lp-list')).not.toBeNull());
  return { app, lib, project, db };
}

it.each(['missing', 'oversize'])('warns when a saved-project download omits %s samples', async (reason) => {
  const { app, lib } = await setup({ missing: reason === 'missing' });
  if (reason === 'oversize') vi.spyOn(lib, 'exportFile').mockResolvedValue({ blob: new Blob(['bounded size-limit response']), missing: [], skipped: true });
  document.querySelector('[aria-label="Download Saved song"]').click();
  await vi.waitFor(() => expect(downloadBlob).toHaveBeenCalledOnce());
  expect(app.notify).toHaveBeenCalledWith(
    reason === 'missing' ? 'Downloaded without one missing sample.' : 'Downloaded. Some samples were too large to include in the file.',
    { error: true },
  );
  expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'Saved song.msproj');
});

it('downloads the selected saved project even if the open project changes during the read', async () => {
  const { app, lib, project } = await setup();
  let release;
  vi.spyOn(lib, 'loadLocal').mockReturnValue(new Promise((resolve) => { release = resolve; }));
  document.querySelector('[aria-label="Download Saved song"]').click();
  app.store.load({ ...newProject(), name: 'Replacement', bpm: 150 });
  app.file = { local: 'replacement', name: 'Replacement' };
  release(project);
  await vi.waitFor(() => expect(downloadBlob).toHaveBeenCalledOnce());
  const [blob, name] = downloadBlob.mock.calls[0];
  expect(name).toBe('Saved song.msproj');
  expect(JSON.parse(await blob.text()).name).toBe('Saved song');
  expect(app.notify.mock.calls.some(([, options]) => options?.error)).toBe(false);
});
