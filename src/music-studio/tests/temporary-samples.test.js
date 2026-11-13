import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Library, toBase64, fromBase64 } from '../src/storage/library.js';
import { ProjectFiles } from '../src/storage/files.js';
import { memoryDB } from '../src/storage/idb.js';
import { newProject } from '../src/model/demo.js';
import { serializeProject } from '../src/model/serialize.js';
import { encodeWav, decodeWavSamples } from '../src/io/wav.js';
import { install } from '../src/storage/index.js';
import { SampleCache } from '../src/audio/samples.js';

const data = encodeWav({ channels: [new Float32Array([0, 0.25, -0.25, 0])], rate: 48000 }, { bits: 16, dither: false });
// Normalize memoryDB's Node structuredClone buffers into the jsdom realm.
const decode = (buffer) => decodeWavSamples(Uint8Array.from(new Uint8Array(buffer)).buffer);
const ref = { id: 'embedded', name: 'tone.wav', local: null, path: null };
const embeddedText = () => JSON.stringify({ ...JSON.parse(serializeProject({ ...newProject(), samples: { embedded: ref } })), embedded: { embedded: { type: 'audio/wav', data: toBase64(data) } } });

function setup() {
  const db = memoryDB();
  db.persistent = true;
  const put = db.put;
  db.put = vi.fn((store, ...args) => store === 'samples' ? Promise.reject(new DOMException('Storage is full', 'QuotaExceededError')) : put(store, ...args));
  const lib = new Library({ db, puter: { isSignedIn: () => false }, decode });
  const app = new App(document.createElement('div'), { project: newProject(), storage: { getItem: () => null, setItem() {} } });
  app.notify = vi.fn();
  app.library = lib;
  const files = new ProjectFiles(app, lib);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('OfflineAudioContext', class {
    async decodeAudioData(buffer) {
      const decoded = decode(buffer);
      return { numberOfChannels: decoded.channels.length, sampleRate: decoded.rate, getChannelData: (i) => decoded.channels[i] };
    }
  });
  return { db, lib, app, files, restoreWrites: () => db.put.mockImplementation(put) };
}
const installed = [];
const listeners = [];
afterEach(() => {
  for (const app of installed.splice(0)) app.autosave.stop();
  for (const args of listeners.splice(0)) window.removeEventListener(...args);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('keeps imported audio available for a complete project download after quota failure', async () => {
  const { app, lib, files } = setup();
  const imported = await files.importAudio(new Blob([data], { type: 'audio/wav' }), { name: 'tone.wav' });
  expect(app.samples.has(imported.sampleId)).toBe(true);
  const result = await lib.exportFile(app.store.project, {});
  expect(result.missing).toEqual([]);
  const downloaded = JSON.parse(await result.blob.text());
  expect(new Uint8Array(fromBase64(downloaded.embedded[imported.sampleId].data))).toEqual(new Uint8Array(data));
  const restored = new Library({ db: memoryDB(), decode, puter: { isSignedIn: () => false } });
  const reopened = await restored.readProjectText(JSON.stringify(downloaded));
  const record = await restored.sampleRecord(imported.sampleId);
  expect(new Uint8Array(record.data)).toEqual(new Uint8Array(data));
  expect(decode(record.data).channels[0]).toHaveLength(4);
  expect(await restored.loadSamples(reopened, new SampleCache())).toEqual({ loaded: 1, missing: [] });
});

it('plays embedded audio and preserves its bytes when opening a project with full local storage', async () => {
  const { app, lib, files } = setup();
  const project = await lib.readProjectText(embeddedText());
  const result = await files.loadProject(project, null);
  expect(result).toEqual({ loaded: 1, missing: [] });
  expect(app.samples.has('embedded')).toBe(true);
  const downloaded = await lib.exportFile(project, {});
  expect(downloaded.missing).toEqual([]);
  const saved = JSON.parse(await downloaded.blob.text());
  expect(new Uint8Array(fromBase64(saved.embedded.embedded.data))).toEqual(new Uint8Array(data));
});


it('keeps temporary audio through undo and clears it on project replacement', async () => {
  const { app, lib, files } = setup();
  const { sampleId } = await files.importAudio(new Blob([data]), { name: 'tone.wav' });
  app.store.undo();
  expect(new Uint8Array(await lib.sampleBytes({ id: sampleId }))).toEqual(new Uint8Array(data));
  app.store.redo();
  expect(lib.hasTemporarySamples(app.store.project)).toBe(true);
  app.store.load(newProject());
  expect(lib.temporarySamples.size).toBe(0);
  expect(await lib.sampleRecord(sampleId)).toBeNull();
});

it.each(['delete', 'replace'])('drops a failed import’s temporary bytes after %s while persistence is pending', async (action) => {
  const { app, lib, files, db } = setup();
  let reject;
  db.put.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const target = app.store.project.channels[0].id;
  const pending = files.importAudio(new Blob([data]), { name: 'tone.wav', channel: target }).catch((err) => err);
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  if (action === 'replace') app.store.load(newProject());
  else app.store.apply('Delete channel', (p) => ({ ...p, channels: p.channels.filter((c) => c.id !== target) }));
  reject(new Error('Storage is full'));
  expect(await pending).toMatchObject({ message: action === 'delete' ? 'That channel no longer exists.' : 'Import cancelled because another project was opened.' });
  expect(lib.temporarySamples.size).toBe(0);
  expect(app.samples.ids()).toEqual([]);
});

it('releases the temporary copy after a successful storage retry', async () => {
  const { lib, restoreWrites } = setup();
  const project = await lib.readProjectText(embeddedText());
  expect(lib.hasTemporarySamples(project)).toBe(true);
  restoreWrites();
  await lib.putSample('embedded', await lib.sampleRecord('embedded'));
  expect(lib.hasTemporarySamples(project)).toBe(false);
  expect(lib.temporarySamples.size).toBe(0);
  expect(new Uint8Array((await lib.sampleRecord('embedded')).data)).toEqual(new Uint8Array(data));
});

it('saves temporary audio to cloud despite a local metadata write failure, without duplicate uploads', async () => {
  const { lib } = setup();
  const project = await lib.readProjectText(embeddedText());
  const writes = new Map();
  lib.puter = {
    requireSignedIn() {}, isSignedIn: () => true,
    appSubdir: async () => '/Samples', joinPath: (dir, name) => `${dir}/${name}`,
    writeFile: vi.fn(async (path, blob) => { writes.set(path, blob); return { path }; }),
  };
  const result = await lib.saveCloud(project, {}, { path: '/Song.msproj' });
  expect(result.missing).toEqual([]);
  expect(lib.hasTemporarySamples(project)).toBe(false);
  const saved = JSON.parse(await writes.get('/Song.msproj').text());
  expect(saved.samples.embedded.path).toBe('/Samples/embedded.wav');
  expect(new Uint8Array(await writes.get('/Samples/embedded.wav').arrayBuffer())).toEqual(new Uint8Array(data));
  expect(lib.puter.writeFile).toHaveBeenCalledTimes(2);
  await lib.saveCloud(project, {}, { path: '/Song.msproj' });
  expect(lib.puter.writeFile).toHaveBeenCalledTimes(3);
});

it.each(['new', 'open'])('asks before %s replaces a clean project with temporary audio', async (action) => {
  const { app, lib, files } = setup();
  await files.loadProject(await lib.readProjectText(embeddedText()), null);
  expect(app.store.dirty).toBe(false);
  const pending = action === 'new' ? app.newProject(newProject) : files.confirmDiscard();
  const dialog = document.querySelector('.dialog-backdrop');
  expect(dialog).not.toBeNull();
  dialog.querySelector('[data-value="false"]').click();
  expect(await pending).toBe(false);
  expect(app.samples.has('embedded')).toBe(true);
});

it('explains a local save’s temporary audio instead of claiming it is durably saved', async () => {
  const { app, lib, files } = setup();
  await files.loadProject(await lib.readProjectText(embeddedText()), null);
  expect(app.notify).toHaveBeenCalledWith(expect.stringContaining('kept only for this session'), expect.objectContaining({ error: true }));
  app.prefs.set('dismissedNotices', ['localSave']);
  app.notify.mockClear();
  await files.localSaveNotice();
  expect(app.notify).toHaveBeenCalledWith('Saved for this session only', expect.any(Object));
});

async function installedSetup({ desktop = false } = {}) {
  vi.useFakeTimers();
  const { app, db } = setup();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  let close;
  const exit = vi.fn();
  vi.stubGlobal('puter', desktop ? { env: 'app', auth: { isSignedIn: () => false }, ui: { onWindowClose: (fn) => { close = fn; } }, exit } : undefined);
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((...args) => { listeners.push(args); add(...args); });
  install(app, { db, tab: Promise.resolve({ key: 'temp-test', liveKeys: async () => new Set(['temp-test']) }) });
  installed.push(app);
  app.emit('started');
  await app.restored;
  await app.files.loadProject(await app.library.readProjectText(embeddedText()), null);
  await app.autosave.flushAll();
  expect(app.store.dirty).toBe(false);
  return { app, close, exit };
}

it('warns on browser close even after a clean project and its draft were saved', async () => {
  const { app } = await installedSetup();
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await app.autosave.flushAll();
  app.store.load(newProject());
  const clean = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
});

it('keeps a desktop window open when Save leaves temporary audio and permits an explicit discard', async () => {
  const { app, close, exit } = await installedSetup({ desktop: true });
  vi.spyOn(app.files, 'save').mockResolvedValue(true);
  const saving = close();
  document.querySelector('.dialog-backdrop [data-value="save"]').click();
  await saving;
  expect(exit).not.toHaveBeenCalled();
  const discarding = close();
  document.querySelector('.dialog-backdrop [data-value="discard"]').click();
  await discarding;
  expect(exit).toHaveBeenCalledOnce();
});

it.each(['download', 'cloud'])('preserves temporary samples in an ongoing %s across project replacement', async (mode) => {
  const { app, lib, files, restoreWrites } = setup();
  const input = JSON.parse(embeddedText());
  input.samples.second = { ...ref, id: 'second' };
  input.embedded.second = input.embedded.embedded;
  const project = await lib.readProjectText(JSON.stringify(input));
  await files.loadProject(project, null);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writes = new Map();
  if (mode === 'cloud') lib.puter = {
    requireSignedIn() {}, isSignedIn: () => true, appSubdir: async () => '/Samples', joinPath: (dir, name) => `${dir}/${name}`,
    writeFile: vi.fn(async (path, blob) => { writes.set(path, blob); if (path.endsWith('embedded.wav')) await gate; return { path }; }),
  };
  else {
    // Delay a durable first sample; the later temporary sample must survive replacement.
    restoreWrites();
    await lib.putSample('embedded', await lib.sampleRecord('embedded'));
    const read = lib.sampleRecord.bind(lib);
    vi.spyOn(lib, 'sampleRecord').mockImplementation(async (id) => { const rec = await read(id); if (id === 'embedded') await gate; return rec; });
  }
  const pending = mode === 'cloud' ? lib.saveCloud(project, {}, { path: '/Song.msproj' }) : lib.exportFile(project, {});
  if (mode === 'cloud') await vi.waitFor(() => expect(writes.has('/Samples/embedded.wav')).toBe(true));
  else await vi.waitFor(() => expect(lib.sampleRecord).toHaveBeenCalledWith('embedded'));
  app.store.load(newProject());
  release();
  const result = await pending;
  expect(result.missing).toEqual([]);
  if (mode === 'download') {
    const exported = JSON.parse(await result.blob.text());
    expect(Object.keys(exported.embedded)).toEqual(['embedded', 'second']);
  } else expect(writes.has('/Samples/second.wav')).toBe(true);
  expect(lib.temporarySamples.size).toBe(0);
});

it('labels the first save notice as temporary when sample persistence failed', async () => {
  const { lib, files } = setup();
  await files.loadProject(await lib.readProjectText(embeddedText()), null);
  const pending = files.localSaveNotice();
  await vi.waitFor(() => expect(document.querySelector('.save-notice')).not.toBeNull());
  const dialog = document.querySelector('.save-notice');
  const title = document.getElementById(dialog.getAttribute('aria-labelledby')).textContent;
  dialog.querySelector('[data-value="ok"]').click();
  await pending;
  expect(title).toBe('Saved for this session only');
});

it('does not retain a stale cloud download when its cache write fails after project replacement', async () => {
  const { app, lib, files } = setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  lib.puter = { isSignedIn: () => true, readFile: vi.fn(() => gate) };
  const loading = files.loadProject({ ...newProject(), samples: { embedded: { ...ref, path: '/tone.wav' } } }, null);
  await vi.waitFor(() => expect(lib.puter.readFile).toHaveBeenCalledOnce());
  app.store.load(newProject());
  release(new Blob([data]));
  await loading;
  expect(app.samples.ids()).toEqual([]);
  expect(lib.temporarySamples.size).toBe(0);
});

it('keeps a superseded embedded-file read out of the replacement project’s temporary cache', async () => {
  const { app, lib, db } = setup();
  const input = JSON.parse(embeddedText());
  input.samples.second = { ...ref, id: 'second' };
  input.embedded.second = input.embedded.embedded;
  let reject;
  db.put.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const reading = lib.readProjectText(JSON.stringify(input));
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  app.store.load(newProject());
  reject(new Error('Storage full'));
  await reading;
  expect(lib.temporarySamples.size).toBe(0);
});

it.each(['success', 'failure'])('updates a retained sample after an in-flight persistence %s across replacement', async (outcome) => {
  const { app, lib, files, db } = setup();
  const project = await lib.readProjectText(embeddedText());
  await files.loadProject(project, null);
  let finish;
  db.put.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = outcome === 'success' ? resolve : () => reject(new Error('Storage full')); }));
  const saving = lib.putSample('embedded', { ...await lib.sampleRecord('embedded'), path: '/Samples/embedded.wav' }).catch(() => {});
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  app.store.load({ ...project, name: 'Replacement retaining the sample' });
  finish();
  await saving;
  expect(lib.hasTemporarySamples(app.store.project)).toBe(false);
  expect(lib.temporarySamples.size).toBe(outcome === 'success' ? 0 : 1);
});
