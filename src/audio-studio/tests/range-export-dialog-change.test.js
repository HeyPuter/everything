import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
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
const gate = vi.hoisted(() => ({ wait: null, calls: 0 }));
vi.mock('../src/audio/dsp.js', async (original) => {
  const actual = await original();
  return { ...actual, dsp: async () => { gate.calls++; if (gate.wait) await gate.wait; return actual.dsp(); } };
});
beforeEach(async () => {
  gate.wait = null;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
  gate.calls = 0;
  localStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  delete window.puter;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each([0, 80, 128])('checks displayed range bounds after a pending paste at frame %i', async (at) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  installFileExtraCommands(app);
  app.prefs.set('batchExport', { format: 'wav', bitDepth: 32, dither: 'none', location: 'puter', dir: '/u/AudioStudio', collision: 'overwrite' });
  const samples = new Float32Array(128);
  samples.fill(0.25, 64, 96);
  const marker = createMarker({ start: 64, duration: 32, name: 'Chosen', type: 'range' });
  const doc = app.addDocument(new AudioFile({ name: 'Ranges.wav', sampleRate: 8000, channels: [Channel.fromSamples(samples)], markers: [marker] }));
  doc.setCursor(at);
  app.clipboard = { type: 'audio', sampleRate: 16000, channels: [Channel.fromSamples(new Float32Array(160).fill(0.5))] };
  const writes = [];
  window.puter = { auth: { isSignedIn: () => true }, fs: { write: async (path, blob) => { writes.push({ path, blob }); return {}; } } };
  let release;
  gate.wait = new Promise((resolve) => { release = resolve; });
  const pasting = app.commands.run('edit.paste');
  await vi.waitFor(() => expect(gate.calls).toBeGreaterThan(0), { interval: 1 });
  const exporting = app.commands.run('file.exportRanges');
  expect(document.querySelector('[role=dialog]').textContent).toContain('Chosen');
  // Complete a command already in flight; no new edit is invoked through the modal.
  release();
  await pasting;
  const pasted = doc.state;
  const current = pasted.markers.find((m) => m.id === marker.id);
  const changed = at < 96;
  expect(current.start !== marker.start || current.duration !== marker.duration).toBe(changed);
  const expected = [...pasted.channels[0].toArray(current.start, current.start + current.duration)];
  document.querySelector('.dialog-foot button[data-value="ok"]').click();
  const result = await exporting;
  // On the baseline this also exposes the wrong/truncated exported PCM.
  if (writes.length) {
    const wav = parseWav(await writes[0].blob.arrayBuffer());
    expect.soft([...wav.channels[0]]).toEqual(expected);
  }
  if (changed) {
    expect(writes).toHaveLength(0);
    expect(result).toBe(false);
    expect(app.notify).toHaveBeenCalledExactlyOnceWith('The selected ranges changed while this dialog was open. Reopen range export to review them.', { error: true });
    const retry = app.commands.run('file.exportRanges');
    document.querySelector('.dialog-foot button[data-value="ok"]').click();
    await retry;
  } else expect(app.notify).not.toHaveBeenCalled();
  expect(writes).toHaveLength(1);
  const wav = parseWav(await writes[0].blob.arrayBuffer());
  expect([...wav.channels[0]]).toEqual(expected);
  expect(writes[0].path).toBe('/u/AudioStudio/Chosen.wav');
  expect(doc.state === pasted).toBe(true);
  expect(doc.history.undoLabel).toBe('Paste');
});
