// Per-clip audio DSP: effects chain, time stretching and analysis.
import { describe, it, expect } from 'vitest';
import { ClipChain, createVoice, panGains, ChannelMode, Pan, Denoiser, Enhancer, PitchShifter, Biquad } from '../src/media/audio-fx.js';
import { WsolaStretcher, stretchBuffer, readLinear } from '../src/media/stretch.js';
import { integratedLoudness, noiseProfile, detectBeats, levelEnvelope, activeRegions, duckCurve, curveAt } from '../src/media/audio-analysis.js';
import { VOICE_PRESETS, NOISE_BANDS } from '../src/model/audio.js';

const SR = 48000;

const sine = (freq, seconds, amp = 0.5, sr = SR) => {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
};

function noise(n, amp, seed = 1) {
  let x = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = ((x / 4294967296) * 2 - 1) * amp;
  }
  return out;
}

const rms = (a, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

/** Frequency from upward zero crossings (good for clean tones). */
function freqOf(a, sr = SR, from = 0, to = a.length) {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = Math.max(1, from); i < to; i++) {
    if (a[i - 1] < 0 && a[i] >= 0) {
      const t = i - 1 + a[i - 1] / (a[i - 1] - a[i]);
      if (first < 0) first = t;
      else count++;
      last = t;
    }
  }
  return count ? (count * sr) / (last - first) : 0;
}

/** Run a chain-like processor over stereo copies in blocks. */
function runBlocks(proc, L, R, block = 128) {
  for (let s = 0; s < L.length; s += block) {
    const n = Math.min(block, L.length - s);
    proc.process(L.subarray(s, s + n), R.subarray(s, s + n), n);
  }
}

describe('voice presets', () => {
  it.each(VOICE_PRESETS.map((p) => p.id))('%s produces finite sound of the right length', (id) => {
    const src = sine(220, 1, 0.4);
    const L = src.slice();
    const R = src.slice();
    const v = createVoice(id, null, SR);
    expect(v).toBeTruthy();
    runBlocks(v, L, R, 128);
    expect(L.length).toBe(src.length);
    expect(L.every(Number.isFinite) && R.every(Number.isFinite)).toBe(true);
    // Audible, not blown up.
    expect(rms(L, SR / 2)).toBeGreaterThan(0.01);
    expect(Math.max(...L.map(Math.abs))).toBeLessThan(4);
  });

  it('block size does not change the result', () => {
    const src = sine(300, 0.5, 0.4);
    const a = [src.slice(), src.slice()];
    const b = [src.slice(), src.slice()];
    runBlocks(createVoice('canyon', null, SR), a[0], a[1], 128);
    runBlocks(createVoice('canyon', null, SR), b[0], b[1], 1000);
    for (let i = 0; i < src.length; i += 97) expect(a[0][i]).toBeCloseTo(b[0][i], 5);
  });

  it('pitch shifting moves a tone without changing its length', () => {
    const src = sine(200, 1, 0.5);
    for (const [semis, want] of [[12, 400], [-12, 100], [7, 200 * 2 ** (7 / 12)]]) {
      const L = src.slice();
      const R = src.slice();
      runBlocks(new PitchShifter(SR, semis), L, R);
      expect(L.length).toBe(src.length);
      // Spectral peak of the second half (zero crossings get confused at the crossfades).
      expect(Math.abs(peakFreq(L.subarray(SR / 2), SR) - want) / want).toBeLessThan(0.04);
    }
  });
});

/** Strongest frequency by a coarse DFT scan (50..2000 Hz). */
function peakFreq(a, sr) {
  let best = 0;
  let bestF = 0;
  const n = Math.min(a.length, 16384);
  for (let f = 50; f <= 2000; f += 2) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * f) / sr;
    for (let i = 0; i < n; i++) {
      re += a[i] * Math.cos(w * i);
      im += a[i] * Math.sin(w * i);
    }
    const m = re * re + im * im;
    if (m > best) {
      best = m;
      bestF = f;
    }
  }
  return bestF;
}

describe('pan and channels', () => {
  it('pan gains: unity in the middle, far side silent at the extremes', () => {
    expect(panGains(0)).toEqual([1, 1]);
    const [l, r] = panGains(100);
    expect(l).toBeCloseTo(0, 6);
    expect(r).toBe(1);
    const [l2, r2] = panGains(-100);
    expect(l2).toBe(1);
    expect(r2).toBeCloseTo(0, 6);
    const [l3] = panGains(50);
    expect(l3).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('applies the pan to both channels', () => {
    const L = new Float32Array([1, 1]);
    const R = new Float32Array([1, 1]);
    new Pan(-50).process(L, R, 2);
    expect(L[0]).toBe(1);
    expect(R[0]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it.each([
    ['left', [1, 1]],
    ['right', [2, 2]],
    ['swap', [2, 1]],
    ['mono', [1.5, 1.5]],
  ])('channel mode %s', (mode, [l, r]) => {
    const L = new Float32Array([1, 1, 1]);
    const R = new Float32Array([2, 2, 2]);
    new ChannelMode(mode).process(L, R, 3);
    expect([L[1], R[1]]).toEqual([l, r]);
  });
});

describe('noise reduction', () => {
  it('lowers the noise floor and keeps the voice', () => {
    const n = SR * 3;
    const hiss = noise(n, 0.03);
    const tone = sine(440, 3, 0.3);
    // Tone only in the middle second; noise everywhere.
    const mix = new Float32Array(n);
    for (let i = 0; i < n; i++) mix[i] = hiss[i] + (i >= SR && i < 2 * SR ? tone[i] : 0);
    const profile = noiseProfile([mix], SR);
    expect(profile).toHaveLength(NOISE_BANDS);
    const L = mix.slice();
    const R = mix.slice();
    const d = new Denoiser(SR, { amount: 80, profile });
    runBlocks(d, L, R, 128);
    const lat = d.latency;
    // Quiet part (skip warm-up), compared at the same instants.
    const before = rms(mix, SR * 0.3, SR * 0.9);
    const after = rms(L, SR * 0.3 + lat, SR * 0.9 + lat);
    expect(20 * Math.log10(after / before)).toBeLessThan(-12);
    // The tone survives.
    const toneIn = rms(mix, SR * 1.2, SR * 1.8);
    const toneOut = rms(L, SR * 1.2 + lat, SR * 1.8 + lat);
    expect(20 * Math.log10(toneOut / toneIn)).toBeGreaterThan(-2);
  });

  it('works without a profile by tracking the floor', () => {
    const n = SR * 3;
    const mix = noise(n, 0.03, 7);
    const L = mix.slice();
    const R = mix.slice();
    runBlocks(new Denoiser(SR, { amount: 70 }), L, R, 512);
    expect(rms(L, SR * 2, SR * 3)).toBeLessThan(rms(mix, SR * 2, SR * 3) * 0.5);
    expect(L.every(Number.isFinite)).toBe(true);
  });
});

describe('voice enhancement', () => {
  it('evens out levels and stays finite', () => {
    const loud = sine(500, 0.5, 0.9);
    const quiet = sine(500, 0.5, 0.05);
    const src = new Float32Array(loud.length * 2);
    src.set(loud);
    src.set(quiet, loud.length);
    const L = src.slice();
    const R = src.slice();
    runBlocks(new Enhancer(SR, { amount: 100 }), L, R);
    expect(L.every(Number.isFinite)).toBe(true);
    const ratioIn = rms(src, 0.2 * SR, 0.45 * SR) / rms(src, 0.7 * SR, 0.95 * SR);
    const ratioOut = rms(L, 0.2 * SR, 0.45 * SR) / rms(L, 0.7 * SR, 0.95 * SR);
    expect(ratioOut).toBeLessThan(ratioIn * 0.7);
  });
});

describe('ClipChain', () => {
  it('is empty without settings and passes sound through', () => {
    const c = new ClipChain(null, SR);
    expect(c.empty).toBe(true);
    const L = new Float32Array([0.5]);
    const R = new Float32Array([0.25]);
    c.process(L, R, 1);
    expect([L[0], R[0]]).toEqual([0.5, 0.25]);
  });

  it('keeps stage state when only an amount changes and rebuilds on a new preset', () => {
    const c = new ClipChain({ enhance: { amount: 20 }, voice: { id: 'hall', params: { mix: 30, size: 50 } } }, SR);
    const enh = c.stages.enhance;
    const hall = c.stages.voice;
    c.update({ enhance: { amount: 80 }, voice: { id: 'hall', params: { mix: 30, size: 50 } } });
    expect(c.stages.enhance).toBe(enh);
    expect(c.stages.voice).toBe(hall);
    c.update({ enhance: { amount: 80 }, voice: { id: 'canyon', params: {} } });
    expect(c.stages.voice).not.toBe(hall);
    c.update({ denoise: { amount: 50, profile: null } });
    expect(c.latency).toBeGreaterThan(0);
    expect(c.stages.voice).toBeNull();
  });
});

describe('time stretching', () => {
  it.each([2, 0.5, 1.5, 0.8])('speed %s changes length but not pitch', (speed) => {
    const src = sine(330, 2, 0.5);
    const [out] = stretchBuffer([src], SR, speed);
    expect(out.length).toBe(Math.round(src.length / speed));
    const f = freqOf(out, SR, 2000, out.length - 2000);
    expect(Math.abs(f - 330) / 330).toBeLessThan(0.02);
    // No big level holes from the overlap-add.
    const r = rms(out, 2000, out.length - 2000);
    expect(r).toBeGreaterThan(0.3);
    expect(r).toBeLessThan(0.42);
  });

  it('streams in chunks with the same result as one call', () => {
    const src = sine(250, 1, 0.5);
    const read = (ch, pos, step, count, out) => readLinear(src, src.length, pos, step, count, out);
    const a = new WsolaStretcher(SR).generate(0, 20000, (g) => g * 1.7, 1, read, 1)[0];
    const st = new WsolaStretcher(SR);
    const parts = [];
    for (let g = 0; g < 20000; g += 3001) parts.push(st.generate(g, Math.min(3001, 20000 - g), (x) => x * 1.7, 1, read, 1)[0]);
    const b = new Float32Array(20000);
    let at = 0;
    for (const p of parts) {
      b.set(p, at);
      at += p.length;
    }
    for (let i = 0; i < 20000; i += 37) expect(b[i]).toBeCloseTo(a[i], 5);
  });

  it.each([2, 1.5, 0.75, 0.5])('speed %s keeps the sound where the speed puts it', (speed) => {
    // Clicks at many points of the grain cycle: the sound around each lands at its time / speed.
    const clicks = Array.from({ length: 12 }, (_, k) => Math.round((0.3 + k * 0.53) * SR));
    const src = new Float32Array(7 * SR);
    for (const c of clicks) for (let i = 0; i < 48; i++) src[c + i] = 0.8 * Math.sin((Math.PI * i) / 48);
    const [out] = stretchBuffer([src], SR, speed);
    let off = 0;
    for (const c of clicks) {
      const at = (c + 24) / speed;
      let sum = 0;
      let weighted = 0;
      for (let i = Math.round(at - 0.06 * SR); i < at + 0.1 * SR; i++) {
        sum += out[i] ** 2;
        weighted += out[i] ** 2 * (i - at);
      }
      off += weighted / sum / SR / clicks.length;
    }
    // Anchoring grains by their start put it 7 to 26 ms off.
    expect(Math.abs(off)).toBeLessThan(0.0065);
  });

  it('speed 1 reproduces the source', () => {
    const src = sine(440, 0.5, 0.5);
    const [out] = stretchBuffer([src], SR, 1);
    for (let i = 2000; i < src.length - 2000; i += 101) expect(out[i]).toBeCloseTo(src[i], 4);
  });
});

describe('loudness', () => {
  it('reads a -20 dBFS 1 kHz tone as about -23 LUFS', () => {
    const tone = sine(997, 5, 0.1);
    expect(integratedLoudness([tone], SR)).toBeCloseTo(-23, 0);
    // Same tone on two channels is 3 dB louder.
    expect(integratedLoudness([tone, tone], SR)).toBeCloseTo(-20, 0);
  });

  it('works at other rates and gates out silence', () => {
    const sr = 44100;
    const tone = sine(997, 3, 0.1, sr);
    const padded = new Float32Array(tone.length * 2);
    padded.set(tone, tone.length);
    expect(integratedLoudness([padded], sr)).toBeCloseTo(-23, 0);
    expect(integratedLoudness([new Float32Array(sr)], sr)).toBeNull();
  });

  it('K-weighting boosts highs and cuts lows', () => {
    const lo = integratedLoudness([sine(40, 3, 0.1)], SR);
    const hi = integratedLoudness([sine(4000, 3, 0.1)], SR);
    expect(lo).toBeLessThan(-23.5);
    expect(hi).toBeGreaterThan(-23);
  });
});

describe('beats', () => {
  it('finds the tempo and beats of a click track', () => {
    const sr = 22050;
    const n = sr * 12;
    const mono = noise(n, 0.002, 3);
    const bpm = 120;
    const period = (60 / bpm) * sr;
    for (let b = 0.25 * sr; b < n; b += period) {
      for (let i = 0; i < 400 && b + i < n; i++) mono[Math.round(b) + i] += Math.sin(i * 0.3) * Math.exp(-i / 80);
    }
    const r = detectBeats(mono, sr);
    expect(r).toBeTruthy();
    expect(r.bpm).toBeGreaterThan(115);
    expect(r.bpm).toBeLessThan(125);
    const gaps = r.beats.slice(1).map((t, i) => t - r.beats[i]);
    const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    expect(avg).toBeCloseTo(0.5, 1);
    // Beats land on the clicks (within 30 ms).
    for (const t of r.beats.slice(1, -1)) {
      const k = Math.round((t - 0.25) / 0.5);
      expect(Math.abs(t - (0.25 + k * 0.5))).toBeLessThan(0.03);
    }
  });
});

describe('ducking analysis', () => {
  it('finds where speech plays and builds a gain curve', () => {
    const sr = 8000;
    const mono = new Float32Array(sr * 6);
    mono.set(sine(300, 1.5, 0.3, sr), sr * 1);
    mono.set(sine(300, 1, 0.3, sr), sr * 4);
    const lv = levelEnvelope(mono, sr, 0.05);
    const regions = activeRegions(lv, 0.05);
    expect(regions).toHaveLength(2);
    expect(regions[0][0]).toBeCloseTo(1, 1);
    expect(regions[0][1]).toBeCloseTo(2.5, 1);
    const pts = duckCurve(regions, 6, 0.25);
    expect(curveAt(pts, 0.2)).toBe(1);
    expect(curveAt(pts, 1.5)).toBeCloseTo(0.25, 5);
    expect(curveAt(pts, 3.5)).toBe(1);
    expect(curveAt(pts, 4.5)).toBeCloseTo(0.25, 5);
    expect(curveAt(pts, 6)).toBe(1);
  });
});

describe('biquad', () => {
  it('low-pass passes lows and cuts highs', () => {
    const f = new Biquad(SR, 'lowpass', 1000);
    const lo = sine(100, 0.5);
    const hi = sine(8000, 0.5);
    f.run(lo, 0);
    f.reset();
    f.run(hi, 0);
    expect(rms(lo, SR / 4)).toBeGreaterThan(0.34);
    expect(rms(hi, SR / 4)).toBeLessThan(0.02);
  });
});
