// Restoration effects that run offline (noise print capture, Noise
// Reduction process, DeClicker, DeClipper) through the built WASM module.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import { dsp } from '../src/audio/dsp.js';
import { getEffect, slotSpec } from '../src/effects/index.js';
import { captureNoisePrint, packNoisePrint } from '../src/effects/defs/restoration.js';

const RATE = 48000;

function noise(n, amp, seed = 1) {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = amp * (s / 2147483648 - 1);
  }
  return out;
}

function sine(n, f, amp) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * f * i) / RATE);
  return out;
}

const rms = (x, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
};

describe('noise print', () => {
  it('captures the mean noise power per bin, in chunks', async () => {
    const d = await dsp();
    const x = noise(RATE * 2, 0.1, 3);
    const print = await captureNoisePrint(d, [x, x], RATE, { fftSize: 2048 });
    expect(print.fftSize).toBe(2048);
    expect(print.channels).toHaveLength(2);
    expect(print.channels[0]).toHaveLength(1025);
    const variance = rms(x) ** 2;
    let mean = 0;
    for (let k = 20; k < 1000; k++) mean += print.channels[0][k];
    mean /= 980;
    expect(mean / variance).toBeGreaterThan(0.85);
    expect(mean / variance).toBeLessThan(1.15);
    const packed = packNoisePrint(print);
    expect(Array.from(packed.subarray(0, 4))).toEqual([2048, 2, RATE, 1025]);
    expect(packNoisePrint(print)).toBe(packed);
  });

  it('shrinks the FFT for short selections and rejects tiny ones', async () => {
    const d = await dsp();
    const print = await captureNoisePrint(d, [noise(1500, 0.1)], RATE);
    expect(print.fftSize).toBe(1024);
    await expect(captureNoisePrint(d, [noise(100, 0.1)], RATE)).rejects.toThrow(/noise/);
  });

  it('ignores a NaN sample in the noise, so Noise Reduction still keeps the audio', async () => {
    const d = await dsp();
    const hiss = noise(RATE, 0.05, 99);
    const clean = await captureNoisePrint(d, [hiss], RATE);
    const damaged = hiss.slice();
    damaged[1000] = NaN;
    damaged[20000] = Infinity;
    const print = await captureNoisePrint(d, [damaged], RATE);
    for (let k = 0; k < print.channels[0].length; k++) {
      expect(Number.isFinite(print.channels[0][k])).toBe(true);
      expect(print.channels[0][k] / clean.channels[0][k]).toBeCloseTo(1, 1);
    }
    const tone = sine(RATE, 700, 0.3);
    const def = getEffect('noiseReduction');
    const doc = { noisePrint: print };
    const [y] = await def.process({ channels: [tone], rate: RATE, values: {}, doc });
    expect(rms(y, 8000, 40000) / rms(tone, 8000, 40000)).toBeGreaterThan(0.9);
  });
});

describe('Noise Reduction (process)', () => {
  const def = getEffect('noiseReduction');

  it('needs a noise print', async () => {
    await expect(def.process({ channels: [noise(RATE, 0.1)], rate: RATE, values: {}, doc: {} })).rejects.toThrow(/noise print/i);
    expect(slotSpec(def, {}, { doc: {} }).data).toEqual([]);
  });

  it('removes captured noise and keeps the tone, aligned with the input', async () => {
    const d = await dsp();
    const n = RATE * 2;
    const hiss = noise(n, 0.05, 7);
    const tone = sine(n, 700, 0.3);
    const x = hiss.map((v, i) => v + (i >= n / 2 ? tone[i] : 0));
    const doc = { noisePrint: await captureNoisePrint(d, [noise(RATE, 0.05, 99)], RATE) };
    expect(slotSpec(def, {}, { doc }).data[0].values.length).toBeGreaterThan(4);
    const [y] = await def.process({ channels: [x], rate: RATE, values: { reduction: 100, reduceBy: 30 }, doc });
    expect(y.length).toBe(n);
    expect(rms(y, 20000, 44000) / rms(hiss, 20000, 44000)).toBeLessThan(0.1);
    // Latency is compensated: the output tone lines up with the input tone.
    let dot = 0;
    let tt = 0;
    for (let i = n / 2 + 20000; i < n - 2000; i++) {
      dot += y[i] * tone[i];
      tt += tone[i] * tone[i];
    }
    expect(dot / tt).toBeGreaterThan(0.9);
    expect(dot / tt).toBeLessThan(1.1);
  });
});

describe('DeClicker', () => {
  it('repairs clicks and leaves clean audio alone', async () => {
    const def = getEffect('declicker');
    const n = RATE;
    const clean = sine(n, 330, 0.3).map((v, i) => v + 0.15 * Math.sin((2 * Math.PI * 1210 * i) / RATE) + 0.01 * Math.sin(i * 0.37));
    const clicky = clean.slice();
    for (let i = 1000; i + 3 < n; i += 2500) {
      clicky[i] += 0.6;
      clicky[i + 1] -= 0.4;
    }
    const [y] = await def.process({ channels: [clicky], rate: RATE, values: {} });
    let before = 0;
    let after = 0;
    for (let i = 0; i < n; i++) {
      before += (clicky[i] - clean[i]) ** 2;
      after += (y[i] - clean[i]) ** 2;
    }
    expect(after).toBeLessThan(before * 0.05);
    const [z] = await def.process({ channels: [clean], rate: RATE, values: {} });
    expect(Array.from(z)).toEqual(Array.from(clean));
  });
});

describe('DeClipper', () => {
  it('rebuilds clipped peaks and applies the output gain', async () => {
    const def = getEffect('declipper');
    const clean = sine(9600, 150, 1.3);
    const clipped = clean.map((v) => Math.max(-1, Math.min(1, v)));
    for (const method of [0, 1]) {
      const [y] = await def.process({ channels: [clipped], rate: RATE, values: { gain: 0, method } });
      let errBefore = 0;
      let errAfter = 0;
      let peak = 0;
      for (let i = 0; i < y.length; i++) {
        errBefore += (clipped[i] - clean[i]) ** 2;
        errAfter += (y[i] - clean[i]) ** 2;
        peak = Math.max(peak, Math.abs(y[i]));
      }
      expect(peak).toBeGreaterThan(1.1);
      expect(errAfter).toBeLessThan(errBefore * 0.25);
    }
    const [g] = await def.process({ channels: [sine(4800, 150, 0.5)], rate: RATE, values: { gain: -6 } });
    expect(Math.max(...g)).toBeCloseTo(0.5 * 10 ** (-6 / 20), 2);
  });
});

describe('Capture Noise Print command', () => {
  it('stores the selection noise print on the document', async () => {
    const { installEffectsDsp } = await import('../src/features/effects-dsp.js');
    const commands = new Map();
    const notes = [];
    const samples = noise(RATE, 0.1, 5);
    const events = [];
    const doc = {
      kind: 'audio',
      length: samples.length,
      sampleRate: RATE,
      noisePrint: null,
      state: { channels: [{ toArray: (a, b) => samples.slice(a, b) }] },
      editRange: () => [1000, 21000],
      emit: (type, e) => events.push([type, e.kind]),
    };
    const app = { active: doc, commands: { register: (c) => commands.set(c.id, c) }, notify: (m) => notes.push(m) };
    installEffectsDsp(app);
    const cmd = commands.get('fx.captureNoisePrint');
    expect(cmd.shortcut).toBe('Shift+P');
    expect(cmd.enabled(app)).toBe(true);
    expect(cmd.enabled({ active: null })).toBe(false);
    await cmd.run(app);
    expect(doc.noisePrint.channels).toHaveLength(1);
    expect(doc.noisePrint.seconds).toBeCloseTo(20000 / RATE, 5);
    expect(events).toContainEqual(['change', 'noisePrint']);
    expect(notes[0]).toMatch(/Noise print captured/);
  });
});
