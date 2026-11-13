import { it, expect, vi, afterEach } from 'vitest';
import { openExportDialog } from '../src/dialogs/export.js';
import { Engine } from '../src/engine/engine.js';
import { Store } from '../src/model/store.js';
import { demoProject, newProject } from '../src/model/demo.js';
import { unzipStore } from '../src/io/zip.js';
import { readWavHeader } from '../src/io/wav.js';
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
  const patternLabel = document.querySelector('input[value="pattern"]').closest('label');
  const displayedPattern = patternLabel.textContent;
  if (change === 'replace') store.load(newProject());
  else {
    store.apply('Tempo', (q) => ({ ...q, bpm: 99 }));
    store.setPattern(p.patterns[1].id);
  }
  expect(patternLabel.textContent).toBe(displayedPattern);
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

it('updates the displayed pattern duration after MIDI step editing while export settings are open', async () => {
  const { App } = await import('../src/app.js');
  const { Recorder } = await import('../src/input/recorder.js');
  const { LiveInput } = await import('../src/input/live.js');
  const { MidiInput } = await import('../src/input/midi.js');
  const { shared } = await import('../src/pianoroll/state.js');
  const { PPQ } = await import('../src/model/time.js');
  vi.stubGlobal('puter', undefined);
  const root = document.createElement('div');
  document.body.append(root);
  const app = new App(root, { project: newProject(), storage: { getItem: () => null, setItem() {} } });
  app.prefs.set('stepEditing', true);
  vi.spyOn(app.engine, 'ready', 'get').mockReturnValue(true);
  vi.spyOn(app.engine, 'noteOn').mockImplementation(() => {});
  vi.spyOn(app.engine, 'noteOff').mockImplementation(() => {});
  const render = vi.spyOn(app.engine, 'render').mockResolvedValue({ channels: [new Float32Array(4), new Float32Array(4)], rate: 48000 });
  const recorder = new Recorder(app, null);
  const live = new LiveInput(app, recorder);
  const midi = new MidiInput(app, live);
  const previous = { tick: shared.cursor.tick, grid: shared.grid };
  shared.cursor.tick = PPQ * 16;
  shared.grid = PPQ;
  const done = openExportDialog(app);
  try {
    const duration = () => document.querySelector('input[value="pattern"]').closest('label').querySelector('.faint').textContent;
    expect(duration()).toBe('0:01');
    midi.handle([0x90, 60, 100], 'test-keyboard');
    midi.handle([0x80, 60, 0], 'test-keyboard');
    expect(app.store.pattern.notes[app.store.channel.id][0].pos).toBe(PPQ * 16);
    expect(duration()).toBe('0:09');
    document.querySelector('.dlg-export .btn.primary').click();
    await done;
    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0][0].snapshot.project).toBe(app.store.project);
    expect(downloadBlob).toHaveBeenCalledOnce();
  } finally {
    document.querySelector('.dlg-export [aria-label="Close"]')?.click();
    await done;
    midi.releaseAll();
    shared.cursor.tick = previous.tick;
    shared.grid = previous.grid;
  }
});

it('refreshes the selected pattern and tempo without changing the chosen export range', async () => {
  vi.stubGlobal('puter', undefined);
  const store = new Store(demoProject());
  const app = { store, engine: new Engine(store), prefs: { get: () => ({ rate: 48000, bits: 16, tail: false }), merge: vi.fn() }, notify: vi.fn() };
  const done = openExportDialog(app);
  try {
    const pattern = document.querySelector('input[value="pattern"]');
    pattern.click();
    store.setPattern(store.project.patterns[1].id);
    expect(pattern.nextElementSibling.textContent).toBe(`Pattern: ${store.pattern.name}`);
    const duration = pattern.closest('label').querySelector('.faint');
    const previous = duration.textContent;
    store.apply('Tempo', (p) => ({ ...p, bpm: 62 }));
    expect(duration.textContent).not.toBe(previous);
    expect(pattern.checked).toBe(true);
    expect(pattern.isConnected).toBe(true);
    store.apply('Remove arrangement', (p) => ({ ...p, clips: [] }));
    expect(document.querySelector('input[value="song"]').disabled).toBe(true);
    expect(pattern.checked).toBe(true);
  } finally {
    document.querySelector('.dlg-export [aria-label="Close"]')?.click();
    await done;
  }
});

it('refreshes the stem list and prevents an empty export through either click or Enter', async () => {
  vi.stubGlobal('puter', undefined);
  const store = new Store(demoProject());
  const engine = new Engine(store);
  const render = vi.spyOn(engine, 'render');
  const app = { store, engine, prefs: { get: () => ({ rate: 48000, bits: 16, tail: false }), merge: vi.fn() }, notify: vi.fn() };
  const done = openExportDialog(app, { stems: true });
  try {
    const summary = document.querySelector('.export > p');
    const initial = summary.textContent;
    const button = document.querySelector('.dlg-export .btn.primary');
    store.apply('Route directly to master', (p) => ({ ...p, channels: p.channels.map((c) => ({ ...c, mixer: 0 })) }));
    expect(summary.textContent).toMatch(/No channels play into mixer inserts/);
    expect(button.disabled).toBe(true);
    button.click();
    document.querySelector('.dlg-export select').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(render).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
    store.undo();
    expect(summary.textContent).toBe(initial);
    expect(button.disabled).toBe(false);
  } finally {
    document.querySelector('.dlg-export [aria-label="Close"]')?.click();
    await done;
  }
});

it('clears error feedback while retrying a failed export and prevents duplicate renders', async () => {
  vi.stubGlobal('puter', undefined);
  const store = new Store(demoProject());
  const engine = new Engine(store);
  let finish;
  const audio = { channels: [new Float32Array(4), new Float32Array(4)], rate: 48000 };
  const render = vi.spyOn(engine, 'render').mockRejectedValueOnce(new Error('Temporary render failure')).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const app = { store, engine, prefs: { get: () => ({ rate: 48000, bits: 16, tail: false }), merge: vi.fn() }, notify: vi.fn() };
  const done = openExportDialog(app);
  try {
    const button = document.querySelector('.dlg-export .btn.primary');
    const status = document.querySelector('.exp-status');
    button.click();
    await vi.waitFor(() => expect(status.textContent).toContain('Temporary render failure'));
    expect(status.classList.contains('error')).toBe(true);
    expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(status.textContent).toBe('Rendering...');
    expect(status.classList.contains('error')).toBe(false);
    expect(button.disabled).toBe(true);
    button.click();
    document.querySelector('.dlg-export select').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(render).toHaveBeenCalledTimes(2);
    finish(audio);
    await done;
    expect(downloadBlob).toHaveBeenCalledOnce();
    expect(document.querySelector('.dlg-export')).toBeNull();
  } finally {
    document.querySelector('.dlg-export [aria-label="Close"]')?.click();
    finish?.(audio);
    await done;
  }
});


it('downloads a valid ZIP of stereo WAV stems through the Blob writer', async () => {
  vi.stubGlobal('puter', undefined);
  const store = new Store(demoProject());
  const engine = new Engine(store);
  vi.spyOn(engine, 'render').mockResolvedValue({ channels: [new Float32Array([0, 0.5, -0.5, 0]), new Float32Array([0.25, 0, -0.25, 0])], rate: 48000 });
  const app = { store, engine, prefs: { get: () => ({ rate: 48000, bits: 24, tail: false }), merge: vi.fn() }, notify: vi.fn() };
  const done = openExportDialog(app, { stems: true });
  document.querySelector('.dlg-export .btn.primary').click();
  await done;
  expect(downloadBlob).toHaveBeenCalledOnce();
  const [blob, filename] = downloadBlob.mock.calls[0];
  expect(blob.type).toBe('application/zip');
  expect(filename).toBe('Demo Song stems.zip');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  const files = unzipStore(data);
  expect(files.size).toBe(6);
  expect(files.has('01 Kick.wav')).toBe(true);
  for (const bytes of files.values()) expect(readWavHeader(bytes)).toMatchObject({ channels: 2, rate: 48000, bits: 24, frames: 4 });
});
