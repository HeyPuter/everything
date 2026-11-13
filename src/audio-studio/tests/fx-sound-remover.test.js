// Learn Sound Model + Sound Remover (process): NMF bases learned from an
// example of a sound, then removed from a mix with the bases held fixed.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import { dsp } from '../src/audio/dsp.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { getEffect, defaults } from '../src/effects/index.js';
import { buildSoundModel, learnSoundModel, modelBases, removeSound, soundSettings, mixToMono, MAX_SOUND_SECONDS } from '../src/effects/defs/restoration.js';
import { installEffectCommands, applyEffectToDoc } from '../src/effects/commands.js';
import { installEffectsDsp } from '../src/features/effects-dsp.js';
import { EFFECT_GROUPS, effectMenuSpec } from '../src/ui/menus.js';
import { fakeApp } from './fx-helpers.js';

const RATE = 48000;
const def = getEffect('soundRemover');

const sine = (n, f, amp) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / RATE));
/** The sound to remove: 1.5 kHz + 4.5 kHz beeps, on and off every 0.1 s. */
function beeps(n, amp = 0.3) {
  const a = sine(n, 1500, amp);
  const b = sine(n, 4500, amp * 0.6);
  return a.map((v, i) => (Math.floor(i / 4800) % 2 === 0 ? v + b[i] : 0));
}
/** What to keep: a low tone. */
const tone = (n) => sine(n, 220, 0.3).map((v, i) => v + 0.1 * Math.sin((2 * Math.PI * 660 * i) / RATE));
const energy = (x, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return s;
};

describe('sound model', () => {
  it('maps settings to NMF sizes and iteration counts', () => {
    expect(soundSettings(defaults(def))).toEqual({ fft: 2048, k: 8, kFree: 16, learnIters: 100, removeIters: 40 });
    expect(soundSettings({ ...defaults(def), passes: 20, contentPasses: 150, fftSize: 8192, complexity: 3 })).toMatchObject({ fft: 8192, k: 3, learnIters: 60, removeIters: 150 });
    // Ranges as wide as the reference layout: up to 100 bases and 150 passes.
    expect(['complexity', 'passes', 'contentComplexity', 'contentPasses'].map((id) => def.params.find((p) => p.id === id).max)).toEqual([100, 150, 100, 150]);
  });

  it('keeps a capped mono example and its unit-sum bases', async () => {
    const d = await dsp();
    const x = beeps(RATE);
    const m = buildSoundModel(d, [x, x.map((v) => v * 0.5)], RATE, { ...defaults(def), complexity: 4 });
    expect(m.rate).toBe(RATE);
    expect(m.seconds).toBeCloseTo(1, 3);
    expect(m.samples[100]).toBeCloseTo(x[100] * 0.75, 5);
    expect(m.bases).toMatchObject({ fft: 2048, k: 4 });
    expect(m.bases.w).toHaveLength(4 * 1025);
    for (let k = 0; k < 4; k++) {
      let s = 0;
      for (let f = 0; f < 1025; f++) s += m.bases.w[k * 1025 + f];
      expect(s).toBeCloseTo(1, 2);
    }
    // Same settings reuse the stored bases; others relearn from the example.
    expect(modelBases(d, m, soundSettings({ ...defaults(def), complexity: 4 }), RATE)).toBe(m.bases.w);
    expect(modelBases(d, m, soundSettings({ ...defaults(def), complexity: 2 }), RATE)).toHaveLength(2 * 1025);
    expect(() => buildSoundModel(d, [new Float32Array(100)], RATE, defaults(def))).toThrow(/Select/);
    expect(mixToMono([Float32Array.of(1, 0), Float32Array.of(0, 1)])).toEqual(Float32Array.of(0.5, 0.5));
  });
});

describe('Sound Remover (process)', () => {
  it('removes the learned sound from a mix and keeps the rest', async () => {
    const d = await dsp();
    const model = buildSoundModel(d, [beeps(RATE / 2, 0.4)], RATE, { ...defaults(def), complexity: 6 });
    const n = RATE;
    const keep = tone(n);
    const sound = beeps(n);
    const mix = keep.map((v, i) => v + sound[i]);
    const [out] = await def.process({ channels: [mix], rate: RATE, values: { ...defaults(def), complexity: 6 }, doc: { soundModel: model } });
    const a = 4800;
    const b = n - 4800;
    let err = 0;
    for (let i = a; i < b; i++) err += (out[i] - keep[i]) ** 2;
    expect(err).toBeLessThan(energy(sound, a, b) * 0.02);
    expect(err).toBeLessThan(energy(keep, a, b) * 0.02);
  });

  it('removes more with Enhanced Suppression and greys its strength out while off', async () => {
    const d = await dsp();
    const model = buildSoundModel(d, [beeps(RATE / 2, 0.4)], RATE, { ...defaults(def), complexity: 6 });
    const n = RATE;
    const keep = tone(n);
    const sound = beeps(n);
    const mix = keep.map((v, i) => v + sound[i]);
    const err = async (extra) => {
      const [out] = await def.process({ channels: [mix], rate: RATE, values: { ...defaults(def), complexity: 6, sensitivity: 1, ...extra }, doc: { soundModel: model } });
      let e = 0;
      for (let i = 4800; i < n - 4800; i++) e += (out[i] - keep[i]) ** 2;
      return e;
    };
    expect(await err({ enhanced: true, suppression: 100 })).toBeLessThan(await err({}));
    const supp = def.params.find((p) => p.id === 'suppression');
    expect(supp.enabledIf({ enhanced: false })).toBe(false);
    expect(supp.enabledIf({ enhanced: true })).toBe(true);
  });

  it('joins chunks of long files seamlessly', async () => {
    const d = await dsp();
    const n = (1 << 19) + 30000;
    const x = tone(n);
    const w = new Float32Array(257); // a silent model: nothing is removed
    const values = { ...defaults(def), complexity: 1, passes: 1, contentComplexity: 2, fftSize: 512 };
    let last = 0;
    const [y] = await removeSound(d, [x], RATE, w, values, { onProgress: (f) => (last = f) });
    expect(last).toBe(1);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(y[i] - x[i]));
    expect(worst).toBeLessThan(1e-4);
  });

  it('takes a damaged (NaN or infinite) sample as silence instead of spreading it', async () => {
    const d = await dsp();
    const values = { ...defaults(def), complexity: 4 };
    const model = buildSoundModel(d, [beeps(RATE / 2, 0.4)], RATE, values);
    const sound = beeps(RATE);
    const mix = tone(RATE).map((v, i) => v + sound[i]);
    mix[10000] = NaN;
    mix[30000] = Infinity;
    const doc = { soundModel: model };
    const [out] = await def.process({ channels: [mix], rate: RATE, values, doc });
    expect(out.every(Number.isFinite)).toBe(true);
  });

  it('asks for a model first', async () => {
    await expect(def.process({ channels: [new Float32Array(4096)], rate: RATE, values: {}, doc: {} })).rejects.toThrow(/Learn a sound model/);
    const app = fakeApp();
    installEffectCommands(app);
    const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [Channel.fromSamples(tone(4800))] });
    app.active = doc;
    expect(await applyEffectToDoc(app, doc, def, defaults(def))).toBe(false);
    expect(app.notes.at(-1).m).toMatch(/Learn Sound Model/);
  });
});

describe('Learn Sound Model command', () => {
  it('sits before Sound Remover in the Restoration menu', () => {
    const ids = EFFECT_GROUPS.find((g) => g.label === 'Noise Reduction / Restoration').ids;
    expect(ids.indexOf('learnSoundModel')).toBe(ids.indexOf('soundRemover') - 1);
    const sub = effectMenuSpec(null).find((x) => x.label === 'Noise Reduction / Restoration').submenu;
    expect(sub).toContain('-');
    expect(sub).toContain('fx.learnSoundModel');
  });

  it('stores a model of the selection on the document, then Sound Remover uses it', async () => {
    const app = fakeApp();
    installEffectCommands(app);
    installEffectsDsp(app);
    const n = RATE;
    const sound = beeps(n);
    const keep = tone(n);
    const samples = new Float32Array(2 * n);
    samples.set(sound, 0);
    for (let i = 0; i < n; i++) samples[n + i] = sound[i] + keep[i];
    const doc = new AudioFile({ name: 'a.wav', sampleRate: RATE, channels: [Channel.fromSamples(samples)] });
    app.active = doc;
    doc.setSelection(0, n);
    await app.commands.run('fx.learnSoundModel');
    expect(doc.soundModel?.bases.k).toBe(8);
    expect(doc.soundModel.seconds).toBeCloseTo(1, 3);
    expect(app.notes.at(-1).m).toMatch(/Sound model learned from 1\.00 s/);
    doc.setSelection(n, 2 * n);
    expect(await applyEffectToDoc(app, doc, def, defaults(def))).toBe(true);
    const out = doc.state.channels[0].toArray(n + 4800, 2 * n - 4800);
    let err = 0;
    for (let i = 0; i < out.length; i++) err += (out[i] - keep[4800 + i]) ** 2;
    expect(err).toBeLessThan(energy(sound, 4800, n - 4800) * 0.05);
  });

  it('learns from at most MAX_SOUND_SECONDS in the effect worker path', async () => {
    const m = await learnSoundModel([beeps(RATE / 4)], RATE, { ...defaults(def), complexity: 2 });
    expect(m.bases.k).toBe(2);
    expect(MAX_SOUND_SECONDS).toBe(15);
  });
});
