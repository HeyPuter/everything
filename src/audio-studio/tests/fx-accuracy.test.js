// Accuracy sweep of the most-used effects, measured on synthesized signals:
// filter responses against the drawn curves, dynamics static curves and
// time constants, limiter ceilings, gain, pitch and duration, delay times,
// reverb decay, modulation rates, stereo and channel math, envelopes and
// the polarity and reverse edits.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import '../src/effects/catalog.js';
import { getEffect, defaults, paramArray } from '../src/effects/index.js';
import { dsp } from '../src/audio/dsp.js';
import { Channel } from '../src/audio/channel.js';
import { reverseRange, invertRange } from '../src/model/edits.js';
import { RATE, sine, noise, rms, peak, dbOf, tone, zcFrequency, runFx, band } from './helpers/fx-signals.js';

/** Runs a realtime effect over mono or stereo input; returns the output channels (latency compensated). */
async function render(id, values, channels, tail = 0) {
  const def = getEffect(id);
  const all = { ...defaults(def), ...values };
  const data = def.data ? def.data(all, { rate: RATE }) : [];
  return (await dsp()).runEffect(def.kind, RATE, channels, paramArray(def, all), { data: data || [], tail });
}

/** Steady-state gain (dB) of effect `id` at frequency f. */
async function gainDb(id, values, f, amp = 0.1) {
  const n = RATE;
  const x = sine(n, f, RATE, amp);
  const [y] = await render(id, values, [x, x]);
  return dbOf(tone(y, f, RATE, n / 2, n).amp / amp);
}

describe('Parametric EQ', () => {
  const values = {
    band1Gain: -6,
    band1Q: 2,
    band3Gain: 9,
    band3Q: 1.4,
    band5Gain: -4,
    hsOn: true,
    hsGain: 3,
    hsFreq: 10000,
    hpOn: true,
    hpFreq: 40,
  };
  it('measured response matches the drawn curve within 0.5 dB', async () => {
    const def = getEffect('parametricEq');
    const all = { ...defaults(def), ...values };
    const freqs = [50, 120, 250, 700, 1000, 1500, 3000, 6000, 8000, 12000, 16000];
    const drawn = def.response(all, Float64Array.from(freqs), RATE);
    for (let k = 0; k < freqs.length; k++) {
      const m = await gainDb('parametricEq', values, freqs[k]);
      expect(Math.abs(m - drawn[k]), `${freqs[k]} Hz: measured ${m.toFixed(2)}, drawn ${drawn[k].toFixed(2)}`).toBeLessThan(0.5);
    }
  });
});

describe('Graphic EQ (10 bands)', () => {
  it('measured response matches the drawn curve within 0.5 dB', async () => {
    const def = getEffect('graphicEq10');
    const values = { band2: 6, band4: -8, band6: 4, band8: -3, band10: 5 };
    const all = { ...defaults(def), ...values };
    const freqs = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000, 700, 3000];
    const drawn = def.response(all, Float64Array.from(freqs), RATE);
    for (let k = 0; k < freqs.length; k++) {
      const m = await gainDb('graphicEq10', values, freqs[k]);
      expect(Math.abs(m - drawn[k]), `${freqs[k]} Hz: measured ${m.toFixed(2)}, drawn ${drawn[k].toFixed(2)}`).toBeLessThan(0.5);
    }
  });
});

/** Output peak (dB) of a steady sine at `inDb` peak through `id`. */
async function staticOut(id, values, inDb, f = 1000) {
  const n = RATE;
  const a = 10 ** (inDb / 20);
  const x = sine(n, f, RATE, a);
  const [y] = await render(id, values, [x, x]);
  return dbOf(peak(y, n / 2, n));
}

describe('compressor static curves follow threshold and ratio', () => {
  const cases = [
    ['singleBandCompressor', { threshold: -20, ratio: 4, knee: 0, attack: 1, release: 50, detection: 0 }],
    ['singleBandCompressor', { threshold: -30, ratio: 2, knee: 6, attack: 1, release: 50, detection: 0, outputGain: 3 }],
    ['dynamics', { threshold: -24, ratio: 3, knee: 0, attack: 1, release: 50, detection: 0 }],
  ];
  for (const [id, values] of cases) {
    it(`${id} ${values.threshold} dB ${values.ratio}:1`, async () => {
      const def = getEffect(id);
      const all = { ...defaults(def), ...values };
      for (const inDb of [-40, -25, -18, -10, -3]) {
        const out = await staticOut(id, values, inDb);
        const want = def.transfer(all, inDb);
        expect(Math.abs(out - want), `in ${inDb}: out ${out.toFixed(2)}, curve ${want.toFixed(2)}`).toBeLessThan(0.5);
      }
    });
  }

  it('Dynamics Processing follows its drawn curve', async () => {
    const def = getEffect('dynamicsProcessing');
    const values = { curve: [{ x: -100, y: -100 }, { x: -30, y: -30 }, { x: 0, y: -15 }], attack: 1, release: 50, detection: 0, lookahead: 2 };
    const all = { ...defaults(def), ...values };
    for (const inDb of [-40, -24, -12, -3]) {
      const out = await staticOut('dynamicsProcessing', values, inDb);
      const want = def.transfer(all, inDb);
      expect(Math.abs(out - want), `in ${inDb}: out ${out.toFixed(2)}, curve ${want.toFixed(2)}`).toBeLessThan(0.5);
    }
  });

  it('RMS detection reads a sine at its RMS level (3 dB under its peak)', async () => {
    const values = { threshold: -20, ratio: 4, knee: 0, attack: 1, release: 50, detection: 1 };
    const out = await staticOut('singleBandCompressor', values, -5);
    // Sine RMS -8 dB: 12 dB over, 9 dB of reduction at 4:1.
    expect(out).toBeCloseTo(-5 - 9, 0);
  });

  it('Multiband Compressor is transparent when no band compresses, and compresses inside a band by its ratio', async () => {
    const flat = {};
    for (let b = 1; b <= 4; b++) Object.assign(flat, { [`band${b}Threshold`]: 0, [`band${b}Ratio`]: 1 });
    for (const f of [60, 120, 500, 2000, 6000, 10000, 15000]) {
      const g = await gainDb('multibandCompressor', { ...flat, limiter: false }, f);
      expect(Math.abs(g), `${f} Hz: ${g.toFixed(2)} dB`).toBeLessThan(0.3);
    }
    const comp = { ...flat, band2Threshold: -30, band2Ratio: 4, band2Attack: 1, band2Release: 50, limiter: false };
    const out = await staticOut('multibandCompressor', comp, -10, 700);
    // 20 dB over the threshold at 4:1: 15 dB of reduction.
    expect(out).toBeGreaterThan(-25.8);
    expect(out).toBeLessThan(-24.2);
  });
});

/** Time (ms) for the gain reduction to cover 63 % of its change (in dB) after a level step at `at`. */
function timeConstant(x, y, at, from, to) {
  const g = [];
  const win = 48; // 1 ms
  for (let i = at; i + win <= to; i += win) g.push(dbOf(peakOf(y, i, i + win * 2) / Math.max(1e-9, peakOf(x, i, i + win * 2))));
  const start = dbOf(peakOf(y, from - 960, from) / peakOf(x, from - 960, from));
  const end = g[g.length - 1];
  const target = start + (end - start) * 0.632;
  const k = g.findIndex((v) => (end < start ? v <= target : v >= target));
  return k * (win / RATE) * 1000;
}
const peakOf = (x, a, b) => peak(x, a, b);

describe('compressor attack and release time constants', () => {
  for (const [id, attack, release] of [
    ['singleBandCompressor', 10, 100],
    ['singleBandCompressor', 30, 300],
    ['dynamics', 10, 150],
  ]) {
    it(`${id} attack ${attack} ms, release ${release} ms`, async () => {
      const n = RATE * 3;
      const x = new Float32Array(n);
      const step = RATE;
      const back = 2 * RATE;
      for (let i = 0; i < n; i++) x[i] = (i >= step && i < back ? 0.5 : 0.01) * Math.sin((2 * Math.PI * 1000 * i) / RATE);
      const [y] = await render(id, { threshold: -30, ratio: 10, knee: 0, attack, release, detection: 0 }, [x, x]);
      const a = timeConstant(x, y, step, step, step + Math.round(RATE * 0.6));
      const r = timeConstant(x, y, back, back, back + Math.round(RATE * 0.9));
      expect(a, `attack measured ${a.toFixed(1)} ms`).toBeGreaterThan(attack * 0.5);
      expect(a, `attack measured ${a.toFixed(1)} ms`).toBeLessThan(attack * 1.6);
      expect(r, `release measured ${r.toFixed(1)} ms`).toBeGreaterThan(release * 0.5);
      expect(r, `release measured ${r.toFixed(1)} ms`).toBeLessThan(release * 1.6);
    });
  }
});

describe('Hard Limiter', () => {
  // Program-like material: noise band-limited to 16 kHz plus a bright tone.
  const loud = () => {
    const n = RATE;
    const x = band(noise(n, 0.6, 4), 0, 16000);
    const s = sine(n, 9000, RATE, 0.7, 0.3);
    return x.map((v, i) => v + s[i]);
  };
  /** 4x oversampled peak (windowed-sinc interpolation). */
  const truePeak = (x) => {
    let p = 0;
    const taps = 16;
    for (let i = taps; i < x.length - taps; i++) {
      for (const f of [0.25, 0.5, 0.75]) {
        let s = 0;
        for (let k = -taps + 1; k <= taps; k++) {
          const t = k - f;
          const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / taps);
          s += x[i + k] * (Math.sin(Math.PI * t) / (Math.PI * t)) * w;
        }
        p = Math.max(p, Math.abs(s));
      }
      p = Math.max(p, Math.abs(x[i]));
    }
    return p;
  };
  it('never exceeds the ceiling, even with heavy input boost', async () => {
    for (const ceiling of [-0.1, -3, -12]) {
      const [y, z] = await render('hardLimiter', { ceiling, inputBoost: 12 }, [loud(), loud()]);
      expect(dbOf(Math.max(peak(y), peak(z)))).toBeLessThanOrEqual(ceiling + 1e-3);
    }
  });
  it('True Peak keeps inter-sample peaks under the ceiling', async () => {
    const [y] = await render('hardLimiter', { ceiling: -1, inputBoost: 12, truePeak: 1 }, [loud(), loud()]);
    expect(dbOf(truePeak(y.subarray(2000)))).toBeLessThanOrEqual(-1 + 0.1);
  });
});

describe('Amplify and Normalize', () => {
  it('Amplify scales by exactly its gain per channel', async () => {
    const x = sine(4800, 300, RATE, 0.1);
    const [l, r] = await render('amplify', { left: 6, right: -12, linked: false }, [x, x]);
    expect(peak(l, 2400) / peak(x, 2400)).toBeCloseTo(10 ** (6 / 20), 3);
    expect(peak(r, 2400) / peak(x, 2400)).toBeCloseTo(10 ** (-12 / 20), 3);
  });
  it('Normalize reaches dB and percent targets exactly', async () => {
    const x = sine(4800, 300, RATE, 0.123);
    for (const [values, want] of [
      [{ unit: 0, targetDb: -3 }, 10 ** (-3 / 20)],
      [{ unit: 1, targetPercent: 50 }, 0.5],
    ]) {
      const [y] = await runFx('normalize', values, [x]);
      expect(peak(y)).toBeCloseTo(want, 5);
    }
  });
});

describe('pitch and time', () => {
  it('Pitch Shifter moves a tone by the set interval and keeps the duration', async () => {
    const n = RATE * 2;
    const x = sine(n, 440, RATE, 0.3);
    for (const [semitones, cents] of [
      [7, 0],
      [-5, 0],
      [0, 50],
    ]) {
      const [y] = await render('pitchShifter', { semitones, cents }, [x, x]);
      expect(y.length).toBe(n);
      const f = zcFrequency(y, RATE, RATE / 2, n - RATE / 4);
      const want = 440 * 2 ** ((semitones + cents / 100) / 12);
      expect(Math.abs(f / want - 1), `${semitones} st ${cents} ct: ${f.toFixed(2)} Hz, want ${want.toFixed(2)}`).toBeLessThan(0.003);
    }
  });
  it('Stretch and Pitch: stretched duration and shifted pitch are exact', async () => {
    const n = RATE * 2;
    const x = sine(n, 440, RATE, 0.3);
    for (const values of [
      { stretch: 150, semitones: 0 },
      { stretch: 75, semitones: 0 },
      { stretch: 100, semitones: 12 },
      { stretch: 120, semitones: -3, algorithm: 1 },
    ]) {
      const [y] = await runFx('stretchPitch', values, [x]);
      const len = n * (values.stretch / 100);
      expect(Math.abs(y.length - len), `${JSON.stringify(values)} length ${y.length}`).toBeLessThan(len * 0.005);
      const f = zcFrequency(y, RATE, Math.round(y.length * 0.2), Math.round(y.length * 0.8));
      const want = 440 * 2 ** (values.semitones / 12);
      expect(Math.abs(f / want - 1), `${JSON.stringify(values)}: ${f.toFixed(2)} Hz`).toBeLessThan(0.003);
    }
  });
});

/** Frames of the strongest peaks in x after `from`, at least `gap` apart, louder first. */
function peaks(x, count, gap) {
  const idx = [];
  const used = new Uint8Array(x.length);
  for (let c = 0; c < count; c++) {
    let best = -1;
    for (let i = 0; i < x.length; i++) if (!used[i] && (best < 0 || Math.abs(x[i]) > Math.abs(x[best]))) best = i;
    if (best < 0) break;
    idx.push(best);
    for (let i = Math.max(0, best - gap); i < Math.min(x.length, best + gap); i++) used[i] = 1;
  }
  return idx.sort((a, b) => a - b);
}

describe('Delay and Echo timing', () => {
  const impulse = (n, at = 100) => {
    const x = new Float32Array(n);
    x[at] = 1;
    return x;
  };
  it('Delay repeats at the set time on each channel', async () => {
    const x = impulse(RATE);
    const [l, r] = await render('delay', { leftDelay: 125, rightDelay: 333, leftMix: 50, rightMix: 50 }, [x, x]);
    expect(peaks(l, 2, 100)).toEqual([100, 100 + Math.round(0.125 * RATE)]);
    expect(peaks(r, 2, 100)).toEqual([100, 100 + Math.round(0.333 * RATE)]);
  });
  it('Echo repeats every delay time, each repeat lower by the feedback', async () => {
    const x = impulse(RATE * 2);
    const [l] = await render('echo', { leftDelay: 200, rightDelay: 200, leftFeedback: 50, rightFeedback: 50, dry: 100 }, [x, x], 0);
    const p = peaks(l, 4, 200);
    const d = Math.round(0.2 * RATE);
    expect(p).toEqual([100, 100 + d, 100 + 2 * d, 100 + 3 * d]);
    const e = (i) => Math.max(...Array.from(l.subarray(i - 4, i + 5), Math.abs));
    expect(e(p[3]) / e(p[2])).toBeCloseTo(0.5, 1);
  });
});

/** RT60 (s) from the Schroeder decay of an impulse response, fitted over -5..-25 dB. */
function rt60(y, from) {
  const e = new Float64Array(y.length - from + 1);
  for (let i = y.length - 1; i >= from; i--) e[i - from] = e[i - from + 1] + y[i] * y[i];
  const db = (i) => 10 * Math.log10(e[i] / e[0] + 1e-30);
  let a = -1;
  let b = -1;
  for (let i = 0; i < e.length - 1; i++) {
    if (a < 0 && db(i) <= -5) a = i;
    if (b < 0 && db(i) <= -25) {
      b = i;
      break;
    }
  }
  return ((b - a) / RATE) * 3;
}

describe('reverbs decay roughly as set', () => {
  for (const [id, values, seconds] of [
    ['reverb', { decay: 1000, preDelay: 0, dry: 0, wet: 100 }, 1],
    ['reverb', { decay: 3000, preDelay: 0, dry: 0, wet: 100 }, 3],
    ['studioReverb', { decay: 1500, dry: 0, wet: 100 }, 1.5],
    ['fullReverb', { decay: 2000, preDelay: 0, dry: 0, reverb: 100, early: 0 }, 2],
  ]) {
    it(`${id} ${seconds} s`, async () => {
      const x = new Float32Array(RATE * (seconds * 2 + 1));
      x[100] = 1;
      const [l, r] = await render(id, values, [x, x]);
      const y = l.map((v, i) => v + r[i]);
      const t = rt60(y, 100);
      expect(t, `RT60 ${t.toFixed(2)} s`).toBeGreaterThan(seconds * 0.7);
      expect(t, `RT60 ${t.toFixed(2)} s`).toBeLessThan(seconds * 1.4);
    });
  }
});

/** Autocorrelation of a series without its mean. */
function autocorr(e, maxLag) {
  const m = e.reduce((s, v) => s + v, 0) / e.length;
  const ac = [];
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < e.length; i++) s += (e[i] - m) * (e[i + lag] - m);
    ac.push(s / (e.length - lag));
  }
  return ac;
}

/** Period (s) of series `e` sampled every `dt` s: the strongest autocorrelation peak in [0.6, 1.5] x `expect`. */
function period(e, dt, expect) {
  const lo = Math.floor((expect * 0.6) / dt);
  const hi = Math.ceil((expect * 1.5) / dt);
  const ac = autocorr(e, hi + 1);
  let best = lo;
  for (let lag = lo; lag <= hi; lag++) if (ac[lag] > ac[best]) best = lag;
  const [a, b, c] = [ac[best - 1], ac[best], ac[best + 1]];
  const off = (a - c) / (2 * (a - 2 * b + c) || 1);
  return (best + off) * dt;
}

/** Level envelope of y in 10 ms windows from `from`. */
function envelope(y, from) {
  const win = 480;
  const env = [];
  for (let i = from; i + win <= y.length; i += win) env.push(rms(y, i, i + win));
  return env;
}

describe('modulation rates', () => {
  const n = RATE * 12;
  // 1.1 kHz: at 1 kHz the flanger's 1..5 ms sweep gives a level pattern that repeats every half cycle.
  const x = sine(n, 1100, RATE, 0.3);
  for (const [id, values, rate] of [
    ['phaser', { rate: 0.5, mix: 50, feedback: 0 }, 0.5],
    ['phaser', { rate: 2, mix: 50, feedback: 0 }, 2],
    ['flanger', { rate: 0.5, mix: 50, feedback: 0 }, 0.5],
    ['flanger', { rate: 1.5, mix: 50, feedback: 0 }, 1.5],
  ]) {
    it(`${id} sweeps at ${rate} Hz`, async () => {
      const [y] = await render(id, values, [x, x]);
      const T = period(envelope(y, RATE), 0.01, 1 / rate);
      expect(Math.abs(1 / T / rate - 1), `${id}: ${(1 / T).toFixed(3)} Hz`).toBeLessThan(0.03);
    });
  }

  // With the stereo field at its widest the first voice is alone in the left channel.
  it('Chorus modulates level at the Modulation Rate and pitch at the Delay Rate', async () => {
    const base = { voices: 2, width: 100, dry: 0, wet: 100, feedback: 0 };
    const [am] = await render('chorus', { ...base, depth: 10, modRate: 0.8, delayRate: 0.02 }, [x, x]);
    const Ta = period(envelope(am, RATE), 0.01, 1 / 0.8);
    expect(Math.abs(1 / Ta / 0.8 - 1), `level ${(1 / Ta).toFixed(3)} Hz`).toBeLessThan(0.03);
    const [fm] = await render('chorus', { ...base, depth: 0, delayRate: 0.7, delay: 20 }, [x, x]);
    const f = [];
    for (let i = RATE; i + 960 <= n; i += 480) f.push(zcFrequency(fm, RATE, i, i + 960));
    const Tf = period(f, 0.01, 1 / 0.7);
    expect(Math.abs(1 / Tf / 0.7 - 1), `pitch ${(1 / Tf).toFixed(3)} Hz`).toBeLessThan(0.03);
  });
});

describe('Stereo Expander', () => {
  it('widening keeps the mono sum unchanged', async () => {
    const n = RATE;
    const l = sine(n, 300, RATE, 0.3);
    const r = sine(n, 500, RATE, 0.2).map((v, i) => v + 0.5 * l[i]);
    for (const width of [0, 50, 200, 300]) {
      const [a, b] = await render('stereoExpander', { width }, [l, r]);
      const diff = new Float32Array(n);
      for (let i = 0; i < n; i++) diff[i] = (a[i] + b[i]) / 2 - (l[i] + r[i]) / 2;
      expect(dbOf(rms(diff, 4800) / rms(l.map((v, i) => (v + r[i]) / 2), 4800)), `width ${width}`).toBeLessThan(-40);
    }
  });
});

describe('Channel Mixer', () => {
  it('builds each output from the input amounts exactly', async () => {
    const n = 4800;
    const l = sine(n, 300, RATE, 0.3);
    const r = sine(n, 700, RATE, 0.2);
    const [a, b] = await render('channelMixer', { lToL: 50, rToL: -25, lToR: 0, rToR: 150, invertR: true }, [l, r]);
    for (let i = 0; i < n; i += 37) {
      expect(a[i]).toBeCloseTo(0.5 * l[i] - 0.25 * r[i], 5);
      expect(b[i]).toBeCloseTo(-1.5 * r[i], 5);
    }
  });
});

describe('Fade and Gain Envelopes', () => {
  it('apply the drawn gain sample by sample', async () => {
    const n = 1001;
    const x = new Float32Array(n).fill(0.5);
    const [fade] = await runFx('fadeEnvelope', { envelope: [{ t: 0, v: 0 }, { t: 1, v: 1 }], curve: 0 }, [x]);
    expect(fade[0]).toBe(0);
    expect(fade[500]).toBeCloseTo(0.25, 6);
    expect(fade[1000]).toBeCloseTo(0.5, 6);
    const [gain] = await runFx('gainEnvelope', { envelope: [{ t: 0, v: 2 }, { t: 0.5, v: 0.5 }, { t: 1, v: 1 }], curve: 0 }, [x]);
    expect(gain[0]).toBeCloseTo(1, 6);
    expect(gain[500]).toBeCloseTo(0.25, 6);
    expect(gain[750]).toBeCloseTo(0.375, 6);
    expect(gain[1000]).toBeCloseTo(0.5, 6);
  });
});

describe('Invert and Reverse', () => {
  it('are exact and undo themselves', () => {
    const x = sine(1000, 440, RATE, 0.4);
    const state = { sampleRate: RATE, channels: [Channel.fromSamples(x)], markers: [] };
    const inv = invertRange(state, 100, 900, null).channels[0].toArray();
    const rev = reverseRange(state, 100, 900, null).channels[0].toArray();
    for (let i = 0; i < 1000; i++) {
      expect(inv[i]).toBe(i >= 100 && i < 900 ? -x[i] : x[i]);
      expect(rev[i]).toBe(i >= 100 && i < 900 ? x[999 - i] : x[i]);
    }
    const back = reverseRange(reverseRange(state, 100, 900, null), 100, 900, null).channels[0].toArray();
    expect(Array.from(back)).toEqual(Array.from(x));
  });
});
