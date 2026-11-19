// Effects at their default settings do an audible job on typical material:
// measured on synthesized voice-like speech, noise and music.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import { speech, runFx, band, segRms, dbOf, gaussNoise, filter, biquad, rms, spectralPeakiness, sine, peak, zcFrequency, RATE } from './helpers/fx-signals.js';
import { getEffect, slotSpec, EFFECTS } from '../src/effects/index.js';
import { Channel } from '../src/audio/channel.js';
import { lastValues, rememberValues, matchPreset } from '../src/effects/presets.js';
import { normalizeValues } from '../src/effects/params.js';
import { memoryPrefs } from './fx-helpers.js';
import { captureNoisePrint, detectHum } from '../src/effects/defs/restoration.js';
import { dsp } from '../src/audio/dsp.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import { createSessionState, createClip } from '../src/model/session-edits.js';

describe('DeEsser defaults', () => {
  for (const [vowelDb, sibilantDb] of [
    [-18, -26],
    [-30, -40],
    [-14, -20],
    [-12, -28],
  ]) {
    it(`take sibilants down by 3..6 dB and leave vowels alone (vowels ${vowelDb} dBFS, sibilants ${sibilantDb} dBFS)`, async () => {
      const sp = speech({ vowelDb, sibilantDb });
      const [y] = await runFx('deesser', {}, [sp.x]);
      const before = dbOf(segRms(band(sp.x, 5000, 10000), sp.sibilants));
      const after = dbOf(segRms(band(y, 5000, 10000), sp.sibilants));
      expect(before - after).toBeGreaterThan(3);
      expect(before - after).toBeLessThan(6);
      // Vowels: level and their upper range (presence, air) unchanged.
      expect(Math.abs(dbOf(segRms(y, sp.vowels)) - vowelDb)).toBeLessThan(0.1);
      const hf = (s) => dbOf(segRms(band(s, 2000, 20000), sp.vowels));
      expect(hf(sp.x) - hf(y)).toBeLessThan(0.5);
    });
  }
});

describe('Noise Reduction defaults', () => {
  for (const colour of ['white', 'low-pass']) {
    it(`take a steady ${colour} noise floor down by 12..22 dB without musical residue or speech damage`, async () => {
      const d = await dsp();
      const n = RATE * 6;
      let nz = gaussNoise(n + RATE, 0.01, 5);
      if (colour !== 'white') {
        nz = filter(nz, biquad('lp', 400, 0.7));
        const g = 0.01 / rms(nz);
        nz = nz.map((v) => v * g);
      }
      // The print comes from a separate stretch of the same noise.
      const print = await captureNoisePrint(d, [nz.subarray(n, n + RATE)], RATE);
      const sp = speech({ seconds: 6, pause: 1.2 });
      const x = sp.x.map((v, i) => v + nz[i]);
      const [y] = await runFx('noiseReduction', {}, [x], { extra: { noisePrint: print } });
      // Pauses, from half a second after the speech (the gain has settled).
      const quiet = sp.pauses.filter(([a, b]) => b - a > RATE).map(([a, b]) => [a + RATE / 2, b - 2400]);
      const removed = dbOf(segRms(x, quiet)) - dbOf(segRms(y, quiet));
      expect(removed).toBeGreaterThan(12);
      expect(removed).toBeLessThan(22);
      // What is left is a steady, quieter floor (no tonal blips coming and going).
      expect(spectralPeakiness(y, quiet)).toBeLessThan(2.3);
      // Speech: level kept, and the vowels end up closer to the clean voice than the noisy input was.
      expect(Math.abs(dbOf(segRms(y, sp.vowels)) - dbOf(segRms(sp.x, sp.vowels)))).toBeLessThan(0.3);
      const err = (s) => dbOf(segRms(s.map((v, i) => v - sp.x[i]), sp.vowels));
      expect(err(y)).toBeLessThan(err(x));
    });
  }
});

describe('dialogs open with the last-applied settings, else the defaults', () => {
  it('every effect opens with its defaults, and its first preset is the defaults', () => {
    for (const def of EFFECTS.values()) {
      const d = normalizeValues(def, {});
      expect(lastValues(memoryPrefs(), def), def.id).toEqual(d);
      if (def.presets.length) expect(normalizeValues(def, def.presets[0].values), `${def.id} first preset`).toEqual(d);
    }
  });
  it('effects whose presets are all variations list "Default" first', () => {
    for (const id of ['hissReduction', 'denoise', 'dereverb', 'adaptiveNoiseReduction', 'autoClickRemover', 'declicker', 'notchFilter', 'scientificFilter', 'autoPhaseCorrection', 'automaticPitchCorrection', 'dopplerShifter', 'centerChannelExtractor']) {
      const def = getEffect(id);
      expect(def.presets[0].name, id).toBe('Default');
      expect(matchPreset(memoryPrefs(), def, lastValues(memoryPrefs(), def)), id).toBe('Default');
    }
  });
  it('reopens with the settings last applied', () => {
    const prefs = memoryPrefs();
    const def = getEffect('denoise');
    rememberValues(prefs, def, { amount: 70 });
    expect(lastValues(prefs, def).amount).toBe(70);
  });
});

/** Speech with a noise floor (`colour` white or hiss: above 3 kHz) at `ndb` dBFS, through effect `id` at its defaults. */
async function denoised(id, colour = 'white', ndb = -50) {
  const sp = speech({ seconds: 6, pause: 1.2 });
  let nz = gaussNoise(sp.x.length, 1, 5);
  if (colour === 'hiss') nz = filter(nz, biquad('hp', 3000, 0.7));
  const g = 10 ** (ndb / 20) / rms(nz);
  const x = sp.x.map((v, i) => v + nz[i] * g);
  const [y] = await runFx(id, {}, [x, x.slice()]);
  const quiet = sp.pauses.filter(([a, b]) => b - a > RATE).map(([a, b]) => [a + RATE / 2, b - 2400]);
  const err = (s) => dbOf(segRms(s.map((v, i) => v - sp.x[i]), sp.vowels));
  return {
    removed: dbOf(segRms(x, quiet)) - dbOf(segRms(y, quiet)),
    vowel: dbOf(segRms(y, sp.vowels)) - dbOf(segRms(sp.x, sp.vowels)),
    cleaner: err(x) - err(y),
  };
}

describe('restoration defaults do an audible, safe job', () => {
  for (const [id, colour, lo, hi] of [
    ['hissReduction', 'hiss', 12, 24],
    ['denoise', 'white', 10, 22],
    ['adaptiveNoiseReduction', 'white', 14, 24],
  ]) {
    it(`${id} takes a ${colour} floor down by ${lo}..${hi} dB and keeps the voice`, async () => {
      const r = await denoised(id, colour);
      expect(r.removed).toBeGreaterThan(lo);
      expect(r.removed).toBeLessThan(hi);
      expect(Math.abs(r.vowel)).toBeLessThan(0.5);
      expect(r.cleaner).toBeGreaterThan(3);
    });
  }

  it('DeReverb shortens a room tail and keeps the voice level (Auto Gain)', async () => {
    const sp = speech({ seconds: 6, pause: 1.2 });
    // An exponentially decaying noise room (RT60 0.8 s), sparsely convolved.
    const ir = gaussNoise(Math.round(RATE * 1.2), 1, 7).map((v, i) => v * Math.exp((-6.9 * i) / (0.8 * RATE)) * 0.03);
    const x = sp.x.slice();
    for (let k = 7; k < ir.length; k += 7) for (let i = k; i < x.length; i++) x[i] += ir[k] * 7 * sp.x[i - k];
    const [y] = await runFx('dereverb', {}, [x, x.slice()]);
    const tails = sp.pauses.filter(([a, b]) => b - a > RATE).map(([a]) => [a + 2400, a + RATE / 2]);
    expect(dbOf(segRms(x, tails)) - dbOf(segRms(y, tails))).toBeGreaterThan(2.5);
    expect(Math.abs(dbOf(segRms(y, sp.vowels)) - dbOf(segRms(x, sp.vowels)))).toBeLessThan(0.6);
  });

  /** Speech over a faint floor (or digital silence) with 1..4-sample clicks every 80..180 ms. */
  const clicky = (floor = 0.0003) => {
    const sp = speech({ seconds: 4, pause: 0.4 });
    const fl = gaussNoise(sp.x.length, floor, 9);
    const clean = sp.x.map((v, i) => v + (floor ? fl[i] : 0));
    const x = clean.slice();
    const at = [];
    let s = 11;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 2000; i < x.length - 2000; i += Math.round(RATE * (0.08 + 0.1 * rnd()))) {
      at.push(i);
      const w = 1 + Math.floor(rnd() * 4);
      const amp = (rnd() > 0.5 ? 1 : -1) * (0.2 + 0.4 * rnd());
      for (let j = 0; j < w; j++) x[i + j] += amp;
    }
    return { clean, x, at };
  };
  for (const [id, minFixed, maxDamage, floor] of [
    ['autoClickRemover', 0.8, -40, 0.0003],
    ['declicker', 0.9, -55, 0.0003],
    // Pauses of digital silence: clicks there are repaired too (the first
    // glottal pulses after a pause can still pass for clicks, hence the looser bounds).
    ['autoClickRemover', 0.65, -36, 0],
    ['declicker', 0.9, -36, 0],
  ]) {
    it(`${id} repairs most clicks without touching the audio between them (${floor ? 'faint floor' : 'digital silence'})`, async () => {
      const { clean, x, at } = clicky(floor);
      const [y] = await runFx(id, {}, [x, x.slice()]);
      const err = (s, i) => {
        let e = 0;
        for (let j = i - 2; j < i + 8; j++) e += (s[j] - clean[j]) ** 2;
        return e;
      };
      const fixed = at.filter((i) => err(y, i) < err(x, i) * 0.05).length;
      expect(fixed / at.length).toBeGreaterThan(minFixed);
      const near = new Uint8Array(x.length);
      for (const i of at) near.fill(1, i - 64, i + 64);
      let e = 0;
      let c = 0;
      for (let i = 0; i < x.length; i++) {
        if (near[i]) continue;
        e += (y[i] - clean[i]) ** 2;
        c++;
      }
      expect(dbOf(Math.sqrt(e / c))).toBeLessThan(maxDamage);
    });
  }

  it('Notch Filter takes 60 Hz hum down and leaves speech alone', async () => {
    const sp = speech({ seconds: 4 });
    const hum = sine(sp.x.length, 60, RATE, 0.03);
    const x = sp.x.map((v, i) => v + hum[i]);
    const [y] = await runFx('notchFilter', {}, [x, x.slice()]);
    const low = (s) => dbOf(rms(band(s, 50, 70)));
    expect(low(x) - low(y)).toBeGreaterThan(15);
    expect(Math.abs(dbOf(segRms(y, sp.vowels)) - dbOf(segRms(x, sp.vowels)))).toBeLessThan(0.3);
  });

  it('Automatic Pitch Correction pulls a sharp note into tune', async () => {
    const x = sine(RATE * 2, 450, RATE, 0.3);
    const [y] = await runFx('automaticPitchCorrection', {}, [x, x.slice()]);
    expect(Math.abs(zcFrequency(y, RATE, RATE, 2 * RATE - 1000) - 440)).toBeLessThan(1.5);
  });

  it('Automatic Phase Correction lines up a late channel', async () => {
    const l = filter(gaussNoise(RATE * 3, 0.1, 3), biquad('lp', 4000, 0.7));
    const r = new Float32Array(l.length);
    r.set(l.subarray(0, l.length - 12), 12);
    const [yl, yr] = await runFx('autoPhaseCorrection', {}, [l, r]);
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = RATE; i < l.length; i++) {
      ab += yl[i] * yr[i];
      aa += yl[i] ** 2;
      bb += yr[i] ** 2;
    }
    expect(ab / Math.sqrt(aa * bb)).toBeGreaterThan(0.95);
  });

  it('Doppler Shifter sweeps the pitch down as the source passes', async () => {
    const x = sine(RATE * 4, 1000, RATE, 0.3);
    const [y] = await runFx('dopplerShifter', {}, [x, x.slice()]);
    const f = (a) => zcFrequency(y, RATE, a, a + 4800);
    expect(f(2400)).toBeGreaterThan(1030);
    expect(f(RATE * 4 - 7200)).toBeLessThan(970);
  });

  it('Center Channel Extractor keeps the centre and pulls the sides well down', async () => {
    const c = sine(RATE * 2, 440, RATE, 0.2);
    const sd = sine(RATE * 2, 1000, RATE, 0.2);
    const l = c.map((a, i) => a + sd[i]);
    const r = c.map((a, i) => a - sd[i]);
    const [yl] = await runFx('centerChannelExtractor', {}, [l, r]);
    const level = (s, f) => dbOf(rms(band(s, f * 0.9, f * 1.1), RATE / 2));
    expect(Math.abs(level(yl, 440) - level(l, 440))).toBeLessThan(1);
    expect(level(l, 1000) - level(yl, 1000)).toBeGreaterThan(15);
  });
});

describe('Normalize defaults', () => {
  it('bring the peak to -1 dBFS', async () => {
    const x = sine(4800, 440, RATE, 0.1);
    const [y] = await runFx('normalize', {}, [x]);
    expect(dbOf(peak(y))).toBeCloseTo(-1, 3);
  });

  it('a saved full-scale preset still normalizes to 100 %', async () => {
    const x = sine(4800, 440, RATE, 0.1);
    const [y] = await runFx('normalize', { unit: 1, targetPercent: 100 }, [x]);
    expect(peak(y)).toBeCloseTo(1, 4);
  });
});

describe('Delete Silence defaults', () => {
  it('shorten pauses in speech to about 0.3 s instead of removing them', async () => {
    const sp = speech({ seconds: 8, pause: 1.2 });
    const [y] = await runFx('deleteSilence', {}, [sp.x]);
    // Quiet runs (under -50 dBFS) longer than 50 ms in the result.
    const gaps = [];
    let s = -1;
    for (let i = 0; i <= y.length; i++) {
      const q = i < y.length && Math.abs(y[i]) < 10 ** (-50 / 20);
      if (q && s < 0) s = i;
      if (!q && s >= 0) {
        if (i - s > RATE * 0.05) gaps.push((i - s) / RATE);
        s = -1;
      }
    }
    const long = sp.pauses.filter(([a, b]) => b - a > RATE).length;
    expect(gaps.filter((g) => g > 0.25 && g < 0.4)).toHaveLength(long);
    expect(y.length).toBeLessThan(sp.x.length - long * 0.8 * RATE);
  });
});

describe('Hard Limiter: Maximize to Ceiling', () => {
  const music = () => {
    // Quiet chords with a few louder hits: peak about -20 dBFS.
    const n = RATE * 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      x[i] = 0.03 * (Math.sin(2 * Math.PI * 220 * t) + 0.7 * Math.sin(2 * Math.PI * 330 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t));
      if (i % 24000 < 600) x[i] += 0.04 * Math.sin(2 * Math.PI * 1500 * t);
    }
    return x;
  };
  const render = async (values, x, range = null) => {
    const def = getEffect('hardLimiter');
    const state = { sampleRate: RATE, channels: [Channel.fromSamples(x), Channel.fromSamples(x)] };
    const spec = slotSpec(def, normalizeValues(def, values), { state, range, rate: RATE });
    return (await dsp()).runEffect(def.kind, RATE, [x, x], spec.params);
  };

  it('at the defaults leaves quiet material unchanged (no boost)', async () => {
    const x = music();
    const [y] = await render({}, x);
    expect(peak(y)).toBeCloseTo(peak(x), 4);
  });

  it('raises quiet material so its peak meets the ceiling, and never above it', async () => {
    const x = music();
    expect(dbOf(peak(x))).toBeLessThan(-12);
    const [y] = await render({ maximize: true, ceiling: -1 }, x);
    expect(dbOf(peak(y))).toBeGreaterThan(-1.3);
    expect(dbOf(peak(y))).toBeLessThanOrEqual(-1 + 1e-3);
    // Input Boost adds drive on top: louder, still under the ceiling.
    const [z] = await render({ maximize: true, ceiling: -1, inputBoost: 6 }, x);
    expect(rms(z)).toBeGreaterThan(rms(y) * 1.5);
    expect(dbOf(peak(z))).toBeLessThanOrEqual(-1 + 1e-3);
  });

  it('measures the range being processed', async () => {
    const x = music();
    const half = x.slice();
    for (let i = RATE; i < half.length; i++) half[i] *= 4; // second second 12 dB louder
    const def = getEffect('hardLimiter');
    const state = { sampleRate: RATE, channels: [Channel.fromSamples(half)] };
    const boost = (range) => slotSpec(def, normalizeValues(def, { maximize: true, ceiling: -1 }), { state, range }).params[1];
    expect(boost([0, RATE]) - boost([RATE, 2 * RATE])).toBeCloseTo(20 * Math.log10(4), 1);
    // Without a range: the document's selection, else the whole file.
    const doc = { state, selection: { start: 0, end: RATE } };
    expect(slotSpec(def, normalizeValues(def, { maximize: true, ceiling: -1 }), { doc }).params[1]).toBeCloseTo(boost([0, RATE]), 4);
    expect(boost(null)).toBeCloseTo(boost([RATE, 2 * RATE]), 4);
  });
});

describe('DeHummer Auto', () => {
  /** Hum at f0 with decaying harmonics, at `db` dBFS for the fundamental. */
  const hum = (n, f0, db = -40, harmonics = 5, rate = RATE) => {
    const x = new Float32Array(n);
    const a = 10 ** (db / 20);
    for (let h = 1; h <= harmonics; h++) for (let i = 0; i < n; i++) x[i] += (a / h) * Math.sin((2 * Math.PI * f0 * h * i) / rate + h);
    return x;
  };
  const withSpeech = (f0, db = -40) => {
    const sp = speech({ seconds: 6 });
    const hm = hum(sp.x.length, f0, db);
    return { sp, hm, x: sp.x.map((v, i) => v + hm[i]) };
  };

  for (const f0 of [50, 60, 59.8, 50.2]) {
    it(`finds a ${f0} Hz hum under speech`, () => {
      const { x } = withSpeech(f0);
      const r = detectHum([x], RATE);
      expect(r).not.toBeNull();
      expect(Math.abs(r.frequency - f0)).toBeLessThan(0.15);
    });
  }

  it('finds hum whose fundamental is weaker than its harmonics', () => {
    const n = RATE * 4;
    const x = hum(n, 50, -60, 1);
    const h2 = hum(n, 100, -38, 3);
    const r = detectHum([x.map((v, i) => v + h2[i] + 0.002 * Math.sin(i))], RATE);
    expect(Math.abs(r.frequency - 50)).toBeLessThan(0.15);
  });

  it('reports nothing on speech or noise without hum', () => {
    expect(detectHum([speech({ seconds: 6 }).x], RATE)).toBeNull();
    expect(detectHum([gaussNoise(RATE * 4, 0.05, 9)], RATE)).toBeNull();
  });

  it('is the default and removes 50 Hz hum that a fixed 60 Hz setting misses', async () => {
    const def = getEffect('dehummer');
    expect(normalizeValues(def, {}).auto).toBe(true);
    const { sp, hm, x } = withSpeech(50);
    const state = { sampleRate: RATE, channels: [Channel.fromSamples(x)] };
    const run = async (values) => {
      const spec = slotSpec(def, normalizeValues(def, values), { state, range: [0, x.length] });
      return (await dsp()).runEffect(def.kind, RATE, [x], spec.params)[0];
    };
    const residual = (y) => dbOf(segRms(y.map((v, i) => v - sp.x[i]), sp.pauses.slice(1)));
    const before = residual(x);
    expect(before - residual(await run({}))).toBeGreaterThan(15);
    expect(before - residual(await run({ auto: false, frequency: 60 }))).toBeLessThan(3);
    expect(dbOf(segRms(hm, sp.pauses.slice(1)))).toBeCloseTo(before, 0);
  });

  it('settings saved before Auto existed keep their fixed frequency', () => {
    const def = getEffect('dehummer');
    expect(normalizeValues(def, { frequency: 50, q: 30, gain: -40, harmonics: 6, slope: 75, humOnly: false }).auto).toBe(false);
    expect(normalizeValues(def, def.presets.find((p) => p.name === 'Mains 50 Hz').values).auto).toBe(false);
  });

  it('on multitrack track and clip chains, finds the hum in the audio the clips play', () => {
    const { x } = withSpeech(50.2);
    const state = createSessionState({ sampleRate: RATE, tracks: 2 });
    const [t1, t2] = state.tracks;
    const slot = { id: 'dh', effect: 'dehummer', values: {}, enabled: true };
    // Track 1: the effect on the track; its short clip is clean, its long clip hums.
    const quiet = createClip({ trackId: t1.id, sourceId: 'clean', start: 0, length: RATE });
    const humming = createClip({ trackId: t1.id, sourceId: 'hum', start: RATE, length: x.length });
    // Track 2: the effect on a clip that plays the humming source from 1 s in.
    const clip = createClip({ trackId: t2.id, sourceId: 'hum', start: 0, offset: RATE, length: x.length - RATE, fx: [slot] });
    const tracks = state.tracks.map((t) => (t.id === t1.id ? { ...t, fx: [slot], fxPower: true } : t));
    const pool = new Map([
      ['clean', { channels: [Channel.fromSamples(speech({ seconds: 1 }).x)], channelRate: RATE }],
      ['hum', { channels: [Channel.fromSamples(x)], channelRate: RATE }],
    ]);
    const { graph } = buildSessionGraph({ ...state, tracks, clips: [quiet, humming, clip] }, pool);
    const freqOf = (spec) => spec.params[getEffect('dehummer').params.findIndex((p) => p.id === 'frequency')];
    const trackSpec = graph.tracks[0].fx.find((s) => s.key === `trk:${t1.id}:dh`);
    expect(Math.abs(freqOf(trackSpec) - 50.2)).toBeLessThan(0.15);
    const clipSpec = graph.tracks[1].clips[0].fx.find((s) => s.key === `clip:${clip.id}:dh`);
    expect(Math.abs(freqOf(clipSpec) - 50.2)).toBeLessThan(0.15);
    // A fixed frequency stays as set.
    const fixed = { ...slot, values: { auto: false, frequency: 60 } };
    const g2 = buildSessionGraph({ ...state, tracks: tracks.map((t) => ({ ...t, fx: [fixed] })), clips: [humming] }, pool).graph;
    expect(freqOf(g2.tracks[0].fx.find((s) => s.key === `trk:${t1.id}:dh`))).toBe(60);
  });
});
