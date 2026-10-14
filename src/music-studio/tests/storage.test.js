import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Library, toBase64, fromBase64 } from '../src/storage/library.js';
import { memoryDB } from '../src/storage/idb.js';
import { Autosave } from '../src/storage/autosave.js';
import * as puterApi from '../src/storage/puter.js';
import { Store } from '../src/model/store.js';
import * as E from '../src/model/edits.js';
import { demoProject, newProject } from '../src/model/demo.js';
import { serializeProject } from '../src/model/serialize.js';
import { App } from '../src/app.js';
import { install } from '../src/storage/index.js';
import { ProjectFiles } from '../src/storage/files.js';

/** A fake Puter SDK with an in-memory file system. Every fs call is recorded. */
function fakePuter({ signedIn = true, username = 'ada' } = {}) {
  const files = new Map();
  const calls = [];
  const rec = (name, fn) => (...args) => {
    calls.push(name);
    return fn(...args);
  };
  const p = {
    env: 'web',
    files,
    calls,
    signedIn,
    auth: {
      isSignedIn: () => p.signedIn,
      getUser: rec('getUser', async () => ({ username })),
      signIn: async () => {
        p.signedIn = true;
      },
      signOut: () => {
        p.signedIn = false;
      },
    },
    fs: {
      write: rec('write', async (path, data) => {
        const blob = data instanceof Blob ? data : new Blob([data]);
        files.set(path, new Uint8Array(await blob.arrayBuffer()));
        return { path, name: path.slice(path.lastIndexOf('/') + 1) };
      }),
      read: rec('read', async (path) => {
        if (!files.has(path)) throw Object.assign(new Error('not found'), { code: 'subject_does_not_exist' });
        return new Blob([files.get(path)]);
      }),
      stat: rec('stat', async (path) => {
        if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'subject_does_not_exist' });
        return { path };
      }),
      readdir: rec('readdir', async () => []),
      // Relative paths resolve into the app's AppData folder, as in Puter.
      mkdir: rec('mkdir', async (path) => ({ path: path.startsWith('/') ? path : `/${username}/AppData/app-test/${path}` })),
    },
    ui: {},
  };
  return p;
}

const fakeDecode = async (buf) => ({ channels: [new Float32Array(new Uint8Array(buf).length)], rate: 48000 });
const cache = () => {
  const m = new Map();
  return { has: (id) => m.has(id), set: (id, v) => m.set(id, v), get: (id) => m.get(id), map: m };
};

// jsdom has no 2D canvas; the toolbar meters draw every frame.
const noop = () => {};
HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true) });

let saved;
beforeEach(() => {
  saved = window.puter;
  puterApi.resetAccountCache();
});
afterEach(() => {
  window.puter = saved;
  puterApi.resetAccountCache();
});

describe('local projects (this device)', () => {
  it('round trips a project through save and open', async () => {
    const lib = new Library({ db: memoryDB(), now: () => 1000 });
    const p = demoProject();
    const { key } = await lib.saveLocal(p, { pattern: p.patterns[1].id, channel: p.channels[2].id }, { name: 'Beat' });
    const list = await lib.listLocal();
    expect(list).toEqual([{ key, name: 'Beat', modified: 1000, size: expect.any(Number) }]);
    const back = await lib.loadLocal(key);
    expect(back.name).toBe(p.name);
    expect(back.bpm).toBe(p.bpm);
    expect(back.channels.map((c) => c.id)).toEqual(p.channels.map((c) => c.id));
    expect(back.patterns[0].notes).toEqual(p.patterns[0].notes);
    expect(back.clips).toEqual(p.clips);
    expect(back.ui.pattern).toBe(p.patterns[1].id);
    expect(back.ui.channel).toBe(p.channels[2].id);
    await lib.deleteLocal(key);
    expect(await lib.listLocal()).toEqual([]);
    await expect(lib.loadLocal(key)).rejects.toThrow(/no longer saved/);
  });

  it('lists newest first', async () => {
    let t = 0;
    const lib = new Library({ db: memoryDB(), now: () => ++t });
    await lib.saveLocal(newProject('A'), {}, { key: 'a', name: 'A' });
    await lib.saveLocal(newProject('B'), {}, { key: 'b', name: 'B' });
    expect((await lib.listLocal()).map((m) => m.name)).toEqual(['B', 'A']);
  });
});

describe('samples', () => {
  it('loads from this device first and reports missing ones', async () => {
    const lib = new Library({ db: memoryDB(), decode: fakeDecode, puter: { isSignedIn: () => false, readFile: vi.fn() } });
    await lib.putSample('s1', { data: new Uint8Array([1, 2, 3]).buffer, name: 'kick.wav' });
    const p = { samples: { s1: { id: 's1', name: 'kick.wav', local: 's1', path: null }, s2: { id: 's2', name: 'gone.wav', local: null, path: '/ada/x.wav' } } };
    const c = cache();
    const r = await lib.loadSamples(p, c);
    expect(r).toEqual({ loaded: 1, missing: ['gone.wav'] });
    expect(c.get('s1').channels[0].length).toBe(3);
    expect(lib.puter.readFile).not.toHaveBeenCalled();
  });

  it('downloads from Puter when signed in and caches the bytes', async () => {
    const fake = fakePuter();
    window.puter = fake;
    fake.files.set('/ada/AppData/app-test/Samples/s2.wav', new Uint8Array([9, 9]));
    const lib = new Library({ db: memoryDB(), decode: fakeDecode });
    const c = cache();
    const ref = { id: 's2', name: 'snare.wav', path: '/ada/AppData/app-test/Samples/s2.wav', local: null };
    expect(await lib.loadSamples({ samples: { s2: ref } }, c)).toEqual({ loaded: 1, missing: [] });
    expect((await lib.sampleRecord('s2')).path).toBe(ref.path);
    fake.calls.length = 0;
    expect(new Uint8Array(await lib.sampleBytes(ref))).toEqual(new Uint8Array([9, 9]));
    expect(fake.calls).toEqual([]);
  });
});

describe('cloud projects', () => {
  it('saves to Projects in the app folder, uploads new samples once and opens again', async () => {
    const fake = fakePuter();
    window.puter = fake;
    const lib = new Library({ db: memoryDB(), decode: fakeDecode });
    let p = demoProject();
    await lib.putSample('smp1', { data: new Uint8Array([1, 2, 3, 4]).buffer, name: 'loop.wav', type: 'audio/wav' });
    p = E.addSample(p, { id: 'smp1', name: 'loop.wav', local: 'smp1', duration: 1 }).project;
    const path = await lib.cloudPathFor('My: Song');
    expect(path).toBe('/ada/AppData/app-test/Projects/My- Song.msproj');
    const r = await lib.saveCloud(p, {}, { path });
    expect(r.path).toBe(path);
    expect(fake.files.has('/ada/AppData/app-test/Samples/smp1.wav')).toBe(true);
    const json = JSON.parse(new TextDecoder().decode(fake.files.get(path)));
    expect(json.samples.smp1.path).toBe('/ada/AppData/app-test/Samples/smp1.wav');

    // A second save does not upload the sample again.
    fake.calls.length = 0;
    await lib.saveCloud(p, {}, { path });
    expect(fake.calls.filter((c) => c === 'write')).toHaveLength(1);

    const back = await lib.loadCloud(path);
    expect(back.name).toBe(p.name);
    expect(back.samples.smp1.path).toBe('/ada/AppData/app-test/Samples/smp1.wav');
    expect(back.patterns.map((x) => x.id)).toEqual(p.patterns.map((x) => x.id));
  });

  it('never touches Puter while signed out', async () => {
    const fake = fakePuter({ signedIn: false });
    window.puter = fake;
    const lib = new Library({ db: memoryDB(), decode: fakeDecode });
    await expect(lib.saveCloud(demoProject(), {}, { path: '/x/y.msproj' })).rejects.toThrow(/Sign in/);
    await expect(lib.loadCloud('/x/y.msproj')).rejects.toThrow(/Sign in/);
    expect(await lib.sampleBytes({ id: 'a', name: 'a', path: '/x/a.wav' })).toBe(null);
    expect(await puterApi.homeDir()).toBe('~');
    expect(fake.calls).toEqual([]);
  });
});

describe('device files', () => {
  it('embeds samples in a downloaded project and restores them on open', async () => {
    const lib = new Library({ db: memoryDB(), decode: fakeDecode, puter: { isSignedIn: () => false } });
    await lib.putSample('s1', { data: new Uint8Array([5, 6, 7]).buffer, name: 'hat.wav', type: 'audio/wav' });
    const p = E.addSample(newProject(), { id: 's1', name: 'hat.wav', local: 's1' }).project;
    const { blob, missing } = await lib.exportFile(p, {});
    expect(missing).toEqual([]);
    const text = await blob.text();
    expect(JSON.parse(text).embedded.s1.type).toBe('audio/wav');

    const other = new Library({ db: memoryDB(), decode: fakeDecode, puter: { isSignedIn: () => false } });
    const back = await other.readProjectText(text);
    expect(back.samples.s1.local).toBe('s1');
    expect(new Uint8Array((await other.sampleRecord('s1')).data)).toEqual(new Uint8Array([5, 6, 7]));
  });

  it('rejects files that are not projects', async () => {
    const lib = new Library({ db: memoryDB() });
    await expect(lib.readProjectText('nope')).rejects.toThrow(/not a Music Studio project/);
    await expect(lib.readProjectText('{"kind":"other"}')).rejects.toThrow(/not a Music Studio project/);
  });

  it('base64 round trips binary data', () => {
    const b = new Uint8Array(70000).map((_, i) => i * 7);
    expect(new Uint8Array(fromBase64(toBase64(b)))).toEqual(b);
  });
});

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces drafts after edits and skips gesture previews', async () => {
    const store = new Store(newProject());
    const writeDraft = vi.fn(async () => {});
    const a = new Autosave({ store, writeDraft, writeCloud: vi.fn() }).start();
    store.begin('Drag');
    store.preview((p) => E.setProjectProps(p, { bpm: 100 }));
    vi.advanceTimersByTime(3000);
    expect(writeDraft).not.toHaveBeenCalled();
    store.commit();
    for (let i = 0; i < 5; i++) {
      store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 90 + i }));
      vi.advanceTimersByTime(1000);
    }
    expect(writeDraft).not.toHaveBeenCalled();
    expect(a.pending).toBe(true);
    vi.advanceTimersByTime(2000);
    await vi.runAllTimersAsync();
    expect(writeDraft).toHaveBeenCalledTimes(1);
    expect(a.pending).toBe(false);
  });

  it('autosaves cloud projects at a relaxed interval only when enabled', async () => {
    const store = new Store(newProject());
    const writeCloud = vi.fn(async () => store.markSaved());
    let enabled = false;
    const a = new Autosave({ store, writeDraft: async () => {}, writeCloud, cloudEnabled: () => enabled, now: () => Date.now() }).start();
    store.apply('Edit', (p) => E.setProjectProps(p, { bpm: 99 }));
    await vi.advanceTimersByTimeAsync(120000);
    expect(writeCloud).not.toHaveBeenCalled();
    enabled = true;
    store.apply('Edit', (p) => E.setProjectProps(p, { bpm: 98 }));
    await vi.advanceTimersByTimeAsync(30000);
    expect(writeCloud).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31000);
    expect(writeCloud).toHaveBeenCalledTimes(1);
    // Constant editing still saves within the maximum wait.
    for (let i = 0; i < 12; i++) {
      store.apply('Edit', (p) => E.setProjectProps(p, { bpm: 80 + i }));
      await vi.advanceTimersByTimeAsync(30000);
    }
    expect(writeCloud.mock.calls.length).toBeGreaterThanOrEqual(2);
    a.stop();
  });
});

describe('storage feature in the app', () => {
  const mount = () => {
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
    return { root, storage };
  };

  it('opens the demo song on first launch and restores the draft afterwards, without Puter calls when signed out', async () => {
    const fake = fakePuter({ signedIn: false });
    window.puter = fake;
    const { root, storage } = mount();
    const db = memoryDB();
    const app = new App(root, { storage });
    app.start([{ install: (a) => install(a, { db }) }]);
    expect(app.store.project.name).toBe('Demo Song');
    await app.restored;

    // Edit, then let the draft autosave run.
    app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 101 }));
    await app.autosave.flushDraft();
    const draft = await db.get('drafts', 'session');
    expect(JSON.parse(draft.json).bpm).toBe(101);
    expect(draft.dirty).toBe(true);

    // Signed-out save keeps the project in this browser.
    vi.spyOn(app.files, 'localSaveNotice').mockResolvedValue();
    await app.files.save();
    expect(app.file.local).toBeTruthy();
    expect(app.store.dirty).toBe(false);
    expect((await app.library.listLocal())[0].name).toBe('Demo Song');

    // A second launch restores the session instead of the demo.
    app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 77 }));
    await app.autosave.flushDraft();
    const { root: root2 } = mount();
    const app2 = new App(root2, { storage });
    app2.start([{ install: (a) => install(a, { db }) }]);
    await app2.restored;
    expect(app2.store.project.bpm).toBe(77);
    expect(app2.store.dirty).toBe(true);
    expect(app2.file?.local).toBe(app.file.local);
    expect(fake.calls.filter((c) => c !== 'getUser')).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('asks for a name on the first signed-out save of an untitled project', async () => {
    window.puter = fakePuter({ signedIn: false });
    const { root, storage } = mount();
    const app = new App(root, { storage });
    app.start([{ install: (a) => install(a, { db: memoryDB() }) }]);
    await app.restored;
    app.store.load(newProject());
    const saveAs = vi.spyOn(app.files, 'saveAs').mockResolvedValue(false);
    await app.files.save();
    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(app.file).toBe(null);
  });

  it('reopens a saved cloud project from the cloud (it may be newer) instead of its clean draft', async () => {
    const fake = fakePuter();
    window.puter = fake;
    const path = '/ada/MusicStudio/Projects/Song.msproj';
    const elsewhere = { ...demoProject(), name: 'Song', bpm: 141 };
    fake.files.set(path, new TextEncoder().encode(serializeProject(elsewhere)));
    const db = memoryDB();
    await db.put('drafts', 'session', { json: serializeProject({ ...elsewhere, bpm: 99 }), file: { path, name: 'Song' }, dirty: false, at: 1 });
    const { root, storage } = mount();
    storage.setItem('music-studio:prefs', JSON.stringify({ launched: true }));
    const app = new App(root, { storage });
    app.start([{ install: (a) => install(a, { db }) }]);
    await app.restored;
    await new Promise((r) => setTimeout(r, 0));
    expect(app.store.project.bpm).toBe(141);
    expect(app.file.path).toBe(path);
  });

  it('imports audio as a sampler channel or into an existing channel in one undo step', async () => {
    window.puter = fakePuter({ signedIn: false });
    const { root, storage } = mount();
    const db = memoryDB();
    const app = new App(root, { storage });
    app.start([{ install: (a) => install(a, { db }) }]);
    await app.restored;
    const before = app.store.undoStack.length;
    const blob = new Blob([new Uint8Array(480)], { type: 'audio/wav' });
    // jsdom has no audio decoder: stand in for the browser's.
    const orig = globalThis.OfflineAudioContext;
    globalThis.OfflineAudioContext = class {
      decodeAudioData() {
        return Promise.resolve({ numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array(480) });
      }
    };
    try {
      const r = await app.importAudio(blob, { name: 'tone.wav' });
      expect(r.duration).toBeCloseTo(0.01, 5);
      expect(app.store.undoStack.length).toBe(before + 1);
      const ch = app.store.project.channels.find((c) => c.id === r.channelId);
      expect(ch).toMatchObject({ type: 'sampler', name: 'tone', sample: r.sampleId });
      expect(app.store.project.samples[r.sampleId]).toMatchObject({ name: 'tone.wav', local: r.sampleId });
      expect(app.samples.has(r.sampleId)).toBe(true);
      expect((await db.get('samples', r.sampleId)).name).toBe('tone.wav');

      const r2 = await app.importAudio(blob, { name: 'other.wav', channel: r.channelId });
      expect(r2.channelId).toBe(r.channelId);
      expect(app.store.project.channels.find((c) => c.id === r.channelId).sample).toBe(r2.sampleId);
      expect(app.store.undoStack.length).toBe(before + 2);

      await expect(app.importAudio({ size: 200 * 1024 * 1024, name: 'huge.wav' })).rejects.toThrow(/up to 100 MB/);
    } finally {
      globalThis.OfflineAudioContext = orig;
    }
  });
});

describe('save races', () => {
  /** A minimal app and a library whose cloud saves wait for `release()`. */
  function setup() {
    const events = {};
    const prefs = new Map();
    const app = {
      store: new Store(newProject()),
      file: null,
      saving: false,
      engine: { stop() {} },
      samples: { ids: () => [], delete() {} },
      emit: (n) => (events[n] || []).slice().forEach((f) => f()),
      on: (n, f) => {
        (events[n] ||= []).push(f);
        return () => (events[n] = events[n].filter((x) => x !== f));
      },
      prefs: { get: (k) => prefs.get(k), set: (k, v) => prefs.set(k, v) },
      notify() {},
    };
    let release;
    const saved = [];
    const lib = {
      saveCloud: async (project, _view, { path }) => {
        saved.push(project);
        await new Promise((r) => (release = r));
        return { path, missing: [] };
      },
      loadSamples: async () => ({ loaded: 0, missing: [] }),
    };
    const files = new ProjectFiles(app, lib);
    return { app, files, saved, release: () => release() };
  }

  it('a save that ends after another project opened leaves that project alone', async () => {
    const { app, files, release } = setup();
    app.file = { path: 'Projects/A.msproj', name: 'A' };
    app.store.apply('Edit', (p) => E.setProjectProps(p, { name: 'A2' }));
    const saving = files.saveCloudTo(app.file.path, { auto: true });
    await Promise.resolve();
    const b = newProject();
    files.loadProject({ ...b, name: 'B' }, { path: 'Projects/B.msproj', name: 'B' }, { dirty: true });
    release();
    expect(await saving).toBe(true);
    expect(app.file.path).toBe('Projects/B.msproj');
    expect(app.store.dirty).toBe(true);
  });

  it('saves the drag start state while a drag is in progress', async () => {
    const { app, files, saved, release } = setup();
    const start = app.store.project;
    app.store.begin('Tempo');
    app.store.preview((p) => E.setProjectProps(p, { bpm: 90 }));
    const saving = files.saveCloudTo('Projects/A.msproj');
    release();
    await saving;
    expect(saved[0]).toBe(start);
    app.store.commit();
    expect(app.store.dirty).toBe(true);
  });

  it('cloud autosave runs again for edits that waited on a write in flight', async () => {
    const store = new Store(newProject());
    let release;
    let writes = 0;
    const pending = [];
    const timers = { setTimeout: (f) => (pending.push(f), f), clearTimeout: (t) => pending.splice(pending.indexOf(t) >>> 0, 1) };
    const a = new Autosave({ store, writeDraft: async () => {}, writeCloud: () => (writes++, new Promise((r) => (release = r))), cloudEnabled: () => true, timers });
    a.start();
    store.apply('One', (p) => E.setProjectProps(p, { name: 'one' }));
    a.cloudTimer();
    await new Promise((r) => setTimeout(r, 0));
    store.apply('Two', (p) => E.setProjectProps(p, { name: 'two' }));
    a.cloudTimer(); // fires while the first write is still running
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.cloudTimer).not.toBe(null);
    a.cloudTimer();
    await new Promise((r) => setTimeout(r, 0));
    expect(writes).toBe(2);
    a.stop();
  });
});

describe('serialize helper', () => {
  it('serializes the view pattern', () => {
    const p = demoProject();
    expect(JSON.parse(serializeProject(p, { pattern: p.patterns[2].id })).ui.pattern).toBe(p.patterns[2].id);
  });
});

describe('app folder', () => {
  afterEach(() => {
    delete window.puter;
    puterApi.resetAccountCache();
  });

  it('lives in the app\'s AppData folder, never in the home folder', async () => {
    window.puter = fakePuter();
    puterApi.resetAccountCache();
    expect(await puterApi.appDir()).toBe('/ada/AppData/app-test');
    expect(await puterApi.appSubdir('Samples')).toBe('/ada/AppData/app-test/Samples');
    expect(window.puter.calls).not.toContain('getUser');
  });
});
