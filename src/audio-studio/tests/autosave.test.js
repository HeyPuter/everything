import { describe, it, expect, vi } from 'vitest';
import { AutosaveStore, buildManifest, planAutosave, recoverable, validManifest, DIR_NAME } from '../src/storage/autosave.js';
import { installAutosave } from '../src/storage/autosave-controller.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { Emitter } from '../src/lib/emitter.js';

/** In-memory stand-in for the origin private file system. */
class MemFile {
  constructor(name) {
    this.kind = 'file';
    this.name = name;
    this.parts = [];
    this.lastModified = Date.now();
  }
  async getFile() {
    const f = new Blob(this.parts);
    f.lastModified = this.lastModified;
    f.text = async () => new TextDecoder().decode(await f.arrayBuffer());
    return f;
  }
  async createWritable() {
    const staged = [];
    return {
      write: async (data) => staged.push(typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()),
      close: async () => {
        this.parts = staged;
        this.lastModified = Date.now();
      },
      abort: async () => {},
    };
  }
}

class MemDir {
  constructor(name = '') {
    this.kind = 'directory';
    this.name = name;
    this.children = new Map();
  }
  async getDirectoryHandle(name, { create } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw Object.assign(new Error('NotFound'), { name: 'NotFoundError' });
      this.children.set(name, new MemDir(name));
    }
    return this.children.get(name);
  }
  async getFileHandle(name, { create } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw Object.assign(new Error('NotFound'), { name: 'NotFoundError' });
      this.children.set(name, new MemFile(name));
    }
    return this.children.get(name);
  }
  async removeEntry(name) {
    if (!this.children.delete(name)) throw new Error('NotFound');
  }
  async *entries() {
    for (const e of [...this.children]) yield e;
  }
}

const docWith = (name, frames, value = 0.5) =>
  new AudioFile({ name, sampleRate: 44100, channels: [Channel.fromSamples(new Float32Array(frames).fill(value)), Channel.fromSamples(new Float32Array(frames).fill(-value))] });

describe('autosave store (mock OPFS)', () => {
  it('writes WAV plus manifest, lists, reads back and removes', async () => {
    const root = new MemDir();
    const store = new AutosaveStore(async () => root);
    const doc = docWith('Song.wav', 100000);
    doc.apply('Meta', { ...doc.state, meta: { title: 'T' }, markers: [{ id: 'm1', start: 10, duration: 0, name: 'Cue', type: 'cue', description: '' }] });
    const manifest = buildManifest(doc, { session: 's1', key: 's1-f1', now: 1000 });
    expect(validManifest(manifest)).toBe(true);
    expect(manifest.markers[0]).not.toHaveProperty('id');
    await store.write(doc, manifest);
    const dir = await root.getDirectoryHandle(DIR_NAME);
    expect([...dir.children.keys()].sort()).toEqual(['s1-f1.json', 's1-f1.wav']);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Song.wav', frames: 100000, meta: { title: 'T' } });
    const wav = new Uint8Array(await (await store.readAudio('s1-f1')).arrayBuffer());
    expect(wav.length).toBe(44 + 100000 * 2 * 4);
    const f = new Float32Array(wav.buffer.slice(44));
    expect([f[0], f[1], f[199999]]).toEqual([0.5, -0.5, -0.5]);
    await store.remove('s1-f1');
    expect(dir.children.size).toBe(0);
  });

  it('ignores damaged manifests and old orphaned audio', async () => {
    const root = new MemDir();
    const store = new AutosaveStore(async () => root);
    const dir = await root.getDirectoryHandle(DIR_NAME, { create: true });
    const bad = await dir.getFileHandle('x.json', { create: true });
    const w = await bad.createWritable();
    await w.write('{not json');
    await w.close();
    const orphan = await dir.getFileHandle('old.wav', { create: true });
    orphan.lastModified = Date.now() - 60 * 60 * 1000;
    const fresh = await dir.getFileHandle('fresh.wav', { create: true });
    fresh.lastModified = Date.now();
    expect(await store.list()).toEqual([]);
    expect([...dir.children.keys()]).toEqual(['fresh.wav']);
  });
});

describe('autosave planning', () => {
  it('picks dirty, changed audio documents within the byte budget, smallest first', () => {
    const a = docWith('a', 1000);
    const b = docWith('b', 10);
    const c = docWith('c', 100);
    for (const d of [a, b]) d.apply('x', { ...d.state, meta: { title: 'x' } });
    const written = new Map();
    expect(planAutosave([a, b, c], written, Infinity).map((d) => d.name)).toEqual(['b', 'a']);
    expect(planAutosave([a, b, c], written, 1000).map((d) => d.name)).toEqual(['b']);
    written.set(b.id, b.state);
    expect(planAutosave([a, b, c], written, Infinity).map((d) => d.name)).toEqual(['a']);
  });

  it('offers only files from sessions that are no longer running, newest first', () => {
    const m = (key, session, savedAt) => ({ version: 1, key, session, savedAt, sampleRate: 48000, channels: 2, frames: 10 });
    const list = [m('a', 'dead', 1), m('b', 'live', 2), m('c', 'dead', 3), { key: '../x', version: 1 }];
    expect(recoverable(list, new Set(['live'])).map((x) => x.key)).toEqual(['c', 'a']);
  });

  it('writes the audio its manifest describes when the document changes meanwhile', async () => {
    const root = new MemDir();
    // Real OPFS calls take a while: the document is edited before the audio file opens.
    let edit = null;
    const store = new AutosaveStore(async () => {
      await new Promise((r) => setTimeout(r, 5));
      edit?.();
      return root;
    });
    const doc = docWith('Song.wav', 1000);
    const manifest = buildManifest(doc, { session: 's1', key: 's1-f1' });
    const silence = () => doc.state.channels.map(() => Channel.silence(3000));
    edit = () => doc.apply('Silence', { ...doc.state, channels: silence() });
    await store.write(doc, manifest);
    expect(doc.length).toBe(3000);
    const wav = new Uint8Array(await (await store.readAudio('s1-f1')).arrayBuffer());
    expect(wav.length).toBe(44 + 1000 * 2 * 4);
    const f = new Float32Array(wav.buffer.slice(44));
    expect([f[0], f[1], f[1999]]).toEqual([0.5, -0.5, -0.5]);
  });
});

describe('autosave controller', () => {
  function fakeApp() {
    const app = new Emitter();
    app.documents = [];
    app.prefs = { get: () => undefined };
    app.notify = vi.fn();
    app.uniqueName = (n) => n;
    app.addDocument = (d) => {
      app.documents.push(d);
      app.emit('documents');
    };
    return app;
  }

  it('saves unsaved documents, cleans up after save and recovers in a new session', async () => {
    const root = new MemDir();
    const store = new AutosaveStore(async () => root);
    const app = fakeApp();
    const ctl = installAutosave(app, { store, interval: 1e9 });
    const doc = docWith('Take.wav', 5000);
    app.documents.push(doc);
    doc.on('change', (e) => app.emit('doc-change', doc, e));
    await ctl.run();
    expect((await store.list()).length).toBe(0); // clean documents are not saved
    const list = [{ id: 'iXML', bytes: Uint8Array.of(60, 0, 255, 62) }];
    doc.info.wavChunks = { sampleRate: 48000, channels: 1, frames: 5000, list };
    doc.apply('Edit', { ...doc.state, meta: { artist: 'A' } });
    await ctl.run();
    const saved = await store.list();
    expect(saved).toHaveLength(1);
    expect(saved[0].session).toBe(ctl.session);
    // A new session sees the file as recoverable once this one is gone.
    ctl.destroy();
    const app2 = fakeApp();
    const ctl2 = installAutosave(app2, { store, interval: 1e9 });
    const found = await ctl2.check();
    expect(found.map((m) => m.name)).toEqual(['Take.wav']);
    const docs = await ctl2.recover(found);
    expect(docs).toHaveLength(1);
    expect(docs[0].dirty).toBe(true);
    expect(docs[0].length).toBe(5000);
    expect(docs[0].state.meta).toEqual({ artist: 'A' });
    // The iXML and other chunks kept for the next WAV save are recovered too.
    const kept = docs[0].info.wavChunks;
    expect(kept).toMatchObject({ sampleRate: 48000, channels: 1, frames: 5000 });
    expect(kept.list.map((c) => [c.id, Array.from(c.bytes)])).toEqual([['iXML', [60, 0, 255, 62]]]);
    expect((await store.list()).filter((m) => m.session === ctl.session)).toHaveLength(0);
    // Saving the recovered file removes its new autosave entry.
    await ctl2.run();
    expect((await store.list()).length).toBe(1);
    docs[0].on('change', (e) => app2.emit('doc-change', docs[0], e));
    docs[0].markSaved();
    await new Promise((r) => setTimeout(r, 10));
    expect((await store.list()).length).toBe(0);
    ctl2.destroy();
  });

  it('leaves no recovery copy of a document closed or saved while its autosave was being written', async () => {
    const root = new MemDir();
    const store = new AutosaveStore(async () => root);
    const app = fakeApp();
    const ctl = installAutosave(app, { store, interval: 1e9 });
    const doc = docWith('Closed.wav', 600000);
    app.documents.push(doc);
    doc.on('change', (e) => app.emit('doc-change', doc, e));
    doc.apply('Edit', { ...doc.state, meta: { artist: 'A' } });
    // Closed (without saving) while the write is in progress.
    const pending = ctl.run();
    await new Promise((r) => setTimeout(r, 0));
    app.documents.length = 0;
    app.emit('documents');
    await pending;
    expect(await store.list()).toHaveLength(0);
    // Saved while the write is in progress.
    const doc2 = docWith('Saved.wav', 600000);
    app.documents.push(doc2);
    doc2.on('change', (e) => app.emit('doc-change', doc2, e));
    doc2.apply('Edit', { ...doc2.state, meta: { artist: 'B' } });
    const pending2 = ctl.run();
    await new Promise((r) => setTimeout(r, 0));
    doc2.markSaved();
    await pending2;
    expect(await store.list()).toHaveLength(0);
    ctl.destroy();
  });
});
