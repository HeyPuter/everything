// Phase Meter panel: the correlation readout for assistive technology.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { phaseMeterPanel } from '../src/analysis/phase.js';

// A 2D context that accepts every call.
const ctx = new Proxy(
  {},
  {
    get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })),
    set: (t, k, v) => ((t[k] = v), true),
  },
);

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

describe('Phase Meter', () => {
  it('reports no signal once the meter settles after playback', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    // Move past the initial one-second throttle window for spoken readings.
    vi.advanceTimersByTime(1100);
    let panel;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => ctx;
    try {
      localStorage.clear();
      const app = new App();
      installCore(app);
      panel = phaseMeterPanel(app);
      const bar = panel.el.querySelector('.phase-meter');
      Object.defineProperty(bar, 'clientWidth', { value: 300 });
      Object.defineProperty(bar, 'clientHeight', { value: 40 });
      panel.show();
      const L = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i / 9));
      app.engine.emit('tap', { L, R: L.slice(), frame: 4096, rate: 48000 });
      vi.advanceTimersToNextFrame();
      expect(bar.getAttribute('aria-valuetext')).toBe('1.00, mostly mono');
      // Wait for rendered frames, not wall time: a busy runner may deliver
      // fewer frames than expected within a fixed timeout.
      for (let i = 0; i < 10; i++) vi.advanceTimersToNextFrame();
      expect(bar.getAttribute('aria-valuetext')).toBe('No signal');
      expect(bar.getAttribute('aria-valuenow')).toBe('0.00');
    } finally {
      panel?.hide();
      HTMLCanvasElement.prototype.getContext = getContext;
      vi.useRealTimers();
    }
  });
});

describe('stopped views', () => {
  it('reads the selection, or the audio around the playhead, from the document', async () => {
    const { documentBlock, correlation } = await import('../src/analysis/phase.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    const L = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 7));
    const doc = new AudioFile({ name: 'a.wav', sampleRate: 48000, channels: [Channel.fromSamples(L), Channel.fromSamples(L.map((v) => -v))] });
    doc.setCursor(100);
    const at = documentBlock(doc, 2048);
    expect(at.label).toBe('Playhead');
    expect(at.L.length).toBe(2048);
    expect(correlation(at.L, at.R)).toBeCloseTo(-1, 3);
    doc.setSelection(1000, 41000);
    const sel = documentBlock(doc, 2048, 4000);
    expect(sel.label).toBe('Selection');
    expect(sel.L.length).toBe(4000);
    expect(sel.L[1]).toBeCloseTo(L[1010], 6);
    const mono = new AudioFile({ name: 'm.wav', sampleRate: 48000, channels: [Channel.fromSamples(L)] });
    const m = documentBlock(mono);
    expect(correlation(m.L, m.R)).toBeCloseTo(1, 6);
    expect(documentBlock(null)).toBe(null);
  });

  it('the Phase Meter shows the correlation of the selection while stopped', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    vi.advanceTimersByTime(1100);
    let panel;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => ctx;
    return (async () => {
      try {
        const { AudioFile } = await import('../src/model/audio-file.js');
        const { Channel } = await import('../src/audio/channel.js');
        localStorage.clear();
        const app = new App();
        installCore(app);
        app.syncGraph = () => {};
        const L = Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i / 5));
        const doc = new AudioFile({ name: 'a.wav', sampleRate: 8000, channels: [Channel.fromSamples(L), Channel.fromSamples(L.map((v) => -v))] });
        app.addDocument(doc);
        panel = phaseMeterPanel(app);
        const bar = panel.el.querySelector('.phase-meter');
        Object.defineProperty(bar, 'clientWidth', { value: 300 });
        Object.defineProperty(bar, 'clientHeight', { value: 40 });
        panel.show();
        vi.advanceTimersToNextFrame();
        expect(bar.getAttribute('aria-valuenow')).toBe('-1.00');
        expect(bar.getAttribute('aria-valuetext')).toMatch(/out of phase \(playhead\)/);
      } finally {
        panel?.hide();
        HTMLCanvasElement.prototype.getContext = getContext;
        vi.useRealTimers();
      }
    })();
  });
});
