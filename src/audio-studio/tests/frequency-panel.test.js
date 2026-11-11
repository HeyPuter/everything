// Frequency Analysis panel: Scan, and no analysis work while the panel is hidden.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

vi.mock('../src/analysis/pool.js', () => {
  const call = vi.fn(async (msg) => new Float32Array(msg.size / 2 + 1).fill(-50));
  return { analysisPool: () => ({ call }), poolCall: call };
});

import { poolCall } from '../src/analysis/pool.js';
import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { installAnalysis } from '../src/analysis/install.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';

const RATE = 8000;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = () => null;
});

afterEach(() => vi.useRealTimers());

/** A 2D context that records path points with the dash pattern in use (held traces are dashed). */
function recordingContext(points) {
  let dash = '';
  return new Proxy(
    {},
    {
      get(t, k) {
        if (k === 'setLineDash') return (d) => (dash = d.join(','));
        if (k === 'lineTo' || k === 'moveTo') return (x, y) => points.push({ dash, x, y });
        if (k in t) return t[k];
        return () => ({ addColorStop() {} });
      },
      set(t, k, v) {
        t[k] = v;
        return true;
      },
    },
  );
}

function setup() {
  localStorage.clear();
  const app = new App();
  installCore(app);
  installAnalysis(app);
  const panel = app.panels.get('frequency').create(app);
  const doc = new AudioFile({
    name: 'a.wav',
    sampleRate: RATE,
    channels: [Channel.fromSamples(new Float32Array(RATE * 10))],
  });
  app.addDocument(doc);
  return { app, panel, doc };
}

describe('Frequency Analysis panel', () => {
  it('averages the whole file when Scan is pressed', async () => {
    vi.useFakeTimers();
    const { panel } = setup();
    panel.show();
    await vi.advanceTimersByTimeAsync(300);
    poolCall.mockClear();
    const scan = [...panel.el.querySelectorAll('button')].find((b) => b.textContent === 'Scan');
    scan.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(poolCall).toHaveBeenCalledTimes(1);
    const msg = poolCall.mock.calls[0][0];
    expect(msg.op).toBe('average');
    // Frames spread over the whole file, not a single frame at the playhead.
    expect(msg.frames).toBe(Math.floor((RATE * 10 - 4096) / 2048) + 1);
    // The Scan Frequency Analysis command scans the same way.
    poolCall.mockClear();
    panel.scan();
    await vi.advanceTimersByTimeAsync(300);
    expect(poolCall.mock.calls[0][0].frames).toBe(msg.frames);
  });

  it('does no analysis while hidden and catches up when shown', async () => {
    vi.useFakeTimers();
    const { panel, doc } = setup();
    panel.show();
    await vi.advanceTimersByTimeAsync(300);
    panel.hide();
    poolCall.mockClear();
    doc.setSelection(1000, 60000);
    await vi.advanceTimersByTimeAsync(300);
    expect(poolCall).not.toHaveBeenCalled();
    // Showing it again analyses the new selection without waiting.
    panel.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(poolCall).toHaveBeenCalledTimes(1);
    expect(poolCall.mock.calls[0][0].frames).toBeGreaterThan(1);
  });
});

describe('Frequency Analysis holds', () => {
  it('draws held traces at their own frequencies after switching sample rate', async () => {
    const points = [];
    const ctx = recordingContext(points);
    HTMLCanvasElement.prototype.getContext = () => ctx;
    // Every spectrum peaks in bin 85 of 4096: 996 Hz at 48 kHz, 498 Hz at 24 kHz.
    poolCall.mockImplementation(async (msg) => {
      const a = new Float32Array(msg.size / 2 + 1).fill(-100);
      a[85] = -10;
      return a;
    });
    localStorage.clear();
    const app = new App();
    installCore(app);
    installAnalysis(app);
    const panel = app.panels.get('frequency').create(app);
    const plot = panel.el.querySelector('.freq-plot');
    Object.defineProperty(plot, 'clientWidth', { value: 642 });
    Object.defineProperty(plot, 'clientHeight', { value: 300 });
    const file = (name, rate) =>
      new AudioFile({
        name,
        sampleRate: rate,
        channels: [Channel.fromSamples(new Float32Array(rate))],
      });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const redraw = async () => {
      points.length = 0;
      plot.dispatchEvent(new Event('pointerleave'));
      await wait(50);
    };
    const peakX = (pts) => pts.reduce((m, p) => (p.y < m.y ? p : m)).x;
    // Plot x of f Hz: log axis from 20 Hz to Nyquist between x = 34 and 634.
    const xOf = (f, nyq) => 34 + (Math.log(f / 20) / Math.log(nyq / 20)) * 600;
    try {
      app.addDocument(file('a.wav', 48000));
      panel.show();
      await wait(300);
      panel.el.querySelector('.freq-hold').click();
      app.addDocument(file('b.wav', 24000));
      await wait(300);
      await redraw();
      const held = points.filter((p) => p.dash === '4,3');
      expect(Math.abs(peakX(points.filter((p) => p.dash === '')) - xOf(498, 12000))).toBeLessThan(
        2,
      );
      expect(Math.abs(peakX(held) - xOf(996, 12000))).toBeLessThan(2);
      // The other way round: a held 24 kHz trace ends at 12 kHz on a 48 kHz plot.
      panel.el.querySelectorAll('.freq-hold')[1].click();
      app.activate(app.documents[0]);
      await wait(300);
      await redraw();
      const lower = points.filter((p) => p.dash === '4,3').slice(held.length);
      expect(Math.abs(peakX(lower) - xOf(498, 24000))).toBeLessThan(2);
      expect(Math.max(...lower.map((p) => p.x))).toBeLessThan(xOf(12000, 24000) + 2);
    } finally {
      HTMLCanvasElement.prototype.getContext = () => null;
    }
  });
});

describe('Frequency Analysis channels', () => {
  it('shows Mid as the spectrum of (L + R) / 2', async () => {
    HTMLCanvasElement.prototype.getContext = () => recordingContext([]);
    // Silence analyses to -150 dB, anything else to a -10 dB peak.
    poolCall.mockImplementation(async (msg) => {
      const loud = msg.samples.some((v) => v !== 0);
      const a = new Float32Array(msg.size / 2 + 1).fill(-150);
      if (loud) a[85] = -10;
      return a;
    });
    try {
      localStorage.clear();
      const app = new App();
      installCore(app);
      installAnalysis(app);
      app.prefs.set('frequencyAnalysis', { channel: 'mid' });
      const panel = app.panels.get('frequency').create(app);
      const plot = panel.el.querySelector('.freq-plot');
      Object.defineProperty(plot, 'clientWidth', { value: 642 });
      Object.defineProperty(plot, 'clientHeight', { value: 300 });
      // Left and right exactly out of phase: the mid signal is silent.
      const x = Float32Array.from({ length: RATE }, (_, i) => 0.5 * Math.sin(i / 3));
      const doc = new AudioFile({
        name: 'a.wav',
        sampleRate: RATE,
        channels: [Channel.fromSamples(x), Channel.fromSamples(x.map((v) => -v))],
      });
      app.addDocument(doc);
      doc.setSelection(0, RATE);
      panel.show();
      await new Promise((r) => setTimeout(r, 300));
      expect(panel.el.querySelector('.analysis-readout').textContent).toMatch(/at -150\.0 dB$/);
    } finally {
      HTMLCanvasElement.prototype.getContext = () => null;
    }
  });
});
