// Spectral Pitch Display: note ruler ticks, the band fitted to the pitch contour, and
// switching between the frequency and pitch displays.
import { describe, it, expect, beforeAll } from 'vitest';
import { makeScale, noteTicks, pitchBand } from '../src/spectral/freq-scale.js';

describe('note ticks', () => {
  it('labels every semitone when there is room, with frequencies on the A notes', () => {
    const scale = makeScale({ log: true, lo: 200, hi: 400 });
    const t = noteTicks(scale, 600, 14);
    expect(t.map((x) => x.label)).toEqual(['G#3', 'A3 220', 'A#3', 'B3', 'C4', 'C#4', 'D4', 'D#4', 'E4', 'F4', 'F#4', 'G4']);
    // Higher notes sit higher on the ruler.
    expect(t[1].y).toBeLessThan(t[0].y);
  });

  it('thins out to natural notes, then fewer, as the ruler gets shorter', () => {
    const scale = makeScale({ log: true, lo: 100, hi: 800 });
    const all = noteTicks(scale, 1000, 14);
    const naturals = noteTicks(scale, 400, 14);
    const sparse = noteTicks(scale, 120, 14);
    expect(all.length).toBeGreaterThan(naturals.length);
    expect(naturals.every((t) => !t.label.includes('#'))).toBe(true);
    expect(naturals.length).toBeGreaterThan(sparse.length);
    expect(sparse.length).toBeGreaterThan(0);
  });
});

describe('pitch band', () => {
  it('fits the voiced contour with a margin, at least an octave tall', () => {
    const b = pitchBand([Float32Array.from([0, 220, 230, 0, 240])], { fmin: 50, fmax: 2000 });
    expect(b.lo).toBeLessThan(220);
    expect(b.hi).toBeGreaterThan(240);
    expect(Math.log2(b.hi / b.lo)).toBeGreaterThanOrEqual(0.999);
  });

  it('stays inside the search range and falls back to it without a contour', () => {
    expect(pitchBand([new Float32Array(4)], { fmin: 50, fmax: 2000 })).toEqual({ lo: 50, hi: 2000 });
    const b = pitchBand([Float32Array.from([55, 1900])], { fmin: 50, fmax: 2000 });
    expect(b).toEqual({ lo: 50, hi: 2000 });
  });

  it('keeps the previous band while the contour still fits, so scrolling does not jump', () => {
    const prev = pitchBand([Float32Array.from([200, 260])], { fmin: 50, fmax: 2000 });
    expect(pitchBand([Float32Array.from([210, 250])], { fmin: 50, fmax: 2000, prev })).toBe(prev);
    expect(pitchBand([Float32Array.from([400, 600])], { fmin: 50, fmax: 2000, prev })).not.toBe(prev);
  });
});

describe('display switching', () => {
  let app;
  beforeAll(async () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    };
    HTMLCanvasElement.prototype.getContext = () => null;
    localStorage.clear();
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { installSpectralAnalysis } = await import('../src/features/spectral-analysis.js');
    app = new App();
    installCore(app);
    installSpectralAnalysis(app);
  });

  it('shows one spectral display at a time', () => {
    const checked = () => [app.commands.isChecked('view.spectral'), app.commands.isChecked('view.spectralPitch')];
    expect(checked()).toEqual([false, false]);
    app.commands.run('view.spectralPitch');
    expect(checked()).toEqual([false, true]);
    // The frequency display replaces the pitch display.
    app.commands.run('view.spectral');
    expect(checked()).toEqual([true, false]);
    app.commands.run('view.spectralPitch');
    expect(checked()).toEqual([false, true]);
    // Turning the pitch display off hides the spectral area.
    app.commands.run('view.spectralPitch');
    expect(checked()).toEqual([false, false]);
    expect(app.prefs.get('spectralDisplay')).toBe(false);
  });
});
