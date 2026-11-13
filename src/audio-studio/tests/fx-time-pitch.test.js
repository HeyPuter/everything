// Time and Pitch offline processes (stretch, pitch bender, manual correction)
// run through the streamed WASM jobs.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import { getEffect } from '../src/effects/index.js';
import { pitchFftSize, pitchRatio } from '../src/effects/defs/time-pitch.js';

const RATE = 48000;

function sine(f, seconds, amp = 0.5) {
  const n = Math.round(RATE * seconds);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * f * i) / RATE);
  return a;
}

/** Frequency of a steady tone from interpolated upward zero crossings. */
function freq(x) {
  let first = -1;
  let last = 0;
  let count = 0;
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + x[i - 1] / (x[i - 1] - x[i]);
      if (first < 0) first = t;
      else count++;
      last = t;
    }
  }
  return (count * RATE) / (last - first);
}

const mid = (x) => x.subarray(Math.floor(x.length / 4), Math.floor((3 * x.length) / 4));

describe('time and pitch', () => {
  it('matches the Rust FFT size rule', () => {
    expect(pitchFftSize(1024, 1, 48000)).toBe(2048);
    expect(pitchFftSize(1024, 1, 44100)).toBe(2048);
    expect(pitchFftSize(1024, 2, 96000)).toBe(8192);
    expect(pitchFftSize(1024, 0, 22050)).toBe(512);
    expect(pitchRatio(12, 0)).toBeCloseTo(2);
  });

  it('stretches without changing pitch (spectral and waveform)', async () => {
    const def = getEffect('stretchPitch');
    for (const algorithm of [0, 1]) {
      const input = sine(440, 0.5);
      const out = await def.process({ channels: [input, input.slice()], rate: RATE, values: { algorithm, stretch: 150 } });
      expect(out).toHaveLength(2);
      expect(out[0].length).toBe(36000);
      expect(freq(mid(out[0])) / 440).toBeCloseTo(1, 2);
    }
  });

  it('shifts pitch without changing length', async () => {
    const def = getEffect('stretchPitch');
    const out = await def.process({ channels: [sine(330, 0.5)], rate: RATE, values: { semitones: 7 } });
    expect(out[0].length).toBe(24000);
    expect(freq(mid(out[0])) / (330 * pitchRatio(7))).toBeCloseTo(1, 2);
  });

  it('varispeed ties pitch to duration', async () => {
    const def = getEffect('stretchPitch');
    const out = await def.process({ channels: [sine(400, 0.5)], rate: RATE, values: { algorithm: 2, stretch: 200 } });
    expect(out[0].length).toBe(48000);
    expect(freq(mid(out[0])) / 200).toBeCloseTo(1, 2);
  });

  it('pitch bender follows its envelope and changes duration', async () => {
    const def = getEffect('pitchBender');
    const out = await def.process({ channels: [sine(300, 0.5)], rate: RATE, values: { envelope: [{ t: 0, v: 12 }, { t: 1, v: 12 }], range: 12 } });
    expect(out[0].length).toBe(12000);
    expect(freq(mid(out[0])) / 600).toBeCloseTo(1, 2);
    // Values beyond the range are clamped.
    const clamped = await def.process({ channels: [sine(300, 0.5)], rate: RATE, values: { envelope: [{ t: 0, v: 12 }, { t: 1, v: 12 }], range: 2 } });
    expect(freq(mid(clamped[0])) / (300 * pitchRatio(2))).toBeCloseTo(1, 2);
  });

  it('manual pitch correction keeps the duration', async () => {
    const def = getEffect('manualPitchCorrection');
    const out = await def.process({ channels: [sine(440, 0.6)], rate: RATE, values: { envelope: [{ t: 0, v: -100 }, { t: 1, v: -100 }], formants: false } });
    expect(out[0].length).toBe(28800);
    expect(freq(mid(out[0])) / (440 * pitchRatio(-1))).toBeCloseTo(1, 2);
  });

  it('treats a damaged (NaN or infinite) sample as silence instead of spreading it', async () => {
    const env = (a, b) => [0, 1].map((t) => ({ t, v: t ? b : a }));
    const runs = [
      ['stretchPitch', { algorithm: 0, stretch: 110 }],
      ['stretchPitch', { algorithm: 1, stretch: 110, semitones: 3 }],
      ['stretchPitch', { algorithm: 2, stretch: 90 }],
      ['pitchBender', { envelope: env(2, -2), range: 2 }],
      ['manualPitchCorrection', { envelope: env(50, 50) }],
    ];
    for (const [id, values] of runs) {
      const input = sine(440, 0.5);
      input[5000] = NaN;
      input[15000] = Infinity;
      const out = await getEffect(id).process({ channels: [input], rate: RATE, values });
      expect(out[0].every(Number.isFinite), `${id} ${JSON.stringify(values)}`).toBe(true);
    }
  });

  it('honours cancellation', async () => {
    const def = getEffect('stretchPitch');
    const ctl = new AbortController();
    ctl.abort();
    await expect(def.process({ channels: [sine(440, 0.2)], rate: RATE, values: {}, signal: ctl.signal })).rejects.toThrow();
  });
});
