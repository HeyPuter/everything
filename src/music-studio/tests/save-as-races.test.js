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
    expect(save).toHaveBeenCalledWith(expect.any(String), 'Copy');
  });
});
