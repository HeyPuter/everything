import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProjectFiles } from '../src/storage/files.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { promptDialog, confirmDialog } from '../src/ui/dialog.js';

vi.mock('../src/ui/dialog.js', () => ({ promptDialog: vi.fn(), confirmDialog: vi.fn(), openDialog: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe('save as after switching projects', () => {
  it.each(['name', 'idle', 'path', 'replace'])('does not rename or save the new project after waiting for %s', async (stage) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    promptDialog.mockReturnValue(stage === 'name' ? gate : Promise.resolve('Copy'));
    confirmDialog.mockReturnValue(stage === 'replace' ? gate : Promise.resolve(true));
    vi.stubGlobal('puter', { auth: { isSignedIn: () => true }, fs: { stat: async () => ({}) } });
    const app = { store: new Store(newProject()), file: null };
    const lib = { cloudPathFor: vi.fn(() => stage === 'path' ? gate : Promise.resolve('/Copy.msproj')) };
    const files = new ProjectFiles(app, lib);
    const idle = vi.spyOn(files, 'whenIdle').mockReturnValue(stage === 'idle' ? gate : Promise.resolve());
    const save = vi.spyOn(files, 'saveCloudTo').mockResolvedValue(true);
    const pending = files.saveAs();
    const reached = { name: promptDialog, idle, path: lib.cloudPathFor, replace: confirmDialog }[stage];
    await vi.waitFor(() => expect(reached).toHaveBeenCalled());
    const newer = { ...newProject(), name: 'New project' };
    app.store.load(newer);
    release(stage === 'name' ? 'Copy' : stage === 'path' ? '/Copy.msproj' : true);
    expect(await pending).toBe(false);
    expect(app.store.project === newer).toBe(true);
    expect(app.store.canUndo).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('includes edits made in the same project while choosing a name', async () => {
    let release;
    promptDialog.mockReturnValue(new Promise((r) => { release = r; }));
    vi.stubGlobal('puter', { auth: { isSignedIn: () => false } });
    const app = { store: new Store(newProject()), file: null };
    const files = new ProjectFiles(app, {});
    const save = vi.spyOn(files, 'saveLocalProject').mockResolvedValue(true);
    const pending = files.saveAs();
    app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 99 }));
    release('Copy');
    expect(await pending).toBe(true);
    expect(app.store.project).toMatchObject({ name: 'Copy', bpm: 99 });
    expect(save).toHaveBeenCalledWith(undefined, 'Copy');
  });
});

it('waits for an autosave that starts during cloud path lookup before saving the new copy', async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };
  const path = deferred();
  const oldWrite = deferred();
  const newWrite = deferred();
  promptDialog.mockResolvedValue('Copy');
  vi.stubGlobal('puter', { auth: { isSignedIn: () => true }, fs: { stat: async () => { throw new Error('Not found'); } } });
  const { Emitter } = await import('../src/lib/emitter.js');
  const app = new Emitter();
  const values = {};
  Object.assign(app, { store: new Store(newProject()), file: { path: '/Original.msproj', name: 'Original' }, notify: vi.fn(), prefs: { get: (k) => values[k], set: (k, v) => { values[k] = v; } } });
  const lib = { cloudPathFor: vi.fn(() => path.promise), saveCloud: vi.fn().mockReturnValueOnce(oldWrite.promise).mockReturnValueOnce(newWrite.promise) };
  const files = new ProjectFiles(app, lib);
  const copy = files.saveAs();
  await vi.waitFor(() => expect(lib.cloudPathFor).toHaveBeenCalled());
  const auto = files.save({ auto: true });
  expect(lib.saveCloud).toHaveBeenCalledTimes(1);
  path.resolve('/Copy.msproj');
  await new Promise((r) => setTimeout(r, 0));
  const overlapped = lib.saveCloud.mock.calls.length > 1;
  oldWrite.resolve({ path: '/Original.msproj', missing: [] });
  await auto;
  await vi.waitFor(() => expect(lib.saveCloud).toHaveBeenCalledTimes(2));
  const savingDuringCopy = app.saving;
  newWrite.resolve({ path: '/Copy.msproj', missing: [] });
  await copy;
  expect(overlapped).toBe(false);
  expect(savingDuringCopy).toBe(true);
  expect(app.file.path).toBe('/Copy.msproj');
});
