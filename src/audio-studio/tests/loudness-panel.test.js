// Match Loudness panel: runs against an in-thread stand-in for the analysis workers.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { testDsp } from './wasm-helper.js';

const hooks = { onOpen: null };
vi.mock('../src/analysis/pool.js', async () => {
  const { loudnessMeter } = await import('../src/analysis/dsp-ext.js');
  const { testDsp: dsp } = await import('./wasm-helper.js');
  const session = async (kind, params) => {
    await hooks.onOpen?.(kind, params);
    const meter = loudnessMeter(dsp(), params.rate, params.channels);
    return {
      push: async (channels) => {
        await Promise.resolve();
        if (kind === 'limit') for (const x of channels) for (let i = 0; i < x.length; i++) x[i] *= params.gain;
        meter.push(channels);
        return kind === 'limit' ? channels : null;
      },
      close: async () => {
        const loudness = meter.result();
        meter.free();
        return { loudness, latency: 0 };
      },
    };
  };
  return { analysisPool: () => ({ session }) };
});

import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { deleteRange } from '../src/model/edits.js';
import { loudnessPanel } from '../src/analysis/loudness.js';

const RATE = 8000;
const tone = (n, a) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * 440 * i) / RATE));

beforeAll(() => {
  testDsp();
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

function setup() {
  localStorage.clear();
  const app = new App();
  installCore(app);
  const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [Channel.fromSamples(tone(RATE * 4, 0.05))] });
  app.addDocument(doc);
  const panel = loudnessPanel(app);
  panel.show();
  const button = (re) => [...panel.el.querySelectorAll('button')].find((b) => re.test(b.textContent));
  return { app, doc, panel, button };
}

describe('Match Loudness panel', () => {
  it('keeps an edit made while a file is being matched', async () => {
    const { doc, button } = setup();
    let edited = null;
    hooks.onOpen = (kind) => {
      if (kind !== 'limit') return;
      // The gain is being applied: the user deletes the first second.
      doc.apply('Delete', deleteRange(doc.state, 0, RATE, null));
      edited = doc.state;
    };
    button(/^Run$/).click();
    await expect.poll(() => button(/^Run$/).disabled, { timeout: 5000 }).toBe(false);
    hooks.onOpen = null;
    expect(edited).not.toBe(null);
    expect(doc.state).toBe(edited);
    expect(doc.length).toBe(RATE * 3);
  });
});
