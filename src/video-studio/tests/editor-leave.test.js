// Leaving the editor: edits and media that could not be saved are not
// dropped without asking.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Editor } from '../src/ui/editor.js';
import { MediaService } from '../src/media/media-service.js';
import { fixture, clip, onMain } from './helpers.js';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const dialog = () => document.querySelector('dialog[open]');
const button = (label) => [...(dialog()?.querySelectorAll('button') || [])].find((b) => b.textContent === label);

let root;
let editor;
beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root, Object.assign(document.createElement('div'), { id: 'live-region' }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (editor && !editor._disposed) editor.dispose();
  editor = null;
  vi.restoreAllMocks();
});

async function open() {
  const backend = memoryBackend();
  const library = new Library(backend);
  const p = fixture();
  onMain(p, clip('video', 0, 4));
  await library.saveProject(p);
  const onExit = vi.fn();
  editor = new Editor(root, { library, project: p, account: {}, onExit, onNewProject() {} });
  await settle();
  return { backend, library, onExit, p };
}

const rename = (name) => editor.store.update('Rename', (x) => { x.name = name; }, { structural: false });

describe('leaving the editor', () => {
  it('saves and leaves when the save works', async () => {
    const { library, onExit, p } = await open();
    rename('Saved name');
    await editor.exit();
    expect(onExit).toHaveBeenCalled();
    expect((await library.openProject(p.id)).name).toBe('Saved name');
  });

  it('stays open after a failed save when the user chooses to stay, and keeps retrying', async () => {
    const { backend, library, onExit, p } = await open();
    rename('Unsaved name');
    backend.failNext = 1;
    const leaving = editor.exit();
    await settle();
    expect(dialog()?.textContent).toContain("Couldn't save your changes");
    expect(document.activeElement).toBe(button('Stay'));
    button('Stay').click();
    expect(await leaving).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
    expect(editor._disposed).toBeFalsy();
    expect(editor.saver.timer).toBeTruthy();
    // Leaving again once the connection is back saves without asking.
    await editor.exit();
    expect(dialog()).toBeFalsy();
    expect(onExit).toHaveBeenCalled();
    expect((await library.openProject(p.id)).name).toBe('Unsaved name');
  });

  it('leaves after a failed save only when the user confirms', async () => {
    const { backend, onExit } = await open();
    rename('Lost name');
    backend.failNext = 1;
    const leaving = editor.exit();
    await settle();
    button('Leave anyway').click();
    await leaving;
    expect(onExit).toHaveBeenCalled();
    expect(editor._disposed).toBe(true);
  });

  it('asks once when leaving is requested twice', async () => {
    const { backend, onExit } = await open();
    rename('x');
    backend.failNext = 1;
    const a = editor.exit();
    const b = editor.exit();
    await settle();
    expect(document.querySelectorAll('dialog[open]').length).toBe(1);
    button('Leave anyway').click();
    await Promise.all([a, b]);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('asks before the page closes with a media file that could not be uploaded, and shows it in the title bar', async () => {
    const { library } = await open();
    library.backend.failNext = 2; // the media listing and the write
    library._store({ hash: 'h1', ext: 'mp4', name: 'clip.mp4' }, new Blob(['x']));
    await settle();
    expect(root.querySelector('.upload-status').textContent).toBe('1 media file not uploaded. Retrying...');
    library.backend.failNext = 2;
    const leaving = editor.prepareToLeave({ waitForUploads: true });
    await settle();
    expect(dialog()?.textContent).toContain("1 media file couldn't be saved");
    button('Stay').click();
    expect(await leaving).toBe(false);
    // Back to the home screen keeps the upload going: no question.
    expect(await editor.prepareToLeave()).toBe(true);
    expect(library.unsavedMedia).toBe(1);
  });
});

describe('closing the editor', () => {
  it('stops listening to the library, which outlives it', async () => {
    const library = new Library(memoryBackend());
    const subs = [];
    const on = library.on.bind(library);
    library.on = (type, fn) => {
      const off = on(type, fn);
      const sub = { type, off: false };
      subs.push(sub);
      return () => {
        sub.off = true;
        off();
      };
    };
    const p = fixture();
    await library.saveProject(p);
    editor = new Editor(root, { library, project: p, account: {}, onExit() {}, onNewProject() {} });
    await settle();
    expect(subs.some((s) => s.type === 'uploads')).toBe(true);
    editor.dispose();
    expect(subs.filter((s) => !s.off)).toEqual([]);
  });

  it('closes the media posters it made', async () => {
    const svc = new MediaService(null);
    const ready = { close: vi.fn() };
    const late = { close: vi.fn() };
    let finish;
    svc.posters.set('a', { value: ready, promise: Promise.resolve(ready) });
    svc.posters.set('b', { value: null, promise: new Promise((r) => (finish = r)) });
    svc.dispose();
    expect(ready.close).toHaveBeenCalled();
    finish(late);
    await settle(0);
    expect(late.close).toHaveBeenCalled();
    expect(svc.posters.size).toBe(0);
  });
});

describe('opening the editor', () => {
  it('checks for missing media files and marks them in the media panel', async () => {
    const library = new Library(memoryBackend());
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    p.assets.vid.hash = 'hv';
    p.assets.vid.ext = 'mp4';
    for (const id of ['silent', 'aud', 'img']) delete p.assets[id];
    await library.saveProject(p);
    editor = new Editor(root, { library, project: p, account: {}, onExit() {}, onNewProject() {} });
    await settle(150);
    expect(editor.media.missing.has('hv')).toBe(true);
    root.querySelector('[data-cat="project"]')?.click();
    await settle(50);
    expect(root.querySelector('.tile-sub.missing')?.textContent).toBe('File missing');
  });
});

describe('closing the page', () => {
  it('asks the browser to warn about unsaved edits, unless leaving was already chosen', async () => {
    await open();
    editor.store.update('Edit', (p) => void (p.name = 'Changed'));
    const unload = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(true);
    editor.pageLeaving = true;
    expect(unload()).toBe(false);
  });
});

describe('a failed save where the status has no room', () => {
  const errorToasts = () => [...document.querySelectorAll('.toast.error:not(.leaving)')].map((t) => t.textContent);

  it('says so once in a toast, and takes it away when a save works again', async () => {
    await open();
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    editor.saver.emit('status', { status: 'error' });
    editor.saver.emit('status', { status: 'saving' }); // the retry...
    editor.saver.emit('status', { status: 'error' }); // ...failed too: still one note
    expect(errorToasts()).toEqual(["Couldn't save your changes. Retrying..."]);
    expect(document.querySelectorAll('.toast.error')).toHaveLength(1); // not taken away and shown again
    editor.saver.emit('status', { status: 'saved', at: Date.now() });
    await settle(250);
    expect(errorToasts()).toEqual([]);
  });

  it('leaves it to the status where the status shows', async () => {
    await open();
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const status = root.querySelector('.save-status');
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function w() {
      return this === status ? 240 : 0;
    });
    editor.saver.emit('status', { status: 'error' });
    expect(status.textContent).toBe("Couldn't save. Retrying...");
    expect(errorToasts()).toEqual([]);
  });
});
