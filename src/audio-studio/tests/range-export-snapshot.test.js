import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { createMarker } from '../src/model/markers.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installFileExtraCommands } from '../src/commands/file-extra.js';
import { parseWav } from '../src/audio/wav.js';

// Execute the WAV encoder at the worker boundary, so uploaded PCM can be checked.
vi.mock('../src/export/export.js', async () => {
  const { WavWriter } = await import('../src/export/pcm.js');
  return {
    exportAudio: async (source, options) => {
      const frames = source.end - source.start;
      const writer = new WavWriter({ ...options, frames, meta: source.meta });
      writer.write(source.channels.map((ch) => ch.toArray(source.start, source.end)), frames);
      return writer.finish();
    },
    isCancelled: (err) => err?.name === 'AbortError' || err?.message === 'Cancelled',
    cancelledError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
  };
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
  vi.useFakeTimers();
});
afterEach(() => {
  delete window.puter;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(['folder setup', 'first upload'])('exports one audio version despite an edit during %s', async (phase) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  installFileExtraCommands(app);
  app.prefs.set('batchExport', { format: 'wav', bitDepth: 32, dither: 'none', location: 'puter', collision: 'overwrite' });
  const samples = new Float32Array(64).fill(0.25);
  samples.fill(0.75, 32);
  const markers = [0, 32].map((start, i) => createMarker({ start, duration: 32, name: `Range ${i + 1}`, type: 'range' }));
  const doc = app.addDocument(new AudioFile({ name: 'Ranges.wav', sampleRate: 8000, channels: [Channel.fromSamples(samples)], markers }));
  const before = doc.state;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let waiting = false;
  const writes = [];
  window.puter = {
    auth: { isSignedIn: () => true, getUser: async () => {
      if (phase === 'folder setup') { waiting = true; await wait; }
      return { username: 'u' };
    } },
    fs: { write: async (path, blob) => {
      writes.push({ path, blob });
      if (phase === 'first upload' && writes.length === 1) { waiting = true; await wait; }
      return {};
    } },
  };
  const startExport = async () => {
    const pending = app.commands.run('file.exportRanges');
    document.querySelector('.dialog-foot button[data-value="ok"]').click();
    return pending;
  };
  const exporting = startExport();
  await vi.waitFor(() => expect(waiting).toBe(true), { interval: 1 });
  // The export dialog has closed and the delayed progress modal is not showing.
  expect(document.querySelector('[role=dialog]')).toBeNull();
  await app.commands.run('fx.invert');
  const edited = doc.state;
  expect(edited.channels[0].toArray(32, 33)[0]).toBe(-0.75);
  release();
  await exporting;
  expect(writes.map(({ path }) => path)).toEqual(['/u/AudioStudio/Range 1.wav', '/u/AudioStudio/Range 2.wav']);
  for (let i = 0; i < 2; i++) {
    const wav = parseWav(await writes[i].blob.arrayBuffer());
    expect(wav.sampleRate).toBe(8000);
    expect([...wav.channels[0]]).toEqual(Array(32).fill(i ? 0.75 : 0.25));
  }
  expect(doc.state === edited).toBe(true);
  expect(doc.history.undoLabel).toBe('Invert');
  // A later export captures the newer version; the first export did not undo the edit.
  await startExport();
  for (let i = 0; i < 2; i++) {
    const wav = parseWav(await writes[i + 2].blob.arrayBuffer());
    expect([...wav.channels[0]]).toEqual(Array(32).fill(i ? -0.75 : -0.25));
  }
  doc.history.undo();
  expect(doc.state === before).toBe(true);
  expect(app.notify).not.toHaveBeenCalled();
});
