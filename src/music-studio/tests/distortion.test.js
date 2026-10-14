// Distortion quality: the 4x oversampled shaper in engine.wasm keeps hard
// clipping and wavefolding of a high sine clean (little aliasing below the
// fundamental), finite and bounded.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Core, BLOCK } from '../src/engine/core.js';
import { compileMixer } from '../src/engine/compile.js';
import { createProject, createSlot } from '../src/model/project.js';
import { INSTRUMENT_TYPES } from '../src/instruments/catalog.js';

const RATE = 48000;
let module;

beforeAll(() => {
  module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
});

/** Energy of x in [lo, hi] Hz (Hann-windowed DFT bins). */
function bandEnergy(x, lo, hi) {
  const n = x.length;
  let e = 0;
  for (let k = Math.ceil((lo / RATE) * n); k <= Math.floor((hi / RATE) * n); k++) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) {
      const v = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
      re += v * Math.cos(w * i);
      im -= v * Math.sin(w * i);
    }
    e += re * re + im * im;
  }
  return e;
}

/**
 * Plays a 0.5-amplitude sine (an audio sample) into the master insert with
 * an optional distortion (`params`) and returns `frames` frames after `skip`.
 */
function render(audio, params, hz, frames, skip) {
  const core = new Core(new WebAssembly.Instance(module, {}), RATE);
  const p = createProject();
  const fx = [];
  if (params) {
    const slot = createSlot('distortion');
    slot.params = { ...slot.params, ...params };
    fx.push(slot);
  }
  p.mixer[0] = { ...p.mixer[0], volume: 1, fx };
  core.setMixer(compileMixer(p));
  const total = frames + skip;
  const sine = new Float32Array(total + BLOCK * 2);
  for (let i = 0; i < sine.length; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE);
  core.loadSample(0, [sine, sine], RATE);
  core.setChannel({ slot: 0, type: audio, params: [], volume: 1, pan: 0, pitch: 0, mixer: 0, gain: 1, sample: 0 });
  core.audioOn(0, 1, 0, 1, 0);
  const out = new Float32Array(total);
  for (let f = 0; f < total; f += BLOCK) out.set(core.process(BLOCK).l.subarray(0, Math.min(BLOCK, total - f)), f);
  return out.subarray(skip);
}

describe('distortion oversampling', () => {
  it('aliases far less than naive hard clipping and stays bounded', () => {
    const audio = INSTRUMENT_TYPES.indexOf('audio');
    const hz = 6750;
    const frames = 4096;
    const skip = 1024;
    const drive = 12;
    // The level that reaches the master insert (channel and master strips at unity or not).
    const clean = render(audio, null, hz, frames, skip);
    const amp = clean.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(amp).toBeGreaterThan(0.2);
    for (const [type, name] of [[1, 'hard'], [3, 'fold']]) {
      const y = render(audio, { type, drive, tone: 20000, output: 0, wet: 1 }, hz, frames, skip);
      expect(y.every((v) => Number.isFinite(v) && Math.abs(v) < 2), name).toBe(true);
      const fund = bandEnergy(y, hz - 50, hz + 50);
      expect(fund, name).toBeGreaterThan(1);
      if (type !== 1) continue;
      // The same signal hard clipped at the base rate.
      const g = 10 ** (drive / 20);
      const ref = Float32Array.from(clean, (v) => Math.max(-1, Math.min(1, v * g)));
      const aliasOs = bandEnergy(y, 50, hz - 300) / fund;
      const aliasNaive = bandEnergy(ref, 50, hz - 300) / bandEnergy(ref, hz - 50, hz + 50);
      // At least 15 dB less aliased energy below the fundamental, relative to it.
      expect(10 * Math.log10(aliasNaive / aliasOs)).toBeGreaterThan(15);
    }
  });
});
