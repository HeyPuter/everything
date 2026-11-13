import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Library, toBase64, fromBase64 } from '../src/storage/library.js';
import { ProjectFiles } from '../src/storage/files.js';
import { memoryDB } from '../src/storage/idb.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';
import { SampleCache } from '../src/audio/samples.js';
import { encodeWav, decodeWavSamples } from '../src/io/wav.js';
import { serializeProject } from '../src/model/serialize.js';
import { Engine } from '../src/engine/engine.js';
import { webcrypto } from 'node:crypto';

const wav = (value) => encodeWav({ channels: [new Float32Array([value, value])], rate: 48000 }, { bits: 16, dither: false });
const original = wav(0.25), replacement = wav(-0.5);
const decode = (bytes) => decodeWavSamples(Uint8Array.from(new Uint8Array(bytes)).buffer);
const bytes = (value) => [...new Uint8Array(value)];
const project = () => ({ ...newProject(), samples: { shared: { id: 'shared', local: 'shared', name: 'tone.wav', path: null } } });
const file = (data = replacement) => {
  const text = JSON.stringify({ ...JSON.parse(serializeProject(project())), embedded: { shared: { type: 'audio/wav', data: toBase64(data) } } });
  return { name: 'Incoming.msproj', size: text.length, text: async () => text, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(4) }) };
};
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup() {
  const lib = new Library({ db: memoryDB(), decode, puter: { isSignedIn: () => false } });
  await lib.putSample('shared', { data: original, name: 'tone.wav' });
  const store = new Store(project());
  const engine = new Engine(store);
  const app = { store, samples: new SampleCache(engine), engine, emit() {}, notify: vi.fn(), prefs: { get: () => [], set() {} } };
  app.samples.set('shared', decode(original));
  const files = new ProjectFiles(app, lib);
  return { lib, app, files };
}

it('does not replace existing audio bytes when an embedded project open is canceled', async () => {
  const { lib, app, files } = await setup();
  const before = app.store.project;
  vi.spyOn(files, 'confirmDiscard').mockResolvedValue(false);
  expect(await files.openFile(file())).toBe(false);
  expect(app.store.project).toBe(before);
  expect(bytes(await lib.sampleBytes(before.samples.shared))).toEqual(bytes(original));
  const saved = JSON.parse(await (await lib.exportFile(before, {})).blob.text());
  expect(bytes(fromBase64(saved.embedded.shared.data))).toEqual(bytes(original));
});

it('plays incoming embedded audio while preserving the original project for reopening', async () => {
  const { lib, app, files } = await setup();
  const before = app.store.project;
  const incoming = await lib.readProjectText(await file().text());
  await files.loadProject(incoming, null);
  expect(app.samples.get('shared').channels[0][0]).toBeCloseTo(-0.5, 3);
  expect(app.engine.captureRenderSnapshot().samples.get('shared').channels[0][0]).toBeCloseTo(-0.5, 3);
  expect(bytes(await lib.sampleBytes(before.samples.shared))).toEqual(bytes(original));
  await files.loadProject(before, null);
  expect(app.samples.get('shared').channels[0][0]).toBeCloseTo(0.25, 3);
  expect(app.engine.captureRenderSnapshot().samples.get('shared').channels[0][0]).toBeCloseTo(0.25, 3);
});

it('keeps simultaneous embedded reads with conflicting IDs independent', async () => {
  const db = memoryDB();
  const lib = new Library({ db, decode }), other = new Library({ db, decode });
  const [a, b] = await Promise.all([lib.readProjectText(await file(original).text()), other.readProjectText(await file(replacement).text())]);
  expect(bytes(await lib.sampleBytes(a.samples.shared))).toEqual(bytes(original));
  expect(bytes(await lib.sampleBytes(b.samples.shared))).toEqual(bytes(replacement));
});

it('reuses identical stored audio and its decoded cache when reopening an embedded copy', async () => {
  const { lib, app, files } = await setup();
  const cached = app.samples.get('shared');
  const incoming = await lib.readProjectText(await file(original).text());
  await files.loadProject(incoming, null);
  expect(app.samples.get('shared')).toBe(cached);
  expect(bytes(await lib.sampleBytes(incoming.samples.shared))).toEqual(bytes(original));
});

it('preserves both versions when new embedded audio must remain temporary', async () => {
  const { lib, app, files } = await setup();
  const before = app.store.project;
  const db = await lib.db();
  vi.spyOn(db, 'put').mockRejectedValue(new Error('Storage full'));
  const incoming = await lib.readProjectText(await file().text());
  expect(lib.hasTemporarySamples(incoming)).toBe(true);
  expect(lib.hasTemporarySamples(before)).toBe(false);
  expect(await files.loadProject(incoming, null)).toEqual({ loaded: 1, missing: [] });
  expect(app.engine.captureRenderSnapshot().samples.get('shared').channels[0][0]).toBeCloseTo(-0.5, 3);
  expect(bytes(await lib.sampleBytes(before.samples.shared))).toEqual(bytes(original));
  const saved = JSON.parse(await (await lib.exportFile(incoming, {})).blob.text());
  expect(bytes(fromBase64(saved.embedded.shared.data))).toEqual(bytes(replacement));
});

it('saves differing embedded audio to separate cloud paths without overwriting the original', async () => {
  const { lib, app } = await setup();
  const text = JSON.parse(await file().text());
  text.samples.shared.path = '/Samples/shared.wav';
  const incoming = await lib.readProjectText(JSON.stringify(text));
  const writes = new Map();
  lib.puter = {
    requireSignedIn() {}, isSignedIn: () => true, appSubdir: async () => '/Samples',
    joinPath: (dir, name) => `${dir}/${name}`,
    writeFile: async (path, blob) => { writes.set(path, blob); return { path }; },
  };
  const first = await lib.saveCloud(app.store.project, {}, { path: '/First.msproj' });
  const second = await lib.saveCloud(incoming, {}, { path: '/Second.msproj' });
  const a = first.samples.shared.path, b = second.samples.shared.path;
  expect(b).not.toBe(a);
  expect(bytes(await writes.get(a).arrayBuffer())).toEqual(bytes(original));
  expect(bytes(await writes.get(b).arrayBuffer())).toEqual(bytes(replacement));
  const reopened = await lib.readProjectText(await writes.get('/Second.msproj').text());
  expect(bytes(await lib.sampleBytes(reopened.samples.shared))).toEqual(bytes(replacement));
});

it('downloads an independent sample on another device instead of falling back to a conflicting legacy ID', async () => {
  const { lib, app } = await setup();
  const remote = { ...app.store.project.samples.shared, local: 'embedded-0123456789abcdef', path: '/Samples/new.wav' };
  lib.puter = { isSignedIn: () => true, readFile: vi.fn(async () => new Blob([replacement], { type: 'audio/wav' })) };
  expect(bytes(await lib.sampleBytes(remote))).toEqual(bytes(replacement));
  expect(bytes(await lib.sampleBytes(app.store.project.samples.shared))).toEqual(bytes(original));
  expect(bytes(await lib.sampleBytes(remote))).toEqual(bytes(replacement));
  expect(lib.puter.readFile).toHaveBeenCalledOnce();
});

it('reuses stored bytes when the same external embedded file is read repeatedly', async () => {
  const db = memoryDB();
  const lib = new Library({ db, decode });
  const first = await lib.readProjectText(await file().text());
  const second = await lib.readProjectText(await file().text());
  expect(second.samples.shared.local).toBe(first.samples.shared.local);
  expect(await db.all('samples')).toHaveLength(1);
  expect(bytes(await lib.sampleBytes(second.samples.shared))).toEqual(bytes(replacement));
});

it('checks downloaded audio before caching it under an embedded content key', async () => {
  const source = new Library({ db: memoryDB(), decode });
  const incoming = await source.readProjectText(await file().text());
  const remote = { ...incoming.samples.shared, path: '/Samples/new.wav' };
  const { lib, app } = await setup();
  const readFile = vi.fn().mockResolvedValueOnce(new Blob([original])).mockResolvedValue(new Blob([replacement]));
  lib.puter = { isSignedIn: () => true, readFile };
  expect(await lib.sampleBytes(remote)).toBeNull();
  expect(await lib.sampleRecord(remote.local)).toBeNull();
  expect(bytes(await lib.sampleBytes(remote))).toEqual(bytes(replacement));
  expect(bytes(await lib.sampleBytes(app.store.project.samples.shared))).toEqual(bytes(original));
  expect(bytes(await lib.sampleBytes(remote))).toEqual(bytes(replacement));
  expect(readFile).toHaveBeenCalledTimes(2);
});

it.each(['unavailable', 'rejected'])('keeps differing audio independent when content hashing is %s', async (mode) => {
  vi.stubGlobal('crypto', {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    ...(mode === 'rejected' ? { subtle: { digest: async () => { throw new Error('Unavailable'); } } } : {}),
  });
  const { lib, app, files } = await setup();
  const before = app.store.project;
  const incoming = await lib.readProjectText(await file().text());
  await files.loadProject(incoming, null);
  expect(app.samples.get('shared').channels[0][0]).toBeCloseTo(-0.5, 3);
  expect(bytes(await lib.sampleBytes(before.samples.shared))).toEqual(bytes(original));
});

it.each([
  ['invalid base64', { data: '%%%broken%%%' }],
  ['missing bytes', {}],
  ['non-text bytes', { data: 42 }],
  ['null entry', null],
  ['undecodable audio', { data: toBase64(new Uint8Array([1, 2, 3]).buffer) }],
])('reports %s in embedded audio instead of playing an older sample with the same ID', async (_name, embedded) => {
  const { lib, app, files } = await setup();
  const before = app.store.project;
  const text = JSON.parse(await file().text());
  text.embedded.shared = embedded;
  const incoming = await lib.readProjectText(JSON.stringify(text));
  expect(await files.loadProject(incoming, null)).toEqual({ loaded: 0, missing: ['tone.wav'] });
  expect(app.samples.has('shared')).toBe(false);
  expect(app.engine.captureRenderSnapshot().samples.has('shared')).toBe(false);
  expect(app.notify).toHaveBeenCalledWith(expect.stringContaining('tone.wav'), expect.objectContaining({ error: true }));
  expect(bytes(await lib.sampleBytes(before.samples.shared))).toEqual(bytes(original));
  await files.loadProject(before, null);
  expect(app.samples.get('shared').channels[0][0]).toBeCloseTo(0.25, 3);
});

it('recovers damaged embedded data from its explicit cloud copy without using a conflicting local sample', async () => {
  const { lib, app, files } = await setup();
  const before = app.store.project;
  const text = JSON.parse(await file().text());
  text.embedded.shared.data = '%%%broken%%%';
  text.samples.shared.path = '/Samples/backup.wav';
  lib.puter = { isSignedIn: () => true, readFile: vi.fn(async () => new Blob([replacement], { type: 'audio/wav' })) };
  const incoming = await lib.readProjectText(JSON.stringify(text));
  expect(await files.loadProject(incoming, null)).toEqual({ loaded: 1, missing: [] });
  expect(app.samples.get('shared').channels[0][0]).toBeCloseTo(-0.5, 3);
  expect(lib.puter.readFile).toHaveBeenCalledExactlyOnceWith('/Samples/backup.wav');
  expect(bytes(await lib.sampleBytes(before.samples.shared))).toEqual(bytes(original));
});

it('retains ordinary external sample references when no embedded entry was supplied', async () => {
  const { lib, app, files } = await setup();
  const cached = app.samples.get('shared');
  const text = JSON.parse(await file().text());
  delete text.embedded.shared;
  const incoming = await lib.readProjectText(JSON.stringify(text));
  expect(await files.loadProject(incoming, null)).toEqual({ loaded: 0, missing: [] });
  expect(app.samples.get('shared')).toBe(cached);
});
