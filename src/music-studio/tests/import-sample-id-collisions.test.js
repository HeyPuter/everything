import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { Library } from '../src/storage/library.js';
import { ProjectFiles } from '../src/storage/files.js';
import { memoryDB, openDB } from '../src/storage/idb.js';
import { Store } from '../src/model/store.js';
import { createProject, createChannel } from '../src/model/project.js';
import { SampleCache } from '../src/audio/samples.js';
import { encodeWav, decodeWavSamples } from '../src/io/wav.js';

const wav = (value) => encodeWav({ channels: [new Float32Array([value, value])], rate: 48000 }, { bits: 16, dither: false });
const original = wav(0.25), incoming = wav(-0.5);
const decode = (data) => decodeWavSamples(Uint8Array.from(new Uint8Array(data)).buffer);
const bytes = (data) => data && [...new Uint8Array(data)];
const ref = { id: '00000000', name: 'Original.wav', local: '00000000', path: null, duration: 2 / 48000, rate: 48000, channels: 1 };
const databases = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function database(kind = 'memory') {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const db = kind === 'memory' ? memoryDB() : await openDB('sample-import-collisions');
  databases.push(db);
  return db;
}
function appFor(lib, project = createProject()) {
  vi.stubGlobal('OfflineAudioContext', class { async decodeAudioData(data) { const audio = decode(data); return { numberOfChannels: 1, sampleRate: audio.rate, getChannelData: () => audio.channels[0] }; } });
  const app = { store: new Store(project), samples: new SampleCache(), notify: vi.fn() };
  return { app, files: new ProjectFiles(app, lib) };
}
function library(db) { return new Library({ db, decode, puter: { isSignedIn: () => false } }); }
function collide() {
  const random = crypto.getRandomValues.bind(crypto);
  let calls = 0;
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((data) => data.length === 8 && calls++ < 2 ? data.fill(0) : random(data));
}
function importFile(files, data = incoming, options = {}) { return files.importAudio(new Blob([data], { type: 'audio/wav' }), { name: 'New.wav', ...options }); }
function synchronizeWrites(db, fail = false) {
  const list = Array.isArray(db) ? [...new Set(db)] : [db];
  let release, entered = 0;
  const ready = new Promise((r) => { release = r; });
  for (const current of list) {
    const put = current.put;
    current.put = async (...args) => {
      if (args[0] === 'samples' && ++entered <= 2) { if (entered === 2) release(); await ready; }
      if (fail) throw new Error('Storage is full');
      return put(...args);
    };
  }
}

it.each([false, true])('preserves existing sample bytes and decoded audio when importing into an existing channel=%s', async (target) => {
  const db = await database(), lib = library(db);
  await lib.putSample(ref.id, { data: original, name: ref.name });
  const ch = createChannel({ type: 'audio', sample: ref.id });
  const p = createProject({ channels: [ch] }); p.samples[ref.id] = ref;
  const { app, files } = appFor(lib, p);
  app.samples.set(ref.id, decode(original));
  const old = app.samples.get(ref.id);
  collide();
  const result = await importFile(files, incoming, target ? { channel: ch.id } : {});
  expect(bytes(await lib.sampleBytes(ref))).toEqual(bytes(original));
  expect(result.sampleId).not.toBe(ref.id);
  expect(app.store.project.samples[ref.id]).toBe(ref);
  expect(app.samples.get(ref.id)).toBe(old);
  expect(bytes(await lib.sampleBytes(ref))).toEqual(bytes(original));
  expect(bytes(await lib.sampleBytes(app.store.project.samples[result.sampleId]))).toEqual(bytes(incoming));
  app.store.undo(); expect(app.store.project).toBe(p);
  expect(bytes(await lib.sampleBytes(ref))).toEqual(bytes(original));
  app.store.redo(); expect(app.store.project.channels.find((c) => c.id === result.channelId).sample).toBe(result.sampleId);
});

it.each(['memory', 'indexed'])('does not overwrite another saved project’s audio in %s storage', async (kind) => {
  const db = await database(kind), lib = library(db);
  await lib.putSample(ref.id, { data: original, name: ref.name });
  const oldProject = createProject(); oldProject.samples[ref.id] = ref;
  await lib.saveLocal(oldProject, {}, { key: 'older-project' });
  const { files } = appFor(lib);
  collide();
  const result = await importFile(files);
  const reopened = await lib.loadLocal('older-project');
  expect(bytes(await lib.sampleBytes(reopened.samples[ref.id]))).toEqual(bytes(original));
  expect(result.sampleId).not.toBe(ref.id);
  expect(lib.temporarySamples.has(ref.id)).toBe(false);
});

it.each(['memory', 'indexed'])('keeps concurrent imports through separate libraries distinct in %s storage', async (kind) => {
  const db = await database(kind);
  const other = kind === 'indexed' ? await openDB('sample-import-collisions') : db;
  if (other !== db) databases.push(other);
  const a = library(db), b = library(other), first = appFor(a), second = appFor(b);
  synchronizeWrites([db, other]);
  collide();
  const [left, right] = await Promise.all([importFile(first.files, original), importFile(second.files, incoming)]);
  expect(left.sampleId).not.toBe(right.sampleId);
  expect(bytes(await a.sampleBytes(first.app.store.project.samples[left.sampleId]))).toEqual(bytes(original));
  expect(bytes(await b.sampleBytes(second.app.store.project.samples[right.sampleId]))).toEqual(bytes(incoming));
  expect(a.temporarySamples.size + b.temporarySamples.size).toBe(0);
});

it('reserves pending imports before either write completes', async () => {
  const db = await database(), lib = library(db), { app, files } = appFor(lib);
  synchronizeWrites(db);
  collide();
  const [first, second] = await Promise.all([importFile(files, original), importFile(files, incoming)]);
  expect(first.sampleId).not.toBe(second.sampleId);
  expect(Object.keys(app.store.project.samples)).toHaveLength(2);
  expect(bytes(await lib.sampleBytes(app.store.project.samples[first.sampleId]))).toEqual(bytes(original));
  expect(bytes(await lib.sampleBytes(app.store.project.samples[second.sampleId]))).toEqual(bytes(incoming));
  app.store.undo(); expect(Object.keys(app.store.project.samples)).toHaveLength(1);
  app.store.redo(); expect(Object.keys(app.store.project.samples)).toHaveLength(2);
});

it('does not overwrite retained temporary bytes from an earlier import', async () => {
  const db = await database(), lib = library(db), { files } = appFor(lib);
  db.put = vi.fn(async () => { throw new Error('Storage full'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await lib.putSample(ref.id, { data: original, name: ref.name }).catch(() => {});
  collide();
  const result = await importFile(files);
  expect(bytes(await lib.sampleBytes(ref))).toEqual(bytes(original));
  expect(result.sampleId).not.toBe(ref.id);
  expect(bytes(await lib.sampleBytes({ id: result.sampleId }))).toEqual(bytes(incoming));
});

it('keeps two pending failed writes from replacing each other’s temporary audio', async () => {
  const db = await database(), lib = library(db), first = appFor(lib), second = appFor(lib);
  synchronizeWrites(db, true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  collide();
  const [a, b] = await Promise.all([importFile(first.files, original), importFile(second.files, incoming)]);
  expect(a.sampleId).not.toBe(b.sampleId);
  expect(bytes(await lib.sampleBytes({ id: a.sampleId }))).toEqual(bytes(original));
  expect(bytes(await lib.sampleBytes({ id: b.sampleId }))).toEqual(bytes(incoming));
});

it.each(['undo', 'gesture', 'alias', 'missing channel'])('does not reuse missing audio referenced by %s', async (kind) => {
  const db = await database(), lib = library(db), p = createProject();
  p.samples.old = kind === 'alias' ? { ...ref, id: 'old' } : ref;
  if (kind !== 'alias') { p.samples = { [ref.id]: ref }; }
  if (kind === 'missing channel') { p.samples = {}; p.channels = [createChannel({ type: 'audio', sample: ref.id })]; }
  const { app, files } = appFor(lib, p);
  if (kind === 'undo') app.store.apply('Remove missing audio', (q) => ({ ...q, samples: {} }));
  if (kind === 'gesture') { app.store.begin('Remove missing audio'); app.store.preview((q) => ({ ...q, samples: {} })); }
  collide();
  const result = await importFile(files);
  expect(result.sampleId).not.toBe(ref.id);
  expect(await lib.sampleBytes(ref)).toBeNull();
});

it('does not shadow durable audio in temporary recovery after a quota failure', async () => {
  const db = await database(), lib = library(db), { files } = appFor(lib);
  await lib.putSample(ref.id, { data: original, name: ref.name });
  db.put = vi.fn(async () => { throw new Error('Storage full'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  collide();
  const result = await importFile(files);
  expect(bytes(await lib.sampleBytes(ref))).toEqual(bytes(original));
  expect(result.sampleId).not.toBe(ref.id);
  expect(bytes(await lib.sampleBytes({ id: result.sampleId }))).toEqual(bytes(incoming));
  expect(lib.pendingSampleIds.size).toBe(0);
});

it('retains newly imported audio when the database connection has closed', async () => {
  const db = await database('indexed'), lib = library(db), { files } = appFor(lib);
  db.close();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const result = await importFile(files);
  expect(bytes(lib.temporarySamples.get(result.sampleId)?.data)).toEqual(bytes(incoming));
  expect(lib.pendingSampleIds.size).toBe(0);
});

it('keeps cached audio whose project reference was removed before import', async () => {
  const db = await database(), lib = library(db), { app, files } = appFor(lib);
  app.samples.set(ref.id, decode(original));
  const cached = app.samples.get(ref.id);
  collide();
  const result = await importFile(files);
  expect(result.sampleId).not.toBe(ref.id);
  expect(app.samples.get(ref.id)).toBe(cached);
});

it('collects shared sample history once during an import', async () => {
  const db = await database(), lib = library(db), p = createProject();
  let reads = 0;
  for (let i = 0; i < 1000; i++) p.samples[`s${i}`] = { id: `s${i}`, name: 'Missing', get local() { reads++; return `l${i}`; } };
  const { app, files } = appFor(lib, p);
  for (let i = 0; i < 100; i++) app.store.apply('Rename project', (q) => ({ ...q, name: `Project ${i}` }));
  reads = 0;
  await importFile(files);
  expect(reads).toBeLessThanOrEqual(2100);
  expect(Object.keys(app.store.project.samples)).toHaveLength(1001);
});
