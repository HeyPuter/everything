// Spot healing a click marked on a zoomed-in spectral display: the stroke is narrower
// than the analysis column spacing, and must still be healed.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setDspBytes, dsp } from '../src/audio/dsp.js';
import { healSpectral } from '../src/spectral/process.js';
import { Channel } from '../src/audio/channel.js';

let d;
beforeAll(async () => {
  setDspBytes(fs.readFileSync(path.resolve(process.cwd(), 'src/audio/dsp.wasm')));
  d = await dsp();
});

const RATE = 44100;
const roughness = (x, a, b) => {
  let m = 0;
  for (let i = a + 2; i < b; i++) m = Math.max(m, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]));
  return m;
};

describe('healing clicks', () => {
  const x = Float32Array.from({ length: RATE }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 330 * i) / RATE));
  const at = 13230; // between analysis column centres
  for (let j = 0; j < 6; j++) x[at + j] += j % 2 ? -0.8 : 0.9;
  const state = { sampleRate: RATE, channels: [Channel.fromSamples(x)], markers: [] };
  const window = (s) => s.channels[0].toArray(at - 400, at + 400);

  it('heals a click under a narrow rectangle', () => {
    const sel = { channels: [true], shapes: [{ type: 'rect', t0: at - 20, t1: at + 30, f0: 0, f1: RATE / 2 }] };
    const out = healSpectral(state, sel, d);
    expect(roughness(window(out), 0, 800)).toBeLessThan(roughness(window(state), 0, 800) / 3);
  });

  it('heals a click under a brush stroke with dots between column centres', () => {
    const dots = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 20000].map((f) => [at + 3, f]);
    const sel = { channels: [true], shapes: [{ type: 'brush', log: true, rt: 120, rf: 0.7, opacity: 1, dots }] };
    const out = healSpectral(state, sel, d);
    expect(roughness(window(out), 0, 800)).toBeLessThan(roughness(window(state), 0, 800) / 3);
  });
});
