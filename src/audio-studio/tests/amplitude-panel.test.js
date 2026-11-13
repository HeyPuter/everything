// Amplitude Statistics panel: results stay tied to the audio they describe.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const gate = { hold: null };
vi.mock('../src/analysis/pool.js', async () => {
  const { HIST_BINS } = await import('../src/analysis/rms-histogram.js');
  const session = async (kind, params) => {
    const chans = Array.from({ length: params.channels }, () => ({
      min: -0.5,
      max: 0.5,
      sum: 0,
      sq: 0,
      clipped: 0,
      bad: 0,
      bits: 32,
      rmsMin: 0.35,
      rmsMax: 0.35,
      rmsSum: 0,
      rmsCount: 0,
      frames: 0,
      hist: new Uint32Array(HIST_BINS),
    }));
    return {
      push: async (channels) => {
        channels.forEach((x, c) => {
          chans[c].frames += x.length;
          for (const v of x) chans[c].sq += v * v;
        });
        await gate.hold;
      },
      close: async () => ({
        channels: chans,
        loudness: {
          integrated: -20,
          range: 0,
          maxMomentary: -20,
          maxShortTerm: -20,
          truePeak: chans.map(() => 0.5),
        },
      }),
    };
  };
  return { analysisPool: () => ({ session }) };
});

import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { gainRange } from '../src/model/edits.js';
import { amplitudePanel } from '../src/analysis/amplitude.js';

const RATE = 8000;
const file = (name) =>
  new AudioFile({
    name,
    sampleRate: RATE,
    channels: [Channel.fromSamples(new Float32Array(RATE).fill(0.25))],
  });

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = () => null;
});

function setup() {
  localStorage.clear();
  const app = new App();
  installCore(app);
  const a = file('a.wav');
  app.addDocument(a);
  const panel = amplitudePanel(app);
  const caption = () => panel.el.querySelector('.analysis-caption').textContent;
  return { app, a, panel, caption };
}

describe('Amplitude Statistics panel', () => {
  it('says when the file changed after a scan, and not after undo back to it', async () => {
    const { a, panel, caption } = setup();
    await panel.scan(false);
    expect(caption()).toBe('Statistics for a.wav, entire file');
    a.apply('Amplify', gainRange(a.state, 0, a.length, 0.5, null));
    expect(caption()).toMatch(/changed since this scan/);
    a.history.undo();
    expect(caption()).toBe('Statistics for a.wav, entire file');
  });

  it('drops a scan that finishes after another file became active', async () => {
    const { app, panel, caption } = setup();
    let release;
    gate.hold = new Promise((r) => (release = r));
    const done = panel.scan(false);
    app.addDocument(file('b.wav'));
    release();
    gate.hold = null;
    await done;
    expect(panel.result).toBe(null);
    expect(caption()).not.toMatch(/a\.wav/);
  });
});

describe('Amplitude Statistics theme', () => {
  it('repaints the RMS histogram when the theme changes', async () => {
    let fills = 0;
    const ctx = new Proxy(
      {},
      {
        get: (t, k) => (k in t ? t[k] : k === 'fillRect' ? () => fills++ : () => {}),
        set: (t, k, v) => ((t[k] = v), true),
      },
    );
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => ctx;
    try {
      const { app } = setup();
      // A panel that opens on the RMS Histogram tab.
      app.prefs.set('amplitudeTab', 'histogram');
      const fresh = amplitudePanel(app);
      const plot = fresh.el.querySelector('.rms-hist');
      Object.defineProperty(plot, 'clientWidth', { value: 400 });
      Object.defineProperty(plot, 'clientHeight', { value: 200 });
      await fresh.scan(false);
      fills = 0;
      window.dispatchEvent(new CustomEvent('themechange'));
      expect(fills).toBeGreaterThan(0);
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
  });
});

describe('Amplitude Statistics keyboard focus', () => {
  it('keeps focus on Cancel during a scan and returns it to the scan button', async () => {
    const { panel } = setup();
    document.body.append(panel.el);
    try {
      const scanFile = [...panel.el.querySelectorAll('button')].find(
        (b) => b.textContent === 'Scan File',
      );
      let release;
      gate.hold = new Promise((r) => (release = r));
      scanFile.focus();
      scanFile.click();
      // Scan File is disabled while scanning, which would drop focus to the page.
      await expect.poll(() => document.activeElement.textContent).toBe('Cancel');
      release();
      gate.hold = null;
      await expect.poll(() => scanFile.disabled).toBe(false);
      expect(document.activeElement).toBe(scanFile);
    } finally {
      panel.el.remove();
    }
  });
});
