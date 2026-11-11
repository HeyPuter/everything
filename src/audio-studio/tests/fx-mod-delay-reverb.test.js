// Delay, modulation and reverb effects: JS tails mirror the WASM processors,
// procedural impulses are well formed, and the reverbs ring after the input.
import { describe, it, expect } from 'vitest';
import { instance, testSignal } from './fx-wasm.js';
import { getEffect, defaults, slotSpec, effectTail } from '../src/effects/index.js';
import { IMPULSES, generateImpulse, impulseLength, MAX_IMPULSE_SECONDS } from '../src/effects/defs/reverb-impulses.js';
import { feedbackTail } from '../src/effects/defs/delay.js';

const RATE = 48000;
const IDS = ['delay', 'echo', 'analogDelay', 'chorus', 'flanger', 'phaser', 'chorusFlanger', 'studioReverb', 'reverb', 'fullReverb', 'convolutionReverb'];

function create(x, def, values, channels = 2) {
  const spec = slotSpec(def, values, { rate: RATE });
  const h = x.fx_new(def.kind, RATE, channels);
  for (const d of spec.data || []) {
    const ptr = x.mem_alloc(d.values.length * 4);
    new Float32Array(x.memory.buffer, ptr, d.values.length).set(d.values);
    x.fx_data(h, d.slot, ptr, d.values.length);
    x.mem_free(ptr, d.values.length * 4);
  }
  spec.params.forEach((v, i) => x.fx_set(h, i, v));
  return h;
}

describe('delay, modulation and reverb definitions', () => {
  const x = instance();

  for (const id of IDS) {
    it(`${id}: tail matches the processor for every preset`, () => {
      const def = getEffect(id);
      expect(def, id).toBeTruthy();
      for (const p of [{ name: 'defaults', values: {} }, ...def.presets]) {
        const values = { ...defaults(def), ...p.values };
        const h = create(x, def, values);
        const rust = x.fx_tail(h);
        const js = effectTail(def, values, RATE);
        // Float32 parameters on the WASM side can move a rounding by a frame.
        expect(Math.abs(rust - js), `${p.name}: ${rust} vs ${js}`).toBeLessThanOrEqual(Math.max(2, rust * 1e-5));
        x.fx_free(h);
      }
    });
  }

  it('feedback tail formula', () => {
    expect(feedbackTail(1000, 0, RATE)).toBe(1000);
    expect(feedbackTail(1000, 0.5, RATE)).toBe(11000);
    expect(feedbackTail(1000, 1, RATE)).toBe(30 * RATE);
  });

  it('reverbs keep sounding after the input stops', () => {
    for (const id of ['studioReverb', 'reverb', 'fullReverb', 'convolutionReverb', 'echo']) {
      const def = getEffect(id);
      const h = create(x, def, defaults(def));
      const n = RATE / 2;
      const buf = x.mem_alloc(2 * 128 * 4);
      const [l] = testSignal(RATE, 0.1);
      let after = 0;
      for (let at = 0; at < n; at += 128) {
        const v = new Float32Array(x.memory.buffer, buf, 256);
        v.fill(0);
        if (at < l.length) {
          v.set(l.subarray(at, at + 128), 0);
          v.set(l.subarray(at, at + 128), 128);
        }
        x.fx_process(h, buf, 128);
        const o = new Float32Array(x.memory.buffer, buf, 256);
        if (at > l.length + 2048) for (let i = 0; i < 256; i++) after = Math.max(after, Math.abs(o[i]));
      }
      expect(after, id).toBeGreaterThan(1e-3);
      x.mem_free(buf, 2 * 128 * 4);
      x.fx_free(h);
    }
  });
});

describe('procedural impulses', () => {
  it('builds every type deterministically with unit energy per channel', () => {
    IMPULSES.forEach((t, impulse) => {
      const v = { impulse, roomSize: 100, dampLF: 0, dampHF: 30 };
      const a = generateImpulse(v, RATE);
      const b = generateImpulse(v, RATE);
      expect(a[0]).toBe(2);
      const n = impulseLength(v, RATE);
      expect(a.length).toBe(1 + 2 * n);
      let same = true;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) same = false;
      expect(same, t.label).toBe(true);
      let e = 0;
      for (let i = 1; i < a.length; i++) e += a[i] * a[i];
      expect(e / 2).toBeCloseTo(1, 3);
      // Decays: the last 10 % is far quieter than the first 10 %.
      const ch = a.subarray(1, 1 + n);
      const rms = (s) => Math.sqrt(s.reduce((m, q) => m + q * q, 0) / s.length);
      expect(rms(ch.subarray(Math.floor(n * 0.9))), t.label).toBeLessThan(rms(ch.subarray(0, Math.floor(n * 0.1))) * 0.05);
    });
  });

  it('room size scales the length and caps it', () => {
    const short = impulseLength({ impulse: 2, roomSize: 50 }, RATE);
    const long = impulseLength({ impulse: 2, roomSize: 150 }, RATE);
    expect(long).toBeGreaterThan(short * 2);
    expect(impulseLength({ impulse: 4, roomSize: 400 }, RATE)).toBe(MAX_IMPULSE_SECONDS * RATE);
  });

  it('high frequency damping darkens the impulse', () => {
    const hf = (dampHF) => {
      const a = generateImpulse({ impulse: 2, roomSize: 100, dampLF: 0, dampHF }, RATE);
      let d = 0;
      let e = 0;
      for (let i = 2; i < a.length / 2; i++) {
        d += (a[i] - a[i - 1]) ** 2;
        e += a[i] * a[i];
      }
      return d / e;
    };
    expect(hf(90)).toBeLessThan(hf(0) * 0.8);
  });

  it('the convolution definition reuses cached impulses', () => {
    const def = getEffect('convolutionReverb');
    const v = defaults(def);
    const [a] = def.data(v, { rate: RATE });
    const [b] = def.data({ ...v, mix: 80, gain: -3 }, { rate: RATE });
    expect(b.id).toBe(a.id);
    expect(b.values).toBe(a.values);
    const [c] = def.data({ ...v, impulse: 5 }, { rate: RATE });
    expect(c.id).not.toBe(a.id);
  });
});
