import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Library, AutoSaver } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { EditorStore } from '../src/model/store.js';
import { createProject } from '../src/model/project.js';

// Media probing needs real decoders; these tests only need its answers.
vi.mock('../src/media/probe.js', async (importOriginal) => ({
  ...(await importOriginal()),
  probe: vi.fn(async (file) => {
    if (!/\.(mp4|mp3|png)$/.test(file.name)) throw new Error(`${file.name} is not a video, audio or image file.`);
    return { kind: file.name.endsWith('.mp3') ? 'audio' : file.name.endsWith('.png') ? 'image' : 'video', duration: 2_000_000, width: 640, height: 360, fps: 30, hasAudio: true, hasVideo: true };
  }),
}));

const json = (backend, path) => JSON.parse(backend.files.get(path));
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('Library projects', () => {
  let backend;
  let lib;
  beforeEach(() => {
    backend = memoryBackend();
    lib = new Library(backend);
  });

  it('creates projects and lists them newest first', async () => {
    const a = await lib.createProject({ name: 'First' });
    const b = await lib.createProject({ name: 'Second', ratio: '9:16' });
    b.modified = a.modified + 10;
    await lib.saveProject(b);
    const list = await lib.listProjects();
    expect(list.map((p) => p.name)).toEqual(['Second', 'First']);
    expect(list[0]).toMatchObject({ id: b.id, ratio: '9:16', width: 1080, height: 1920, duration: 0 });
    expect(json(backend, `projects/${a.id}.json`).name).toBe('First');
  });

  it('opens a saved project as a normalized copy', async () => {
    const p = await lib.createProject({ name: 'Open me' });
    const opened = await lib.openProject(p.id);
    expect(opened).toEqual(p);
    expect(opened).not.toBe(p);
  });

  it('explains when a project file is missing', async () => {
    await expect(lib.openProject('nope')).rejects.toThrow(/could not be found/);
  });

  it('renames a project in its file and in the index', async () => {
    const p = await lib.createProject({ name: 'Old' });
    await lib.renameProject(p.id, 'New');
    expect(json(backend, `projects/${p.id}.json`).name).toBe('New');
    expect((await lib.listProjects()).map((x) => x.name)).toEqual(['New']);
  });

  it('duplicates a project with a new id, a copy name and its cover', async () => {
    const p = await lib.createProject({ name: 'Trip' });
    await lib.saveCover(p.id, 'jpeg-bytes');
    const copy = await lib.duplicateProject(p.id);
    expect(copy.id).not.toBe(p.id);
    expect(copy.name).toBe('Trip copy');
    expect(backend.files.get(`covers/${copy.id}.jpg`)).toBe('jpeg-bytes');
    expect((await lib.listProjects()).map((x) => x.id).sort()).toEqual([p.id, copy.id].sort());
  });

  it('names new projects with the lowest free number, counting the Trash', async () => {
    expect(await lib.nextProjectName()).toBe('Project 1');
    const p1 = await lib.createProject({ name: await lib.nextProjectName() });
    const p2 = await lib.createProject({ name: await lib.nextProjectName() });
    expect(p2.name).toBe('Project 2');
    await lib.trashProject(p1.id);
    // Project 1 is in the Trash: restoring it must not make two of them.
    expect(await lib.nextProjectName()).toBe('Project 3');
    await lib.deleteProject(p1.id);
    expect(await lib.nextProjectName()).toBe('Project 1');
    await lib.renameProject(p2.id, 'project 1');
    expect(await lib.nextProjectName()).toBe('Project 2');
  });

  it('deletes the project file, its cover and its index entry', async () => {
    const keep = await lib.createProject({ name: 'Keep' });
    const gone = await lib.createProject({ name: 'Gone' });
    await lib.saveCover(gone.id, 'x');
    const events = [];
    lib.on('index', (list) => events.push(list.length));
    await lib.deleteProject(gone.id);
    expect(backend.files.has(`projects/${gone.id}.json`)).toBe(false);
    expect(backend.files.has(`covers/${gone.id}.jpg`)).toBe(false);
    expect((await lib.listProjects()).map((x) => x.id)).toEqual([keep.id]);
    expect(events).toEqual([1]);
  });

  it.each([
    ['missing', undefined],
    ['corrupt', '{"oops'],
    ['not a list', '{"a":1}'],
  ])('rebuilds the index from the project files when it is %s', async (_, content) => {
    const p = await lib.createProject({ name: 'Survivor' });
    backend.files.set('projects/broken.json', 'not json');
    backend.files.set('projects/readme.txt', 'ignored');
    if (content === undefined) backend.files.delete('index.json');
    else backend.files.set('index.json', content);
    const fresh = new Library(backend);
    const list = await fresh.listProjects();
    expect(list.map((x) => x.id)).toEqual([p.id]);
    expect(json(backend, 'index.json').map((x) => x.id)).toEqual([p.id]);
  });

  it('keeps the file name as the project id, so a rebuilt index opens the right file', async () => {
    backend.files.set('projects/abc.json', JSON.stringify({ format: 'video-studio-project', name: 'No id' }));
    backend.files.set('projects/def.json', JSON.stringify({ format: 'video-studio-project', id: 'other', name: 'Wrong id' }));
    const list = await lib.listProjects();
    expect(list.map((x) => x.id).sort()).toEqual(['abc', 'def']);
    expect((await lib.openProject('abc')).id).toBe('abc');
    expect((await lib.openProject('def')).id).toBe('def');
  });
});

describe('Library in two tabs', () => {
  it('keeps a project created in another tab in the index', async () => {
    const backend = memoryBackend();
    const tabA = new Library(backend);
    const tabB = new Library(backend);
    const a = await tabA.createProject({ name: 'A' });
    const b = await tabB.createProject({ name: 'B' });
    a.name = 'A edited';
    await tabA.saveProject(a);
    const list = await new Library(backend).listProjects();
    expect(list.map((p) => p.name).sort()).toEqual(['A edited', 'B']);
    expect(list.some((p) => p.id === b.id)).toBe(true);
  });

  it('does not bring back a project deleted in another tab', async () => {
    const backend = memoryBackend();
    const tabA = new Library(backend);
    const tabB = new Library(backend);
    const a = await tabA.createProject({ name: 'A' });
    const gone = await tabA.createProject({ name: 'Gone' });
    await tabB.listProjects();
    await tabB.trashProject(gone.id);
    await tabB.deleteProject(gone.id);
    await tabA.saveProject(a);
    expect((await new Library(backend).listProjects()).map((p) => p.name)).toEqual(['A']);
  });

  it('falls back to the index it knows when the index cannot be read', async () => {
    const backend = memoryBackend();
    const lib = new Library(backend);
    const a = await lib.createProject({ name: 'A' });
    await lib.createProject({ name: 'B' });
    const read = backend.readJSON;
    backend.readJSON = async (path) => {
      if (path === 'index.json') throw new Error('Simulated network failure');
      return read(path);
    };
    await lib.saveProject(a);
    backend.readJSON = read;
    expect((await lib.listProjects()).map((p) => p.name).sort()).toEqual(['A', 'B']);
  });
});

describe('project claims', () => {
  // A small stand-in for navigator.locks: exclusive locks by name, queued or ifAvailable.
  function fakeLocks() {
    const held = new Map();
    const queue = [];
    const grant = (name, cb, resolve) => {
      held.set(name, true);
      Promise.resolve(cb({ name })).then((v) => {
        held.delete(name);
        resolve(v);
        const next = queue.findIndex((q) => q.name === name && !q.signal?.aborted);
        if (next >= 0) {
          const [q] = queue.splice(next, 1);
          grant(q.name, q.cb, q.resolve);
        }
      });
    };
    return {
      request(name, opts, cb) {
        return new Promise((resolve, reject) => {
          if (!held.has(name)) return grant(name, cb, resolve);
          if (opts.ifAvailable) return Promise.resolve(cb(null)).then(resolve);
          opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          queue.push({ name, cb, resolve, signal: opts.signal });
        });
      },
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('tells when a project is already open in another tab, and hands it over when that tab closes it', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: fakeLocks() });
    try {
      const lib = new Library(memoryBackend());
      const first = await lib.claimProject('p1');
      expect(first.held).toBe(true);
      const second = await lib.claimProject('p1');
      expect(second.held).toBe(false);
      expect((await lib.claimProject('p2')).held).toBe(true);
      first.release();
      await tick();
      // The tab that opened it anyway has it now, so a third is told.
      const third = await lib.claimProject('p1');
      expect(third.held).toBe(false);
      third.release();
      second.release();
      await tick();
      expect((await lib.claimProject('p1')).held).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lets every project open where the browser has no locks', async () => {
    const lib = new Library(memoryBackend());
    const a = await lib.claimProject('p1');
    const b = await lib.claimProject('p1');
    expect([a.held, b.held]).toEqual([true, true]);
    a.release();
    b.release();
  });
});

describe('Library media', () => {
  it('imports a file, stores it once by content and serves it back', async () => {
    const backend = memoryBackend();
    const lib = new Library(backend);
    const file = new File([new Uint8Array([1, 2, 3])], 'Clip.MP4'.toLowerCase(), { type: 'video/mp4' });
    const asset = await lib.importFile(file);
    expect(asset).toMatchObject({ kind: 'video', name: 'clip.mp4', ext: 'mp4', duration: 2_000_000, width: 640 });
    expect(asset.hash).toMatch(/^[0-9a-f]{64}$/);
    await lib.flushUploads();
    expect(backend.files.has(`media/${asset.hash}.mp4`)).toBe(true);
    const writes = backend.writes;
    const again = await lib.importFile(file);
    await lib.flushUploads();
    expect(again.hash).toBe(asset.hash);
    expect(backend.writes).toBe(writes);
    expect(await lib.mediaBlob(asset)).toBe(file);
  });

  it('rejects files that are not media', async () => {
    const lib = new Library(memoryBackend());
    await expect(lib.importFile(new File(['hi'], 'notes.txt'))).rejects.toThrow(/not a video/);
  });

  it('reports a failed upload and lets it be retried', async () => {
    quiet();
    const backend = memoryBackend();
    const lib = new Library(backend);
    const states = [];
    lib.on('uploads', (e) => states.push(e));
    backend.failNext = 2; // the media listing and the write
    const asset = await lib.importFile(new File(['a'], 'a.mp3', { type: 'audio/mpeg' }));
    await lib.flushUploads();
    expect(states.at(-1)).toMatchObject({ pending: 0, failed: 1, error: expect.any(Error) });
    expect(backend.files.has(`media/${asset.hash}.mp3`)).toBe(false);
    lib._store(asset, lib.blobs.get(asset.hash));
    await lib.flushUploads();
    expect(backend.files.has(`media/${asset.hash}.mp3`)).toBe(true);
  });

  it('retries a failed upload by itself and keeps the file in memory until it is stored', async () => {
    quiet();
    vi.useFakeTimers();
    try {
      const backend = memoryBackend();
      const lib = new Library(backend);
      const states = [];
      lib.on('uploads', (e) => states.push(e));
      backend.failNext = 2; // the media listing and the write
      const asset = await lib.importFile(new File(['a'], 'a.mp3', { type: 'audio/mpeg' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(states.at(-1)).toMatchObject({ pending: 0, failed: 1 });
      expect(lib.unsavedMedia).toBe(1);
      // Leaving the editor must not drop the only copy.
      lib.releaseMedia();
      expect(lib.blobs.has(asset.hash)).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(backend.files.has(`media/${asset.hash}.mp3`)).toBe(true);
      expect(states.at(-1)).toMatchObject({ pending: 0, failed: 0 });
      expect(lib.unsavedMedia).toBe(0);
      lib.releaseMedia();
      expect(lib.blobs.has(asset.hash)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushUploads() retries failed uploads at once and says whether everything is stored', async () => {
    quiet();
    const backend = memoryBackend();
    const lib = new Library(backend);
    backend.failNext = 2;
    const asset = await lib.importFile(new File(['b'], 'b.mp3', { type: 'audio/mpeg' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(lib.unsavedMedia).toBe(1);
    backend.failNext = 2;
    expect(await lib.flushUploads()).toBe(false);
    expect(await lib.flushUploads()).toBe(true);
    expect(backend.files.has(`media/${asset.hash}.mp3`)).toBe(true);
    expect(lib.unsavedMedia).toBe(0);
  });

  it('downloads a file once when several parts of the editor ask for it at the same time', async () => {
    const backend = memoryBackend();
    backend.files.set('media/h.mp4', new Blob([new Uint8Array(10)]));
    let reads = 0;
    const read = backend.readBlob;
    backend.readBlob = async (path) => {
      reads++;
      await new Promise((r) => setTimeout(r, 20));
      return read(path);
    };
    const lib = new Library(backend);
    const a = { hash: 'h', ext: 'mp4', name: 'x', mime: 'video/mp4' };
    const [b1, b2, b3] = await Promise.all([lib.mediaBlob(a), lib.mediaBlob(a), lib.mediaBlob(a), lib.mediaURL(a)]);
    expect(reads).toBe(1);
    expect(b1).toBe(b2);
    expect(b2).toBe(b3);
    // A failed read is not remembered.
    await expect(lib.mediaBlob({ hash: 'gone', ext: 'mp4', name: 'Gone' })).rejects.toThrow(/missing/);
    backend.files.set('media/gone.mp4', new Blob(['x']));
    await expect(lib.mediaBlob({ hash: 'gone', ext: 'mp4', name: 'Gone' })).resolves.toBeTruthy();
  });

  it('reads media from storage when it is not in memory and explains a missing file', async () => {
    const backend = memoryBackend();
    const lib = new Library(backend);
    const blob = new Blob(['data']);
    backend.files.set('media/h1.mp4', blob);
    const fromStore = await lib.mediaBlob({ hash: 'h1', ext: 'mp4', name: 'A', mime: 'video/mp4' });
    expect(fromStore.type).toBe('video/mp4');
    await expect(lib.mediaBlob({ hash: 'h2', ext: 'mp4', name: 'Lost clip' })).rejects.toThrow('Media file missing: Lost clip');
    const url = await lib.mediaURL({ hash: 'h1', ext: 'mp4', name: 'A' });
    expect(await lib.mediaURL({ hash: 'h1', ext: 'mp4', name: 'A' })).toBe(url);
  });
});

describe('AutoSaver', () => {
  let backend;
  let lib;
  let store;
  let saver;
  let statuses;

  beforeEach(async () => {
    vi.useFakeTimers();
    backend = memoryBackend();
    lib = new Library(backend);
    const project = createProject({ name: 'Auto' });
    await lib.saveProject(project);
    store = new EditorStore(project);
    saver = new AutoSaver(lib, store, { delay: 1000 });
    statuses = [];
    saver.on('status', (e) => statuses.push(e.status));
  });

  afterEach(() => {
    saver.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const edit = (name) => store.update('Rename', (p) => { p.name = name; }, { structural: false });
  const saved = () => json(backend, `projects/${store.project.id}.json`).name;

  it('waits for a pause in editing and then saves once', async () => {
    const writes = backend.writes;
    edit('a');
    await vi.advanceTimersByTimeAsync(600);
    edit('b');
    await vi.advanceTimersByTimeAsync(600);
    edit('c');
    expect(backend.writes).toBe(writes);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved()).toBe('c');
    expect(backend.writes - writes).toBe(2); // project file and index
    expect(store.dirty).toBe(false);
    expect(statuses).toEqual(['pending', 'pending', 'pending', 'saving', 'saved']);
  });

  it('shows an error and retries after a failed save', async () => {
    quiet();
    backend.failNext = 1;
    edit('retry me');
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.status).toBe('error');
    expect(store.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(8000);
    expect(saver.status).toBe('saved');
    expect(saved()).toBe('retry me');
    expect(store.dirty).toBe(false);
  });

  it('flush() rejects when the edits could not be saved, and the retry keeps going', async () => {
    quiet();
    edit('before leaving');
    backend.failNext = 1;
    await expect(saver.flush()).rejects.toThrow('Simulated network failure');
    expect(store.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(8000);
    expect(saved()).toBe('before leaving');
    await expect(saver.flush()).resolves.toBeUndefined();
  });

  it('flush() retries a failed save at once instead of waiting for the next retry', async () => {
    quiet();
    backend.failNext = 1;
    edit('retry now');
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.status).toBe('error');
    await saver.flush();
    expect(saved()).toBe('retry now');
    expect(saver.status).toBe('saved');
  });

  it('saves again when edits arrive while a save is running', async () => {
    edit('first');
    await vi.advanceTimersByTimeAsync(1000);
    // Slow the next write down so an edit lands mid-save.
    const write = backend.writeJSON;
    backend.writeJSON = async (...args) => {
      await new Promise((r) => setTimeout(r, 500));
      return write(...args);
    };
    edit('second');
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.status).toBe('saving');
    edit('third');
    await vi.advanceTimersByTimeAsync(5000);
    expect(saved()).toBe('third');
    expect(store.dirty).toBe(false);
    expect(saver.status).toBe('saved');
  });

  it('flush() saves right away and is a no-op when nothing changed', async () => {
    edit('now');
    await saver.flush();
    expect(saved()).toBe('now');
    const writes = backend.writes;
    await saver.flush();
    expect(backend.writes).toBe(writes);
  });

  it('stops listening after dispose()', async () => {
    saver.dispose();
    const writes = backend.writes;
    edit('ignored');
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.writes).toBe(writes);
  });
});
