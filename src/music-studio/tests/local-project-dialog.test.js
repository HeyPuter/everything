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
  const handlers = new WeakMap();
  const add = HTMLElement.prototype.addEventListener;
  vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (type, handler, ...options) {
    if (type === 'click' && this.matches('button[aria-label^="Delete "]')) handlers.set(this, handler);
    return add.call(this, type, handler, ...options);
  });
  dialogs.push(openLocalProjects(app));
  await vi.waitFor(() => expect(document.querySelector('.lp-list')).not.toBeNull());
  return { app, lib, project, db, handlers };
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

it('reports a failed deletion and leaves the saved project available for retry', async () => {
  const { app, lib, handlers } = await setup();
  const failure = new Error('Local storage could not delete the project');
  const original = lib.deleteLocal.bind(lib);
  const deleting = vi.spyOn(lib, 'deleteLocal').mockRejectedValueOnce(failure).mockImplementation(original);
  const button = document.querySelector('[aria-label="Delete Saved song"]');
  // Invoke the real event handler directly so the pre-fix rejection is observed, not unhandled.
  const first = handlers.get(button)(new MouseEvent('click')).catch((err) => err);
  document.querySelector('.dialog-backdrop:last-child [data-value="true"]').click();
  await first;
  expect(app.reportError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(document.querySelector('[aria-label="Delete Saved song"]')).not.toBeNull();
  expect(await lib.listLocal()).toHaveLength(1);
  const retry = handlers.get(button)(new MouseEvent('click'));
  document.querySelector('.dialog-backdrop:last-child [data-value="true"]').click();
  await retry;
  expect(deleting).toHaveBeenCalledTimes(2);
  expect(await lib.listLocal()).toEqual([]);
  expect(document.querySelector('.lp-row')).toBeNull();
});

it('keeps a successful deletion visible when refreshing the saved-project list fails', async () => {
  const { app, lib, handlers } = await setup();
  const failure = new Error('Could not refresh the project list');
  vi.spyOn(lib, 'listLocal').mockRejectedValueOnce(failure);
  const button = document.querySelector('[aria-label="Delete Saved song"]');
  const deleting = handlers.get(button)(new MouseEvent('click')).catch((err) => err);
  document.querySelector('.dialog-backdrop:last-child [data-value="true"]').click();
  await deleting;
  expect(app.reportError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(document.querySelector('.lp-row')).toBeNull();
  expect(document.querySelector('.lp-empty').hidden).toBe(false);
  expect(await lib.listLocal()).toEqual([]);
});
