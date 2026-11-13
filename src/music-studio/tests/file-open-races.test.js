import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProjectFiles } from '../src/storage/files.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function setup() {
  vi.stubGlobal('puter', { auth: { isSignedIn: () => true } });
  const app = {
    store: new Store(newProject()), file: null,
    samples: { ids: () => [], delete() {} }, engine: { stop() {} },
    prefs: { get: () => [], set() {} }, emit() {}, notify: vi.fn(),
  };
  const gate = deferred();
  const lib = {
    loadCloud: vi.fn(() => gate.promise),
    listLocal: async () => [],
    loadLocal: vi.fn(() => gate.promise),
    readProjectText: vi.fn(() => gate.promise),
  };
  const files = new ProjectFiles(app, lib);
  const confirm = vi.spyOn(files, 'confirmDiscard').mockResolvedValue(true);
  const open = (kind) => kind === 'cloud' ? files.openPath('/A.msproj') : kind === 'local' ? files.openLocalKey('a') : files.openFile({
    name: 'A.msproj', size: 10,
    slice: () => ({ arrayBuffer: async () => new ArrayBuffer(4) }), text: async () => '{}',
  });
  const read = (kind) => kind === 'cloud' ? lib.loadCloud : kind === 'local' ? lib.loadLocal : lib.readProjectText;
  return { app, files, lib, gate, confirm, open, read };
}

afterEach(() => vi.unstubAllGlobals());

describe('opening projects asynchronously', () => {
  it.each(['cloud', 'local', 'device'])('does not replace a newer document when an old %s open finishes', async (kind) => {
    const { app, gate, open, read } = setup();
    const pending = open(kind);
    await vi.waitFor(() => expect(read(kind)).toHaveBeenCalled());
    const newer = newProject();
    app.store.load(newer);
    gate.resolve({ ...newProject(), name: 'Old open' });
    expect(await pending).toBe(false);
    expect(app.store.project === newer).toBe(true);
    expect(app.file).toBeNull();
  });

  it.each(['cloud', 'local'])('asks again before discarding edits made during a %s read', async (kind) => {
    const { app, gate, confirm, open, read } = setup();
    confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const pending = open(kind);
    await vi.waitFor(() => expect(read(kind)).toHaveBeenCalled());
    app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 99 }));
    const edited = app.store.project;
    gate.resolve(newProject());
    expect(await pending).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(app.store.project === edited).toBe(true);
    expect(app.store.dirty).toBe(true);
  });

  it('lets a newer open finish first without the older open replacing it', async () => {
    const { app, files, lib, gate } = setup();
    const older = files.openPath('/A.msproj');
    await vi.waitFor(() => expect(lib.loadCloud).toHaveBeenCalled());
    const newer = { ...newProject(), name: 'B' };
    lib.loadCloud.mockResolvedValueOnce(newer);
    expect(await files.openPath('/B.msproj')).toBe(true);
    gate.resolve(newProject());
    expect(await older).toBe(false);
    expect(app.store.project === newer).toBe(true);
    expect(app.file.path).toBe('/B.msproj');
  });

  it('supersedes an older request as soon as a newer open starts', async () => {
    const { app, files, lib, gate } = setup();
    const start = app.store.project;
    const older = files.openPath('/A.msproj');
    await vi.waitFor(() => expect(lib.loadCloud).toHaveBeenCalledTimes(1));
    const next = deferred();
    lib.loadCloud.mockReturnValueOnce(next.promise);
    const newer = files.openPath('/B.msproj');
    await vi.waitFor(() => expect(lib.loadCloud).toHaveBeenCalledTimes(2));
    gate.resolve(newProject());
    expect(await older).toBe(false);
    expect(app.store.project === start).toBe(true);
    next.resolve({ ...newProject(), name: 'B' });
    expect(await newer).toBe(true);
    expect(app.file.path).toBe('/B.msproj');
  });

  it('still opens when the user approves discarding edits made during the read', async () => {
    const { app, gate, confirm, open, read } = setup();
    const pending = open('cloud');
    await vi.waitFor(() => expect(read('cloud')).toHaveBeenCalled());
    app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 99 }));
    const next = newProject();
    gate.resolve(next);
    expect(await pending).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(app.store.project === next).toBe(true);
  });
});
