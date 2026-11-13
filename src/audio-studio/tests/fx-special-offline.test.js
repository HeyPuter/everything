// Offline Special and Diagnostics processes: Doppler Shifter, Delete Silence
// and Mark Audio, plus the silence detection helpers they share.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import { getEffect, defaults } from '../src/effects/index.js';
import { findSilence, removeSilence, audioMarkers } from '../src/effects/defs/special-silence.js';

const RATE = 48000;

function tone(seconds, amp = 0.5, f = 440) {
  const n = Math.round(seconds * RATE);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / RATE);
  return x;
}

function concat(...parts) {
  const out = new Float32Array(parts.reduce((t, p) => t + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const silence = (seconds) => new Float32Array(Math.round(seconds * RATE));

/** Zero-crossing frequency estimate over [a, b). */
function freq(x, a, b) {
  let z = 0;
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) z++;
  return (z * RATE) / (b - a);
}

describe('silence detection helpers', () => {
  const win = 240;
  it('finds runs below the threshold that last long enough', () => {
    // 10 windows loud, 20 quiet, 3 loud blip, 20 quiet, 10 loud.
    const db = Float32Array.from([...Array(10).fill(-10), ...Array(20).fill(-80), ...Array(3).fill(-10), ...Array(20).fill(-80), ...Array(10).fill(-10)]);
    const len = db.length * win;
    const o = { silenceThreshold: -40, silenceMin: 50, audioThreshold: -36, audioMin: 20 };
    // The 15 ms blip is shorter than audioMin (20 ms), so it does not split the silence.
    expect(findSilence(db, win, RATE, len, o)).toEqual([[10 * win, 53 * win]]);
    // With a shorter audio minimum the blip counts as audio.
    expect(findSilence(db, win, RATE, len, { ...o, audioMin: 10 })).toEqual([
      [10 * win, 30 * win],
      [33 * win, 53 * win],
    ]);
  });

  it('removes silences but keeps the requested amount', () => {
    const ch = Float32Array.from({ length: 100 }, (_, i) => i);
    const [out] = removeSilence([ch], [[20, 60]], 10);
    expect(out.length).toBe(70);
    expect(out[24]).toBe(24);
    expect(out[25]).toBe(55);
  });

  it('turns gaps between silences into padded, merged markers', () => {
    const m = audioMarkers([[100, 200], [205, 400]], 1000, 10);
    expect(m.map((x) => [x.start, x.duration])).toEqual([
      [0, 110],
      [190, 25],
      [390, 610],
    ]);
    expect(m[0].name).toBe('Audio 01');
  });
});

describe('Delete Silence', () => {
  it('shortens long pauses to the keep length', async () => {
    const def = getEffect('deleteSilence');
    const x = concat(tone(0.5), silence(1), tone(0.5), silence(0.2), tone(0.5));
    const [out] = await def.process({ channels: [x, x.slice()], rate: RATE, values: { keep: 100 } });
    // The 1 s pause shrinks to about 100 ms; the 200 ms pause stays (under 500 ms).
    expect(out.length / RATE).toBeGreaterThan(1.75);
    expect(out.length / RATE).toBeLessThan(1.9);
  });
});

describe('Mark Audio', () => {
  it('returns the audio unchanged with one marker per region', async () => {
    const def = getEffect('markAudio');
    const x = concat(silence(0.3), tone(0.4), silence(0.6), tone(0.25), silence(0.5));
    const res = await def.process({ channels: [x], rate: RATE, values: { padding: 0, silenceMin: 200 } });
    expect(res.channels[0]).toBe(x);
    expect(res.markers.length).toBe(2);
    const [a, b] = res.markers;
    expect(Math.abs(a.start / RATE - 0.3)).toBeLessThan(0.03);
    expect(Math.abs(a.duration / RATE - 0.4)).toBeLessThan(0.05);
    expect(Math.abs(b.start / RATE - 1.3)).toBeLessThan(0.03);
    expect(b.name).toBe('Audio 02');
  });
});

describe('Doppler Shifter', () => {
  it('raises the pitch while approaching and lowers it while leaving', async () => {
    const def = getEffect('dopplerShifter');
    const x = tone(2, 0.5, 1000);
    const values = { ...defaults(def), startDistance: 40, velocity: 40, comingFrom: -90, passFront: 2, distanceVolume: false };
    const [l, r] = await def.process({ channels: [x, x], rate: RATE, values });
    expect(l.length).toBe(x.length);
    expect(freq(l, 4800, 33600)).toBeGreaterThan(1100);
    expect(freq(r, 62400, 91200)).toBeLessThan(920);
  });

  it('pans a circling source between the ears', async () => {
    const def = getEffect('dopplerShifter');
    const x = new Float32Array(RATE).fill(0.5);
    const values = { ...defaults(def), path: 1, radius: 3, velocity: 10, startAngle: 0, distanceVolume: false, quality: 1 };
    const [l, r] = await def.process({ channels: [x, x], rate: RATE, values });
    const q = Math.round(((0.25 * 2 * Math.PI * 3) / 10) * RATE);
    expect(r[q]).toBeGreaterThan(l[q] * 1.5);
  });

  it('reads a damaged (NaN or infinite) sample as silence instead of spreading it', async () => {
    const def = getEffect('dopplerShifter');
    const x = tone(1, 0.5, 1000);
    x[1000] = NaN;
    x[20000] = -Infinity;
    for (const quality of [0, 1, 2, 3]) {
      const [l, r] = await def.process({ channels: [x, x], rate: RATE, values: { quality } });
      expect(l.every(Number.isFinite) && r.every(Number.isFinite), `quality ${quality}`).toBe(true);
    }
  });
});

describe('Special realtime definitions', () => {
  it('report latency and tails consistently', () => {
    const m = getEffect('mastering');
    expect(m.latency(defaults(m), 48000)).toBe(23 + 240 - 1);
    expect(m.latency(defaults(m), 44100)).toBe(23 + 221 - 1);
    expect(m.tail({ ...defaults(m), reverb: 0 }, 48000)).toBe(0);
    expect(m.tail({ ...defaults(m), reverb: 30 }, 48000)).toBe(96000);
    const r = m.response({ ...defaults(m), peakFreq: 1000, peakGain: 6 }, [1000, 50, 15000], 48000);
    expect(r[0]).toBeCloseTo(6, 1);
    expect(Math.abs(r[1])).toBeLessThan(0.5);
  });
});
