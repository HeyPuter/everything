// @vitest-environment happy-dom
// Puter files: launches from the Puter desktop, Puter's Open and Save dialogs, drops from a Puter
// folder window, saving a Puter file back in place, and the download outside Puter.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { fileEvents, registerFormat, saveFile } from '../../src/io/files';
import { encodeDocument } from '../../src/io/native';
import { writeBlend } from '../../src/io/blend/write/writer';
import { installPuterFiles, openDriveItems, openLaunchItems, openPuterPath, pickFromPuter, type DriveItem } from '../../src/io/puterfiles';
import { PUTER_LOADED } from '../../src/assistant/puter';
import { captureMenuItems } from '../../src/ui/menu';
import '../../src/library/ops';

const imported: { name: string; bytes: string }[] = [];
registerFormat({
  id: 'zz_puter_test',
  label: 'Test Format',
  extensions: ['.zzmodel'],
  import: async (file) => {
    imported.push({ name: file.name, bytes: new TextDecoder().decode(await file.arrayBuffer()) });
  },
  handlesUndo: true,
});

/** A .blend file this app saved, whose scene ends at `frameEnd` (to tell files apart). */
function project(frameEnd: number) {
  const doc = startupDocument();
  doc.scene.frame_end = frameEnd;
  return writeBlend(doc, { embed: encodeDocument(doc) }).bytes;
}

interface Stub {
  env: string;
  drive: Map<string, Uint8Array>;
  ui: {
    onLaunchedWithItems: ReturnType<typeof vi.fn>;
    onItemsOpened: ReturnType<typeof vi.fn>;
    showOpenFilePicker: ReturnType<typeof vi.fn>;
    showSaveFilePicker: ReturnType<typeof vi.fn>;
  };
  fs: { read: Mock<(path: string) => Promise<Blob>>; write: Mock<(path: string, blob: Blob, opts?: unknown) => Promise<unknown>> };
}

/** A Puter SDK that, as the real one does, hands the launch items to every launch handler when it is registered. */
function installSdk({ env = 'app', launch = [] as DriveItem[] } = {}): Stub {
  const drive = new Map<string, Uint8Array>();
  const stub: Stub = {
    env,
    drive,
    ui: {
      onLaunchedWithItems: vi.fn((cb: (items: DriveItem[]) => void) => launch.length && cb(launch)),
      onItemsOpened: vi.fn((cb: (items: DriveItem[]) => void) => launch.length && cb(launch)),
      showOpenFilePicker: vi.fn(),
      showSaveFilePicker: vi.fn(),
    },
    fs: {
      read: vi.fn(async (path: string) => {
        const b = drive.get(path);
        if (!b) throw { error: { message: 'Subject does not exist' } };
        return new Blob([b as Uint8Array<ArrayBuffer>]);
      }),
      write: vi.fn(async (path: string, blob: Blob) => {
        drive.set(path, new Uint8Array(await blob.arrayBuffer()));
        return { name: path.split('/').pop(), path };
      }),
    },
  };
  (globalThis as unknown as { puter?: unknown }).puter = stub;
  return stub;
}

/** A launch item or picked file: it reads itself. */
const fsItem = (stub: Stub, path: string, extra: Partial<DriveItem> = {}): DriveItem => ({ name: path.split('/').pop(), path, read: vi.fn(() => stub.fs.read(path)), ...extra });

/** A picker promise that never settles on cancel, with the SDK's undefinedOnCancel. */
function cancelled() {
  const p = new Promise<never>(() => {}) as Promise<never> & { undefinedOnCancel?: Promise<undefined> };
  p.undefinedOnCancel = Promise.resolve(undefined);
  return p;
}
/** A picker that answers with `value`. */
function answered<T>(value: T) {
  const p = Promise.resolve(value) as Promise<T> & { undefinedOnCancel?: Promise<T | undefined> };
  p.undefinedOnCancel = p;
  return p;
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const messages = () => app.reports.map((r) => `${r.type}: ${r.message}`);

let clicks: string[] = [];
beforeEach(() => {
  setApp(new App(startupDocument()));
  fileEvents.saveTarget = null;
  imported.length = 0;
  sessionStorage.clear();
  clicks = [];
  // downloads click an <a download>; file pickers click an <input type=file>
  vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
    clicks.push(this instanceof HTMLAnchorElement ? `download ${this.download}` : `${this.tagName.toLowerCase()} ${(this as HTMLInputElement).type}`);
  });
});
afterEach(() => {
  delete (globalThis as unknown as { puter?: unknown }).puter;
  vi.restoreAllMocks();
});

describe('launch from the Puter desktop', () => {
  it('opens a double-clicked file once, and Save writes it back in place', async () => {
    const stub = installSdk({ launch: [] });
    stub.drive.set('/u/Desktop/robot.blend', project(91));
    const item = fsItem(stub, '/u/Desktop/robot.blend');
    stub.ui.onLaunchedWithItems.mockImplementation((cb: (items: DriveItem[]) => void) => cb([item]));
    stub.ui.onItemsOpened.mockImplementation((cb: (items: DriveItem[]) => void) => cb([item]));
    installPuterFiles(Promise.resolve());
    await settle();
    // the deprecated handler would get the same items: it is not used
    expect(stub.ui.onItemsOpened).not.toHaveBeenCalled();
    expect(item.read).toHaveBeenCalledTimes(1);
    expect(app.filename).toBe('robot.blend');
    expect(app.doc.scene.frame_end).toBe(91);
    expect(openPuterPath()).toBe('/u/Desktop/robot.blend');
    expect(app.dirty).toBe(false);

    app.doc.scene.frame_end = 120;
    app.changed('doc');
    saveFile();
    await settle();
    expect(stub.fs.write).toHaveBeenCalledTimes(1);
    expect(stub.fs.write.mock.calls[0][0]).toBe('/u/Desktop/robot.blend');
    expect(stub.fs.write.mock.calls[0][2]).toMatchObject({ overwrite: true });
    expect(stub.ui.showSaveFilePicker).not.toHaveBeenCalled();
    expect(clicks).toEqual([]);
    expect(app.dirty).toBe(false);
    expect(messages().at(-1)).toBe('INFO: Saved "robot.blend"');
  });

  it('registers once the SDK arrives after the app started, also in a browser tab the desktop opened', async () => {
    installPuterFiles(Promise.resolve());
    const stub = installSdk({ env: 'web' });
    stub.drive.set('/u/scene.blend', project(33));
    stub.ui.onLaunchedWithItems.mockImplementation((cb: (items: DriveItem[]) => void) => cb([fsItem(stub, '/u/scene.blend')]));
    dispatchEvent(new Event(PUTER_LOADED));
    dispatchEvent(new Event(PUTER_LOADED));
    await settle();
    expect(stub.ui.onLaunchedWithItems).toHaveBeenCalledTimes(1);
    expect(app.filename).toBe('scene.blend');
    expect(app.doc.scene.frame_end).toBe(33);
  });

  it('waits for the recovered session before opening', async () => {
    const stub = installSdk();
    stub.drive.set('/u/a.blend', project(44));
    stub.ui.onLaunchedWithItems.mockImplementation((cb: (items: DriveItem[]) => void) => cb([fsItem(stub, '/u/a.blend')]));
    let recovered: () => void = () => {};
    installPuterFiles(new Promise<void>((r) => (recovered = r)));
    await settle();
    expect(stub.fs.read).not.toHaveBeenCalled();
    recovered();
    await settle();
    expect(app.filename).toBe('a.blend');
  });

  it('skips folders and says so', async () => {
    const stub = installSdk();
    await openLaunchItems([{ name: 'Models', path: '/u/Models', is_dir: true }]);
    expect(stub.fs.read).not.toHaveBeenCalled();
    expect(messages().at(-1)).toMatch(/^WARNING: Folders cannot be opened/);
    expect(app.filename).toBe('untitled.blend');
  });

  it('does not read a file no format reads', async () => {
    const stub = installSdk();
    const item = fsItem(stub, '/u/notes.txt');
    await openLaunchItems([item]);
    expect(item.read).not.toHaveBeenCalled();
    expect(messages().at(-1)).toBe('ERROR: Cannot open "notes.txt": no format reads this type of file');
  });

  it('reports a file that cannot be read and keeps the current file', async () => {
    const stub = installSdk();
    const keep = { name: 'mine.blend', write: async () => {} };
    fileEvents.saveTarget = keep;
    await openLaunchItems([fsItem(stub, '/u/gone.blend')]);
    expect(messages().at(-1)).toBe('ERROR: Cannot open "gone.blend": Subject does not exist');
    expect(fileEvents.saveTarget).toBe(keep);
    // a damaged file does not take over Save either
    stub.drive.set('/u/bad.blend', project(1).slice(0, 40));
    await openLaunchItems([fsItem(stub, '/u/bad.blend')]);
    expect(messages().at(-1)).toMatch(/^ERROR: Cannot open "bad.blend"/);
    expect(fileEvents.saveTarget).toBe(keep);
  });

  it('opens a file once when it is opened twice at the same time, and not again while it is open', async () => {
    const stub = installSdk();
    stub.drive.set('/u/twice.blend', project(55));
    const opened: string[] = [];
    fileEvents.opened.push((name) => opened.push(name));
    try {
      await Promise.all([openLaunchItems([fsItem(stub, '/u/twice.blend')]), openDriveItems([fsItem(stub, '/u/twice.blend')])]);
      expect(stub.fs.read).toHaveBeenCalledTimes(1);
      expect(opened).toEqual(['twice.blend']);
      await openDriveItems([fsItem(stub, '/u/twice.blend')]);
      expect(stub.fs.read).toHaveBeenCalledTimes(1);
      expect(messages().at(-1)).toBe('INFO: "twice.blend" is already open');
    } finally {
      fileEvents.opened.pop();
    }
  });

  it('does not open a launch again after a reload brought the recovered file back', async () => {
    const stub = installSdk();
    stub.drive.set('/u/kept.blend', project(66));
    await openLaunchItems([fsItem(stub, '/u/kept.blend')]);
    expect(stub.fs.read).toHaveBeenCalledTimes(1);
    // reload: the recovered session is that file, with edits; the save target is gone
    fileEvents.saveTarget = null;
    app.doc.scene.frame_end = 77;
    await openLaunchItems([fsItem(stub, '/u/kept.blend')]);
    expect(stub.fs.read).toHaveBeenCalledTimes(1);
    expect(app.doc.scene.frame_end).toBe(77);
    expect(openPuterPath()).toBe('/u/kept.blend');
  });
});

describe("Puter's Open dialog", () => {
  it('File ▸ Open inside the desktop opens the picked file, and Save writes back to it', async () => {
    const stub = installSdk();
    stub.drive.set('/u/Documents/car.blend', project(12));
    stub.ui.showOpenFilePicker.mockReturnValue(answered(fsItem(stub, '/u/Documents/car.blend')));
    app.run('wm.open_mainfile', {}, { invoke: true });
    await settle();
    const opts = stub.ui.showOpenFilePicker.mock.calls[0][0];
    expect(opts.multiple).toBe(false);
    expect(opts.accept).toEqual(expect.arrayContaining(['.blend', '.zzmodel']));
    expect(clicks).toEqual([]);
    expect(app.filename).toBe('car.blend');
    expect(app.doc.scene.frame_end).toBe(12);
    saveFile();
    await settle();
    expect(stub.fs.write.mock.calls[0][0]).toBe('/u/Documents/car.blend');
  });

  it('does nothing when it is cancelled', async () => {
    const stub = installSdk();
    stub.ui.showOpenFilePicker.mockReturnValue(cancelled());
    const doc = app.doc;
    app.run('wm.open_mainfile', {}, { invoke: true });
    await settle();
    expect(app.doc).toBe(doc);
    expect(stub.fs.read).not.toHaveBeenCalled();
    expect(app.reports.filter((r) => r.type === 'ERROR')).toEqual([]);
  });

  it('is offered next to the device picker outside the desktop', async () => {
    const stub = installSdk({ env: 'web' });
    app.run('wm.open_mainfile', {}, { invoke: true });
    expect(clicks).toEqual(['input file']);
    expect(stub.ui.showOpenFilePicker).not.toHaveBeenCalled();
    stub.ui.showOpenFilePicker.mockReturnValue(cancelled());
    app.run('wm.open_mainfile', { source: 'PUTER' }, { invoke: true });
    expect(stub.ui.showOpenFilePicker).toHaveBeenCalledTimes(1);
    const { openFromMenu } = await import('../../src/ui/topbar');
    expect(openFromMenu().map((i) => i.label)).toEqual(['Open from Puter…']);
    stub.env = 'app';
    expect(openFromMenu().map((i) => i.label)).toEqual(['Open from This Device…']);
    app.run('wm.open_mainfile', { source: 'DEVICE' }, { invoke: true });
    expect(clicks).toEqual(['input file', 'input file']);
  });

  it('File ▸ Import from Puter adds the file to the current scene', async () => {
    const stub = installSdk();
    stub.drive.set('/u/part.zzmodel', new TextEncoder().encode('part bytes'));
    stub.ui.showOpenFilePicker.mockReturnValue(answered([fsItem(stub, '/u/part.zzmodel')]));
    const { importMenu } = await import('../../src/io/files');
    expect(importMenu()[0].label).toBe('From This Device…');
    app.run('wm.import', {}, { invoke: true });
    await settle();
    expect(imported).toEqual([{ name: 'part.zzmodel', bytes: 'part bytes' }]);
    expect(app.filename).toBe('untitled.blend');
    expect(openPuterPath()).toBeNull();
    // cancelling picks nothing
    stub.ui.showOpenFilePicker.mockReturnValue(cancelled());
    await pickFromPuter('import');
    expect(imported.length).toBe(1);
  });
});

describe("Puter's Save dialog", () => {
  it('saves a new file where the dialog says, and Save writes there afterwards', async () => {
    const stub = installSdk();
    stub.ui.showSaveFilePicker.mockImplementation((blob: Blob, name: string) => answered({ name: name.replace('untitled', 'tower'), path: `/u/Documents/${name.replace('untitled', 'tower')}`, _blob: blob }));
    app.dirty = true;
    saveFile();
    await settle();
    const [blob, suggested] = stub.ui.showSaveFilePicker.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(suggested).toBe('untitled.blend');
    expect(clicks).toEqual([]);
    expect(app.filename).toBe('tower.blend');
    expect(app.dirty).toBe(false);
    expect(openPuterPath()).toBe('/u/Documents/tower.blend');
    expect(messages().at(-1)).toBe('INFO: Saved "tower.blend"');
    saveFile();
    await settle();
    expect(stub.ui.showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(stub.fs.write.mock.calls.map((c) => c[0])).toEqual(['/u/Documents/tower.blend']);
  });

  it('Save As asks even for the open Puter file, and the chosen file becomes the one Save writes to', async () => {
    const stub = installSdk();
    stub.drive.set('/u/a.blend', project(10));
    await openDriveItems([fsItem(stub, '/u/a.blend')]);
    stub.ui.showSaveFilePicker.mockReturnValue(answered({ name: 'b.blend', path: '/u/Backup/b.blend' }));
    app.run('wm.save_as_mainfile', {}, { invoke: true });
    await settle();
    expect(stub.ui.showSaveFilePicker.mock.calls[0][1]).toBe('a.blend');
    expect(stub.fs.write).not.toHaveBeenCalled();
    expect(app.filename).toBe('b.blend');
    expect(openPuterPath()).toBe('/u/Backup/b.blend');
    // Save Copy leaves the current file alone
    stub.ui.showSaveFilePicker.mockReturnValue(answered({ name: 'b_copy.blend', path: '/u/b_copy.blend' }));
    app.run('wm.save_as_mainfile', { copy: true }, { invoke: true });
    await settle();
    expect(stub.ui.showSaveFilePicker.mock.calls[1][1]).toBe('b_copy.blend');
    expect(app.filename).toBe('b.blend');
    expect(openPuterPath()).toBe('/u/Backup/b.blend');
    expect(messages().at(-1)).toBe('INFO: Saved a copy as "b_copy.blend"');
  });

  it('a file saved under another name than it was opened with goes through the dialog', async () => {
    const stub = installSdk();
    stub.drive.set('/u/old.blend', project(10));
    await openDriveItems([fsItem(stub, '/u/old.blend')]);
    stub.ui.showSaveFilePicker.mockReturnValue(cancelled());
    // e.g. Save Incremental, or a file whose type is saved under another extension
    saveFile('old.001.blend');
    await settle();
    expect(stub.ui.showSaveFilePicker.mock.calls[0][1]).toBe('old.001.blend');
    expect(stub.fs.write).not.toHaveBeenCalled();
  });

  it('keeps everything as it was when the dialog is cancelled, and opens one dialog at a time', async () => {
    const stub = installSdk();
    // an older SDK: nothing settles on cancel
    stub.ui.showSaveFilePicker.mockReturnValue(new Promise(() => {}));
    app.dirty = true;
    saveFile();
    saveFile();
    await settle();
    expect(stub.ui.showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(app.filename).toBe('untitled.blend');
    expect(app.dirty).toBe(true);
    // the app has the focus back: the dialog is gone, the next save asks again
    stub.ui.showSaveFilePicker.mockReturnValue(cancelled());
    dispatchEvent(new Event('focus'));
    saveFile();
    await settle();
    expect(stub.ui.showSaveFilePicker).toHaveBeenCalledTimes(2);
    expect(app.dirty).toBe(true);
    expect(fileEvents.saveTarget).toBeNull();
  });

  it('keeps the file modified when it changed while the dialog was open', async () => {
    const stub = installSdk();
    let answer: (v: DriveItem) => void = () => {};
    stub.ui.showSaveFilePicker.mockReturnValue(new Promise((r) => (answer = r)));
    saveFile();
    app.doc.scene.frame_end = 3;
    app.changed('doc');
    answer({ name: 'x.blend', path: '/u/x.blend' });
    await settle();
    expect(app.filename).toBe('x.blend');
    expect(app.dirty).toBe(true);
  });
});

describe('outside Puter', () => {
  it('downloads the file, as before, on the web and without the SDK', async () => {
    const stub = installSdk({ env: 'web' });
    saveFile();
    expect(clicks).toEqual(['download untitled.blend']);
    expect(stub.ui.showSaveFilePicker).not.toHaveBeenCalled();
    delete (globalThis as unknown as { puter?: unknown }).puter;
    app.run('wm.save_as_mainfile', { filepath: 'other.blend' }, { invoke: false });
    expect(clicks).toEqual(['download untitled.blend', 'download other.blend']);
    expect(app.filename).toBe('other.blend');
    const { openFromMenu } = await import('../../src/ui/topbar');
    expect(openFromMenu()).toEqual([]);
  });

  it('a Puter file opened in a browser tab is still saved back in place', async () => {
    const stub = installSdk({ env: 'web' });
    stub.drive.set('/u/w.blend', project(5));
    await openDriveItems([fsItem(stub, '/u/w.blend')]);
    saveFile();
    await settle();
    expect(stub.fs.write.mock.calls.map((c) => c[0])).toEqual(['/u/w.blend']);
    expect(clicks).toEqual([]);
  });
});

describe('files dragged in from a Puter folder window', () => {
  const sdkDrop = (items: unknown[], target: EventTarget = document.body) =>
    target.dispatchEvent(new CustomEvent('drop', { bubbles: true, cancelable: true, detail: { clientX: 40, clientY: 50, items } }));

  it('imports model files, reading the plain drive records', async () => {
    const stub = installSdk();
    stub.drive.set('/u/Desktop/wheel.zzmodel', new TextEncoder().encode('wheel'));
    sdkDrop([{ name: 'wheel.zzmodel', path: '/u/Desktop/wheel.zzmodel', is_dir: false }]);
    await settle();
    expect(stub.fs.read).toHaveBeenCalledWith('/u/Desktop/wheel.zzmodel');
    expect(imported).toEqual([{ name: 'wheel.zzmodel', bytes: 'wheel' }]);
    expect(app.pointer).toEqual({ x: 40, y: 50 });
  });

  it('skips folders and files no format reads without reading them', async () => {
    const stub = installSdk();
    sdkDrop([
      { name: 'Stuff', path: '/u/Stuff', is_dir: true },
      { name: 'readme.txt', path: '/u/readme.txt', is_dir: false },
    ]);
    await settle();
    expect(stub.fs.read).not.toHaveBeenCalled();
    expect(messages()).toEqual(['WARNING: Folders were skipped: open the files inside them instead', 'ERROR: Cannot open "readme.txt": no format reads this type of file']);
  });

  it('a dropped project file opened from the drop menu is saved back to the drive', async () => {
    const stub = installSdk();
    stub.drive.set('/u/drop.blend', project(21));
    sdkDrop([{ name: 'drop.blend', path: '/u/drop.blend', is_dir: false }]);
    await settle();
    const items = captureMenuItems(() => app.run('wm.drop_blend_file', {}, { invoke: false }));
    expect(items.map((i) => i.label)).toContain('Open');
    items.find((i) => i.label === 'Open')!.action!();
    await settle();
    expect(app.filename).toBe('drop.blend');
    expect(app.doc.scene.frame_end).toBe(21);
    expect(openPuterPath()).toBe('/u/drop.blend');
    // dropping it again while it is open does not read it again
    sdkDrop([{ name: 'drop.blend', path: '/u/drop.blend', is_dir: false }]);
    await settle();
    expect(stub.fs.read).toHaveBeenCalledTimes(1);
    expect(messages().at(-1)).toBe('INFO: "drop.blend" is already open');
  });

  it('a launch and a drop of the same file at once give one open', async () => {
    const stub = installSdk();
    stub.drive.set('/u/both.blend', project(8));
    const opened: string[] = [];
    fileEvents.opened.push((name) => opened.push(name));
    try {
      const launch = openLaunchItems([fsItem(stub, '/u/both.blend')]);
      sdkDrop([{ name: 'both.blend', path: '/u/both.blend', is_dir: false }]);
      await launch;
      await settle();
      expect(opened).toEqual(['both.blend']);
      expect(stub.fs.read).toHaveBeenCalledTimes(1);
    } finally {
      fileEvents.opened.pop();
    }
  });

  it('leaves drops from this device to the device handler', async () => {
    const stub = installSdk();
    const e = new Event('drop', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    await settle();
    expect(stub.fs.read).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});
