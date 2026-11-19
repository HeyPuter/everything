// Loudness Meter: Scan Selection / Scan File measures offline (in-thread stand-in for the analysis workers).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { testDsp } from './wasm-helper.js';

vi.mock('../src/analysis/pool.js', async () => {
  const { loudnessMeter } = await import('../src/analysis/dsp-ext.js');
  const { testDsp: dsp } = await import('./wasm-helper.js');
  const session = async (kind, params) => {
    const meter = loudnessMeter(dsp(), params.rate, params.channels);
    return {
      push: async (channels) => {
        meter.push(channels);
        return null;
      },
      close: async () => {
        const loudness = meter.result();
        if (kind === 'loudness') loudness.history = meter.series();
        meter.free();
        return { loudness, latency: 0 };
      },
    };
  };
  return { analysisPool: () => ({ session }) };
});

import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { getEffect } from '../src/effects/index.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { isBusy } from '../src/ui/busy.js';
import { fakeApp } from './fx-helpers.js';

const RATE = 48000;
const sine = (n, amp) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 1000 * i) / RATE));

beforeAll(() => {
  testDsp();
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

describe('Loudness Meter scan', () => {
  it('scans the file or the selection into the readouts without playing', async () => {
    const app = fakeApp();
    const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [Channel.fromSamples(sine(RATE * 5, 0.1)), Channel.fromSamples(sine(RATE * 5, 0.1))] });
    app.active = doc;
    const p = openEffectDialog(app, getEffect('loudnessMeter'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    const scan = dlg.querySelector('.lm-scan');
    expect(scan.textContent).toBe('Scan File');
    doc.setSelection(0, RATE * 4);
    expect(scan.textContent).toBe('Scan Selection');
    scan.click();
    expect(isBusy()).toBe(true);
    await expect.poll(() => dlg.querySelector('.lm-offline-text').textContent, { timeout: 5000 }).toMatch(/Selection scanned \(0:04\)/);
    expect(isBusy()).toBe(false);
    const head = [...dlg.querySelectorAll('.lm-big-value')].map((e) => Number(e.textContent));
    // A -20 dBFS stereo sine: about -20 LUFS integrated and short-term max, no range, -20 dBTP.
    expect(head[0]).toBeCloseTo(-20, 0);
    expect(head[1]).toBeCloseTo(-20, 0);
    expect(head[2]).toBeCloseTo(0, 0);
    expect(head[3]).toBeCloseTo(-20, 0);
    expect(dlg.querySelector('.lm-big.st .lm-big-label').textContent).toBe('Short-Term Max');
    expect(dlg.querySelector('.lm-hint').textContent).toMatch(/Scanned the selection/);
    // Momentary shows the scan's last reading, and the history graph spans the scan.
    const momentary = [...dlg.querySelectorAll('.lm-bars [aria-valuetext]')].find((e) => e.closest('[data-meter="momentary"]'));
    expect(parseFloat(momentary.getAttribute('aria-valuetext'))).toBeCloseTo(-20, 0);
    const graph = dlg.querySelector('.lm-history');
    expect(Number(graph.dataset.points)).toBeGreaterThan(30);
    expect(graph.getAttribute('aria-label')).toMatch(/across the selection \(0:04\)/);
    // Live readings take over from the scan.
    app.engine.emit('fx-readout', new Map([['preview:loudnessMeter', Float32Array.of(-18, -19.5, -21.25, 4.2, 1, 0.25, -12, -15, 75, 0.5, 0.25)]]));
    expect(dlg.querySelector('.lm-big.st .lm-big-label').textContent).toBe('Short-Term');
    expect(dlg.querySelector('.lm-offline-text').textContent).toBe('');
    dlg.querySelector('.dialog-head .icon-btn').click();
    await p;
  });
});

describe('loudness series', () => {
  it('gives momentary and short-term loudness through the audio', async () => {
    const { loudnessMeter } = await import('../src/analysis/dsp-ext.js');
    const m = loudnessMeter(testDsp(), RATE, 1);
    // 3 s at -30 dBFS, then 3 s at -20 dBFS (mono: about 3 dB lower in LUFS than stereo).
    m.push([sine(RATE * 3, 0.0316)]);
    m.push([sine(RATE * 3, 0.1)]);
    const s = m.series(30);
    m.free();
    expect(s.step).toBeCloseTo(0.2, 5);
    expect(s.shortTerm).toHaveLength(30);
    expect(s.momentary).toHaveLength(30);
    // Short-term needs 3 s; momentary 400 ms.
    expect(s.shortTerm[0]).toBe(-Infinity);
    expect(s.momentary[0]).toBe(-Infinity);
    expect(s.momentary[5] - s.momentary[29]).toBeCloseTo(-10, 0);
    expect(s.shortTerm[29] - s.shortTerm[14]).toBeCloseTo(10, 0);
  });
});
