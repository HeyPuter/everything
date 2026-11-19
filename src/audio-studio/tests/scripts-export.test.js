import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import { runScript } from '../src/commands/scripts.js';
import { AudioFile } from '../src/model/audio-file.js';
import { parseWav } from '../src/audio/wav.js';

vi.mock('../src/export/export-worker.js?worker', async () => {
  const { WavWriter } = await import('../src/export/pcm.js');
  return {
    default: class {
      postMessage(message) {
        if (message.type === 'start') {
          this.job = message.job;
          queueMicrotask(() => this.onmessage({ data: { type: 'need', at: 0, n: this.job.frames } }));
        } else if (message.type === 'chunk') {
          const writer = new WavWriter({ ...this.job.options, frames: this.job.frames, markers: this.job.markers });
          writer.write(message.channels, this.job.frames);
          queueMicrotask(() => this.onmessage({ data: { type: 'done', blob: writer.finish() } }));
        }
      }
      terminate() {}
    },
  };
});

afterEach(() => {
  delete window.puter;
  vi.unstubAllGlobals();
});

it('exportFile writes into a Puter folder with the chosen sample type', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const stored = new Map();
  window.puter = { auth: { isSignedIn: () => true }, fs: { write: async (p, b) => (stored.set(p, b), { path: p }) } };
  const doc = AudioFile.blank({ name: 'Take 1.wav', sampleRate: 8000, channels: 2, seconds: 1 });
  const app = { active: doc, documents: [doc], commands: { run: async () => {} } };
  const r = await runScript(app, "return (await exportFile(app.active, { format: 'wav', bitDepth: 16, channels: 1, name: 'Take one', folder: '/u/out' })).path");
  expect(r.ok).toBe(true);
  expect(r.output).toEqual(['/u/out/Take one.wav']);
  const wav = parseWav(await stored.get('/u/out/Take one.wav').arrayBuffer());
  expect(wav.channels).toHaveLength(1);
  expect(wav.bitDepth).toBe(16);
  expect((await runScript(app, "await exportFile(app.active, { format: 'ogg' })")).error.message).toContain('Unknown format');
});
