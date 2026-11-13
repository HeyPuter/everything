// Filter and EQ definitions: the JS response curves (used to draw EQ graphs)
// match what the WASM processors actually do to sine waves, for defaults and
// every preset.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import { dsp } from '../src/audio/dsp.js';
import { getEffect, defaults, paramArray } from '../src/effects/index.js';

const RATE = 48000;
const FREQS = [50, 200, 1000, 3000, 9000];

function sine(f, n) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.25 * Math.sin((2 * Math.PI * f * i) / RATE);
  return x;
}

const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

async function measured(def, values, f) {
  const d = await dsp();
  // Narrow notches ring for a while; give them time to settle.
  const n = Math.round(RATE * (def.id === 'notchFilter' ? 2 : 0.5));
  const x = sine(f, n);
  const data = def.data ? def.data(values, { rate: RATE }) : [];
  const [y] = d.runEffect(def.kind, RATE, [x], paramArray(def, values), { data });
  const from = n - Math.round(RATE * 0.25);
  return 20 * Math.log10(rms(y.subarray(from)) / rms(x.subarray(from)));
}

describe('filter response curves match the processors', () => {
  for (const id of ['parametricEq', 'graphicEq10', 'graphicEq20', 'graphicEq30', 'notchFilter', 'scientificFilter']) {
    it(id, async () => {
      const def = getEffect(id);
      for (const preset of [{ name: 'defaults', values: {} }, ...def.presets]) {
        const values = { ...defaults(def), ...preset.values };
        const curve = def.response(values, FREQS, RATE);
        expect(curve).toBeInstanceOf(Float32Array);
        for (let i = 0; i < FREQS.length; i++) {
          const got = await measured(def, values, FREQS[i]);
          if (curve[i] < -35) expect(got, `${preset.name} at ${FREQS[i]} Hz`).toBeLessThan(-30);
          else expect(Math.abs(got - curve[i]), `${preset.name} at ${FREQS[i]} Hz: ${got} vs ${curve[i]}`).toBeLessThan(0.5);
        }
      }
    });
  }

  it('fftFilter follows its curve', async () => {
    const def = getEffect('fftFilter');
    const values = { ...defaults(def), ...def.presets.find((p) => p.name === 'Presence Lift').values };
    for (const f of [200, 1000, 3500, 12000]) {
      const want = def.response(values, [f], RATE)[0];
      expect(Math.abs((await measured(def, values, f)) - want), `${f} Hz`).toBeLessThan(0.75);
    }
    expect(def.latency(values, RATE)).toBe(4096);
  });

  it('scientificFilter keeps a 0 dB passband with band edges near DC at 192 kHz', async () => {
    const d = await dsp();
    const def = getEffect('scientificFilter');
    const rate = 192000;
    const values = { ...defaults(def), mode: 3, order: 8, cutoff: 10, highCutoff: 200 };
    for (const f of [2000, 20000]) {
      const x = new Float32Array(rate);
      for (let i = 0; i < rate; i++) x[i] = 0.25 * Math.sin((2 * Math.PI * f * i) / rate);
      const [y] = d.runEffect(def.kind, rate, [x], paramArray(def, values));
      const db = 20 * Math.log10(rms(y.subarray(rate / 2)) / rms(x.subarray(rate / 2)));
      expect(Math.abs(db), `${f} Hz`).toBeLessThan(0.1);
    }
  });
});

describe('filter definitions', () => {
  it('lay out parametric EQ parameters in the order the processor reads them', () => {
    const ids = getEffect('parametricEq').params.map((p) => p.id);
    expect(ids.length).toBe(38);
    expect(ids.slice(36)).toEqual(['ultraQuiet', 'range']);
    expect(ids.slice(0, 9)).toEqual(['gain', 'qMode', 'hpOn', 'hpFreq', 'hpSlope', 'lsOn', 'lsFreq', 'lsGain', 'lsQ']);
    expect(ids.slice(9, 13)).toEqual(['band1On', 'band1Freq', 'band1Gain', 'band1Q']);
    expect(ids.slice(29, 36)).toEqual(['hsOn', 'hsFreq', 'hsGain', 'hsQ', 'lpOn', 'lpFreq', 'lpSlope']);
  });

  it('use ISO centre frequencies for the graphic equalizers', () => {
    expect(getEffect('graphicEq10').bands).toEqual([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
    expect(getEffect('graphicEq20').bands.length).toBe(20);
    expect(getEffect('graphicEq30').bands.length).toBe(30);
    expect(getEffect('graphicEq30').params.length).toBe(33);
  });

  it('send curves to WASM as data and report STFT latency', () => {
    const fft = getEffect('fftFilter');
    const values = { ...defaults(fft), curve: [{ f: 1000, g: -6 }, { f: 100, g: 0 }], fftSize: 2048 };
    const [d] = fft.data(values, { rate: RATE });
    expect(d.slot).toBe(0);
    expect(Array.from(d.values)).toEqual([100, 0, 1000, -6]);
    expect(fft.latency(values)).toBe(2048);
    const d2 = fft.data({ ...values, curve: [{ f: 100, g: 0 }, { f: 1000, g: -7 }] }, { rate: RATE })[0];
    expect(d2.id).not.toBe(d.id);
    expect(getEffect('centerChannelExtractor').latency({ fftSize: 8192 })).toBe(8192);
    expect(getEffect('graphicPhaseShifter').latency({ fftSize: 1024 })).toBe(1024);
  });
});

describe('stereo imagery through the offline runner', () => {
  it('lines up spectral effects with their input after latency compensation', async () => {
    const d = await dsp();
    const def = getEffect('graphicPhaseShifter');
    const values = defaults(def);
    const n = RATE;
    const l = sine(700, n);
    const r = sine(1300, n);
    const [ol, or] = d.runEffect(def.kind, RATE, [l, r], paramArray(def, values), { data: def.data(values, { rate: RATE }) });
    expect(ol.length).toBe(n);
    for (let i = 4096; i < n - 4096; i += 97) {
      expect(Math.abs(ol[i] - l[i])).toBeLessThan(1e-3);
      expect(Math.abs(or[i] - r[i])).toBeLessThan(1e-3);
    }
  });

  it('removes a centred tone with the Remove Lead Vocal preset', async () => {
    const d = await dsp();
    const def = getEffect('centerChannelExtractor');
    const values = { ...defaults(def), ...def.presets.find((p) => p.name === 'Remove Lead Vocal').values };
    const n = RATE;
    const c = sine(1000, n);
    const side = sine(500, n);
    const l = c.map((v, i) => v + side[i]);
    const [ol, or] = d.runEffect(def.kind, RATE, [l, c], paramArray(def, values));
    // Left keeps its 500 Hz side tone, right (centre only) goes quiet.
    expect(rms(or.subarray(8192, n - 8192))).toBeLessThan(0.01);
    expect(rms(ol.subarray(8192, n - 8192))).toBeGreaterThan(0.15);
  });
});
