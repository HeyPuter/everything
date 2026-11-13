import { it, expect, vi, afterEach } from 'vitest';
import { openExportDialog } from '../src/dialogs/export.js';
import { Engine } from '../src/engine/engine.js';
import { Store } from '../src/model/store.js';
import { demoProject, newProject } from '../src/model/demo.js';
import { downloadBlob } from '../src/io/download.js';
import * as puterApi from '../src/storage/puter.js';

vi.mock('../src/io/download.js', async (original) => ({ ...await original(), downloadBlob: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); document.body.replaceChildren(); });

it.each(['edit', 'replace'])('keeps every stem on the original project, pattern, and samples after %s', async (change) => {
  const messages = [];
  let finishFirst;
  vi.stubGlobal('Worker', class {
    postMessage(m) {
      messages.push(m);
      const finish = () => this.onmessage({ data: { type: 'done', id: m.id, channels: [new Float32Array(4), new Float32Array(4)], rate: m.rate } });
      if (messages.length === 1) finishFirst = finish;
      else queueMicrotask(finish);
    }
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: { get: () => '' }, arrayBuffer: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer })));
  vi.stubGlobal('puter', undefined);
  const p = demoProject();
  p.channels[0] = { ...p.channels[0], sample: 'sample' };
  const store = new Store(p);
  const engine = new Engine(store);
  const data = { channels: [new Float32Array([0.2, 0.3])], rate: 48000 };
  await engine.loadSample('sample', data);
  const app = { store, engine, prefs: { get: () => ({ rate: 48000, bits: 16, tail: false }), merge: vi.fn() }, notify: vi.fn() };
  const done = openExportDialog(app, { stems: true });
  document.querySelector('input[value="pattern"]').click();
  document.querySelector('.dlg-export .btn.primary').click();
  await vi.waitFor(() => expect(messages).toHaveLength(1));
  const expected = { bpm: p.bpm, notes: messages[0].seq.notes.count, sample: 0.2 };
  if (change === 'replace') store.load(newProject());
  else {
    store.apply('Tempo', (q) => ({ ...q, bpm: 99 }));
    store.setPattern(p.patterns[1].id);
  }
  engine.unloadSample('sample');
  finishFirst();
  await done;
  expect(messages.length).toBeGreaterThan(1);
  for (const message of messages) {
    expect(message.seq.bpm).toBe(expected.bpm);
    expect(message.seq.notes.count).toBe(expected.notes);
    expect(message.samples[0]?.channels[0][0]).toBeCloseTo(expected.sample);
  }
  expect(downloadBlob).toHaveBeenCalledOnce();
});

it('closes stale export settings when another project replaces the one shown', async () => {
  vi.stubGlobal('puter', undefined);
  const store = new Store(demoProject());
  const engine = new Engine(store);
  const render = vi.spyOn(engine, 'render');
  const app = { store, engine, prefs: { get: () => ({ rate: 48000, bits: 16, tail: false }), merge: vi.fn() }, notify: vi.fn() };
  const done = openExportDialog(app, { stems: true });
  try {
    // A pending file-open can finish while this modal displays the old inserts.
    store.load({ ...newProject(), channels: [] });
    document.querySelector('.dlg-export .btn.primary')?.click();
    await done;
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(document.querySelector('.dlg-export')).toBeNull();
    expect(app.notify).toHaveBeenCalledWith(expect.stringMatching(/different project/i));
  } finally {
    document.querySelector('.dlg-export [aria-label="Close"]')?.click();
    await done;
  }
});

it('keeps export settings open for ordinary edits and stops watching after cancellation', async () => {
  vi.stubGlobal('puter', undefined);
  const store = new Store(demoProject());
  const app = { store, engine: new Engine(store), prefs: { get: () => ({ rate: 48000, bits: 16, tail: false }), merge: vi.fn() }, notify: vi.fn() };
  const done = openExportDialog(app);
  store.apply('Tempo', (p) => ({ ...p, bpm: 100 }));
  expect(document.querySelector('.dlg-export')).not.toBeNull();
  document.querySelector('.dlg-export [aria-label="Close"]').click();
  await done;
  store.load(newProject());
  expect(app.notify).not.toHaveBeenCalled();
});

it.each([true, false])('respects cancellation while resolving the cloud folder (canceled=%s)', async (cancel) => {
  vi.spyOn(puterApi, 'isSignedIn').mockReturnValue(true);
  let release;
  const directory = new Promise((resolve) => { release = resolve; });
  const folder = vi.spyOn(puterApi, 'appSubdir').mockReturnValue(directory);
  const write = vi.spyOn(puterApi, 'writeNew').mockResolvedValue({ name: 'Demo Song.wav' });
  const store = new Store(demoProject());
  const engine = new Engine(store);
  vi.spyOn(engine, 'render').mockResolvedValue({ channels: [new Float32Array(4), new Float32Array(4)], rate: 48000 });
  const app = { store, engine, prefs: { get: () => ({ rate: 48000, bits: 16, tail: false, cloudCopy: true }), merge: vi.fn() }, notify: vi.fn() };
  const done = openExportDialog(app);
  document.querySelector('.dlg-export .btn.primary').click();
  await vi.waitFor(() => expect(folder).toHaveBeenCalledOnce());
  expect(downloadBlob).toHaveBeenCalledOnce();
  if (cancel) {
    document.querySelector('.dlg-export [aria-label="Close"]').click();
    await done;
  }
  release('/Exports');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await done;
  expect(write).toHaveBeenCalledTimes(cancel ? 0 : 1);
  expect(app.notify).toHaveBeenCalledTimes(cancel ? 0 : 1);
});
