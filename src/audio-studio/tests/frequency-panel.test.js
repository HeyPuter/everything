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
