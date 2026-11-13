import { afterEach, expect, it, vi } from 'vitest';
import { ProjectFiles } from '../src/storage/files.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { downloadBlob } from '../src/io/download.js';

vi.mock('../src/io/download.js', async (original) => ({ ...await original(), downloadBlob: vi.fn() }));

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const closeDialogs = () => document.querySelectorAll('.dialog-head button').forEach((button) => button.click());
afterEach(() => { closeDialogs(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function setup(seen = false) {
  vi.stubGlobal('puter', undefined);
  const original = { ...newProject(), name: 'Original' };
  const values = new Map([['dismissedNotices', seen ? ['localSave'] : []]]);
  const app = { store: new Store(original), file: { local: 'original', name: 'Original' }, emit: vi.fn(), notify: vi.fn(), prefs: { get: (key) => values.get(key), set: (key, value) => values.set(key, value) } };
  const lib = { db: vi.fn(async () => ({ persistent: true })), saveLocal: vi.fn(async () => {}), exportFile: vi.fn(async () => ({ blob: new Blob(['saved']), missing: [], skipped: false })) };
  const files = new ProjectFiles(app, lib);
  const replace = () => {
    app.store.load({ ...newProject(), name: 'Replacement' });
    app.file = { local: 'replacement', name: 'Replacement' };
  };
  return { app, lib, files, original, replace };
}

it('does not show a save notice for a project replaced during the local write', async () => {
  const { files, lib, replace } = setup();
  const gate = deferred();
  lib.saveLocal.mockReturnValue(gate.promise);
  const notice = vi.spyOn(files, 'localSaveNotice').mockResolvedValue();
  const pending = files.saveLocalProject('original', 'Original');
  replace();
  gate.resolve();
  expect(await pending).toBe(true);
  expect(notice).not.toHaveBeenCalled();
});

it('does not open a late notice after replacement during the database lookup', async () => {
  const { files, lib, app, replace } = setup();
  const gate = deferred();
  lib.db.mockReturnValue(gate.promise);
  const pending = files.localSaveNotice();
  replace();
  gate.resolve({ persistent: true });
  await Promise.resolve();
  const showed = Boolean(document.querySelector('.save-notice'));
  closeDialogs();
  await pending;
  expect(showed).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
  expect(app.prefs.get('dismissedNotices')).toEqual([]);
});

it('closes the save notice on replacement without downloading the replacement', async () => {
  const { files, lib, replace } = setup();
  const pending = files.localSaveNotice();
  await vi.waitFor(() => expect(document.querySelector('.save-notice')).not.toBeNull());
  const button = [...document.querySelectorAll('.dialog button')].find((b) => b.textContent === 'Save to your device');
  replace();
  button.click();
  await pending;
  expect(lib.exportFile).not.toHaveBeenCalled();
  expect(document.querySelector('.save-notice')).toBeNull();
});

it('downloads the saved project from its toast even after another project opens', async () => {
  const { files, lib, app, original, replace } = setup(true);
  await files.localSaveNotice();
  const action = app.notify.mock.calls[0][1].action;
  replace();
  await action.run();
  expect(lib.exportFile.mock.calls[0][0]).toBe(original);
  expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'Original.msproj');
});

it('ignores a confirmed download if replacement precedes its continuation', async () => {
  const { files, lib, replace } = setup();
  const pending = files.localSaveNotice();
  await vi.waitFor(() => expect(document.querySelector('.save-notice')).not.toBeNull());
  [...document.querySelectorAll('.dialog button')].find((b) => b.textContent === 'Save to your device').click();
  replace();
  await pending;
  expect(lib.exportFile).not.toHaveBeenCalled();
});

it('offers the saved snapshot when edits arrive during a local write', async () => {
  const { files, lib, app, original } = setup(true);
  const gate = deferred();
  lib.saveLocal.mockReturnValue(gate.promise);
  const pending = files.saveLocalProject('original', 'Original');
  const savedView = { ...app.store.view };
  app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 99 }));
  app.store.view.pattern = 'later-selection';
  gate.resolve();
  await pending;
  await vi.waitFor(() => expect(app.notify).toHaveBeenCalled());
  await app.notify.mock.calls[0][1].action.run();
  expect(lib.exportFile.mock.calls[0][0]).toBe(original);
  expect(lib.saveLocal.mock.calls[0][1]).toEqual(savedView);
  expect(lib.exportFile.mock.calls[0][1]).toEqual(savedView);
  expect(app.store.project.bpm).toBe(99);
  expect(app.store.dirty).toBe(true);
});

it('keeps the notice usable across an unrelated edit', async () => {
  const { files, lib, app, original } = setup();
  const pending = files.localSaveNotice();
  await vi.waitFor(() => expect(document.querySelector('.save-notice')).not.toBeNull());
  app.store.apply('Mute track', (p) => E.updateTrack(p, 0, { mute: true }));
  [...document.querySelectorAll('.dialog button')].find((b) => b.textContent === 'Save to your device').click();
  await pending;
  expect(lib.exportFile.mock.calls[0][0]).toBe(original);
  expect(app.store.project.tracks[0].mute).toBe(true);
});
