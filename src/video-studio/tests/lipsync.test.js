import { describe, it, expect } from 'vitest';
import { analyzeVoice, emphasisBeats, encodeLips, normalizeLips, lipBytes, lipsDuration, mouthAt, talkLevel, LIP_RATE } from '../src/media/lipsync.js';

const SR = 16000;

/** A voiced sound: harmonics of f0 shaped by two formants. */
function vowel(seconds, { f0 = 140, F1 = 700, F2 = 1200, gain = 0.3 } = {}) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let k = 1; f0 * k < 7000; k++) {
    const f = f0 * k;
    const g = Math.exp(-(((f - F1) / 180) ** 2)) + 0.7 * Math.exp(-(((f - F2) / 250) ** 2)) + 0.02;
    for (let i = 0; i < n; i++) out[i] += g * Math.sin((2 * Math.PI * f * i) / SR);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] *= gain / peak;
  return out;
}

/** Hiss above 3 kHz (a sibilant), from a fixed pseudo-random sequence. */
function hiss(seconds, gain = 0.2) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let x = 1;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const w = x / 1073741824 - 1;
    out[i] = (w - prev) * gain; // first difference: tilts the noise toward high frequencies
    prev = w;
  }
  return out;
}

const silence = (seconds) => new Float32Array(Math.round(seconds * SR));

function concat(...parts) {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Mean of a curve over [a, b) seconds. */
const mean = (arr, a, b) => {
  let s = 0;
  const i0 = Math.round(a * LIP_RATE);
  const i1 = Math.round(b * LIP_RATE);
  for (let i = i0; i < i1; i++) s += arr[i];
  return s / (i1 - i0);
};

describe('voice analysis for lip sync', () => {
  it('keeps the mouth closed in silence and opens it for voiced sound', () => {
    const a = analyzeVoice(concat(silence(0.5), vowel(0.6), silence(0.6)), SR);
    expect(a.frames).toBe(Math.ceil(1.7 * LIP_RATE));
    expect(mean(a.open, 0, 0.4)).toBeLessThan(0.05);
    expect(mean(a.open, 0.65, 1.0)).toBeGreaterThan(0.5);
    expect(mean(a.open, 1.4, 1.7)).toBeLessThan(0.05);
  });

  it('tells bright vowels (wide lips) from dark ones (rounded lips)', () => {
    const a = analyzeVoice(concat(vowel(0.5, { F1: 300, F2: 2400 }), silence(0.3), vowel(0.5, { F1: 350, F2: 650 })), SR);
    expect(mean(a.wide, 0.15, 0.45)).toBeGreaterThan(mean(a.round, 0.15, 0.45));
    expect(mean(a.round, 0.95, 1.25)).toBeGreaterThan(mean(a.wide, 0.95, 1.25));
  });

  it('opens wider for open vowels than for close ones at the same level', () => {
    const a = analyzeVoice(concat(vowel(0.5, { F1: 800, F2: 1300 }), silence(0.3), vowel(0.5, { F1: 280, F2: 1300 })), SR);
    expect(mean(a.open, 0.15, 0.45)).toBeGreaterThan(mean(a.open, 0.95, 1.25));
  });

  it('marks hissing sounds and keeps the jaw nearly shut for them', () => {
    const a = analyzeVoice(concat(vowel(0.5), silence(0.2), hiss(0.4)), SR);
    expect(mean(a.fric, 0.85, 1.05)).toBeGreaterThan(0.5);
    expect(mean(a.fric, 0.1, 0.4)).toBeLessThan(0.1);
    expect(mean(a.open, 0.85, 1.05)).toBeLessThan(mean(a.open, 0.1, 0.4));
  });

  it('opens the lips a moment before the sound starts', () => {
    const a = analyzeVoice(concat(silence(0.5), vowel(0.5)), SR);
    const onset = Math.round(0.5 * LIP_RATE);
    expect(a.open[onset - 1]).toBeGreaterThan(0.1);
    expect(a.open[onset - 4]).toBeLessThan(0.05);
  });

  it('is repeatable and copes with empty input', () => {
    const x = concat(vowel(0.4), silence(0.2), hiss(0.2));
    expect(encodeLips(analyzeVoice(x, SR))).toEqual(encodeLips(analyzeVoice(x, SR)));
    const e = analyzeVoice(new Float32Array(0), SR);
    expect(e.frames).toBe(0);
    expect(e.beats).toEqual([]);
  });
});

describe('emphasis beats', () => {
  it('finds stressed peaks well above their surroundings, at least 1.2 s apart', () => {
    const loud = new Float32Array(10 * LIP_RATE).fill(0.4);
    for (const at of [2, 2.4, 6]) for (let i = -5; i <= 5; i++) loud[Math.round(at * LIP_RATE) + i] = 0.95;
    const beats = emphasisBeats(loud);
    expect(beats.length).toBe(2);
    expect(beats.map((b) => b / LIP_RATE)).toEqual([expect.closeTo(2, 0), expect.closeTo(6, 0)]);
  });

  it('ignores an evenly loud stretch', () => {
    expect(emphasisBeats(new Float32Array(500).fill(0.9))).toEqual([]);
  });
});

describe('stored lips', () => {
  const a = { rate: 50, frames: 4, open: [0, 1, 0.5, 0], wide: [0, 0.2, 0.4, 0], round: [0, 0, 1, 0], fric: [0, 0, 0, 1], beats: [1] };

  it('round-trips through the compact form', () => {
    const lips = normalizeLips(encodeLips(a));
    expect(lips.rate).toBe(50);
    expect(lips.beats).toEqual([1]);
    expect([...lipBytes(lips)]).toEqual([0, 0, 0, 0, 255, 51, 0, 0, 128, 102, 255, 0, 0, 0, 0, 255]);
    expect(lipsDuration(lips)).toBeCloseTo(0.08);
  });

  it('rejects malformed data and drops beats past the end', () => {
    expect(normalizeLips(null)).toBe(null);
    expect(normalizeLips({ rate: 50, data: 'not base64!' })).toBe(null);
    expect(normalizeLips({ rate: 5000, data: 'AAAA' })).toBe(null);
    expect(normalizeLips({ rate: 50, data: '' })).toBe(null);
    expect(normalizeLips({ ...encodeLips(a), beats: [3, 1, 1, 99, -1, 'x'] }).beats).toEqual([1, 3]);
  });

  it('samples the mouth between frames and rests outside the voice', () => {
    const lips = normalizeLips(encodeLips(a));
    // Frame 1 is centered at 30 ms.
    expect(mouthAt(lips, 0.03).open).toBeCloseTo(1, 2);
    expect(mouthAt(lips, 0.04).open).toBeCloseTo(0.75, 1);
    expect(mouthAt(lips, 0.05).round).toBeCloseTo(1, 2);
    expect(mouthAt(lips, -1)).toMatchObject({ open: 0, wide: 0, round: 0, fric: 0 });
    expect(mouthAt(lips, 5).open).toBe(0);
    expect(mouthAt(null, 0.03).open).toBe(0);
    expect(talkLevel(lips, 0.06)).toBeGreaterThan(0);
    expect(talkLevel(lips, -1)).toBe(0);
  });
});
