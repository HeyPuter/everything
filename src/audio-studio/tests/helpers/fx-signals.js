// Synthesized test material and measurements for effect accuracy tests:
// voice-like speech (vowels, sibilants, pauses), noise, tones, and band,
// tone and envelope measurements. Deterministic; nothing is loaded from disk.

import { dsp } from '../../src/audio/dsp.js';
import { getEffect, defaults, paramArray } from '../../src/effects/index.js';

export const RATE = 48000;

/** Deterministic uniform noise in [-amp, amp]. */
export function noise(n, amp = 0.1, seed = 1) {
  const out = new Float32Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 2 ** 32 - 0.5) * 2 * amp;
  }
  return out;
}

/** Deterministic Gaussian-ish noise of RMS `rms` (sum of four uniforms). */
export function gaussNoise(n, rms = 0.1, seed = 1) {
  const out = new Float32Array(n);
  let s = seed >>> 0 || 1;
  const u = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
  // Four uniforms in [-0.5, 0.5] have variance 4/12.
  const k = rms / Math.sqrt(4 / 12);
  for (let i = 0; i < n; i++) out[i] = (u() + u() + u() + u()) * k;
  return out;
}

export function sine(n, f, rate = RATE, amp = 0.5, phase = 0) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * f * i) / rate + phase);
  return out;
}

/** RBJ biquad coefficients. */
export function biquad(type, f, q, rate = RATE, gainDb = 0) {
  const w = (2 * Math.PI * f) / rate;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  const A = 10 ** (gainDb / 40);
  let b;
  let a;
  if (type === 'lp') [b, a] = [[(1 - cs) / 2, 1 - cs, (1 - cs) / 2], [1 + al, -2 * cs, 1 - al]];
  else if (type === 'hp') [b, a] = [[(1 + cs) / 2, -(1 + cs), (1 + cs) / 2], [1 + al, -2 * cs, 1 - al]];
  else if (type === 'bp') [b, a] = [[al, 0, -al], [1 + al, -2 * cs, 1 - al]];
  else if (type === 'peak') [b, a] = [[1 + al * A, -2 * cs, 1 - al * A], [1 + al / A, -2 * cs, 1 - al / A]];
  else throw new Error(type);
  return { b0: b[0] / a[0], b1: b[1] / a[0], b2: b[2] / a[0], a1: a[1] / a[0], a2: a[2] / a[0] };
}

/** Filters x through the biquads in series (a new array). */
export function filter(x, ...stages) {
  let y = Float32Array.from(x);
  for (const c of stages) {
    let [x1, x2, y1, y2] = [0, 0, 0, 0];
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      const o = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = o;
      y[i] = o;
    }
  }
  return y;
}

/** x restricted to [lo, hi] Hz (4th-order high-pass and low-pass). */
export function band(x, lo, hi, rate = RATE) {
  const st = [];
  if (lo > 0) st.push(biquad('hp', lo, 0.541, rate), biquad('hp', lo, 1.307, rate));
  if (hi < rate / 2) st.push(biquad('lp', hi, 0.541, rate), biquad('lp', hi, 1.307, rate));
  return filter(x, ...st);
}

export function rms(x, from = 0, to = x.length) {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return Math.sqrt(e / Math.max(1, to - from));
}

export const dbOf = (v) => 20 * Math.log10(Math.max(1e-12, v));

export function peak(x, from = 0, to = x.length) {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

/** RMS over a list of [from, to) segments. */
export function segRms(x, segs) {
  let e = 0;
  let n = 0;
  for (const [a, b] of segs) {
    for (let i = a; i < b; i++) e += x[i] * x[i];
    n += b - a;
  }
  return Math.sqrt(e / Math.max(1, n));
}

/** Amplitude and phase of frequency f in x[from, to) by correlation (Hann windowed). */
export function tone(x, f, rate = RATE, from = 0, to = x.length) {
  let re = 0;
  let im = 0;
  let wsum = 0;
  const n = to - from;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    const ph = (2 * Math.PI * f * (from + i)) / rate;
    re += x[from + i] * w * Math.cos(ph);
    im += x[from + i] * w * Math.sin(ph);
    wsum += w;
  }
  return { amp: (2 * Math.hypot(re, im)) / wsum, phase: Math.atan2(im, re) };
}

/** Gain in dB of y relative to x at frequency f (steady-state window). */
export function gainAt(x, y, f, rate = RATE, from = 0, to = x.length) {
  return dbOf(tone(y, f, rate, from, to).amp) - dbOf(tone(x, f, rate, from, to).amp);
}

/** Zero-crossing based frequency estimate over [from, to). */
export function zcFrequency(x, rate = RATE, from = 0, to = x.length) {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = from + 1; i < to; i++) {
    if (x[i - 1] <= 0 && x[i] > 0) {
      const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first < 0) first = t;
      else count++;
      last = t;
    }
  }
  return count > 0 ? (count * rate) / (last - first) : 0;
}

/**
 * Voice-like speech: phrases of vowels (a glottal pulse train with formant
 * resonances and a slight pitch drift), sibilant bursts (noise in 4.5..10
 * kHz) and pauses. Returns the mono signal and the segment lists.
 *   vowelDb: RMS of the vowels (dBFS); sibilantDb: RMS of the sibilants.
 */
export function speech({ rate = RATE, seconds = 6, vowelDb = -18, sibilantDb = -26, pause = 0.5, seed = 3 } = {}) {
  const n = Math.round(rate * seconds);
  const x = new Float32Array(n);
  const vowels = [];
  const sibilants = [];
  const pauses = [];
  // A repeating pattern: vowel, sibilant, vowel, pause.
  const pattern = [
    ['v', 0.32],
    ['s', 0.14],
    ['v', 0.28],
    ['p', pause],
  ];
  const formants = [
    [[700, 1200, 2600], [90, 110, 160]],
    [[400, 2000, 2800], [70, 120, 170]],
    [[500, 900, 2400], [80, 100, 150]],
  ];
  let at = Math.round(0.2 * rate);
  pauses.push([0, at]);
  let k = 0;
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  while (at < n) {
    const [type, dur] = pattern[k % pattern.length];
    const len = Math.min(n - at, Math.round(dur * rate));
    if (len <= 0) break;
    if (type === 'v') {
      const [fs, bws] = formants[k % formants.length];
      const src = new Float32Array(len);
      let ph = 0;
      const f0 = 110 + 25 * rnd();
      for (let i = 0; i < len; i++) {
        const f = f0 * (1 + 0.06 * Math.sin((2 * Math.PI * i) / len));
        ph += f / rate;
        if (ph >= 1) {
          ph -= 1;
          src[i] = 1;
        }
      }
      // Glottal tilt: two one-pole low-passes.
      let y = filter(src, biquad('lp', 600, 0.6, rate));
      const res = fs.map((f, j) => filter(y, biquad('bp', f, f / bws[j], rate)));
      y = new Float32Array(len);
      for (let i = 0; i < len; i++) y[i] = res[0][i] + 0.6 * res[1][i] + 0.3 * res[2][i];
      shape(y, 0.03 * rate);
      scaleTo(y, 10 ** (vowelDb / 20));
      x.set(y, at);
      vowels.push([at + Math.round(0.04 * rate), at + len - Math.round(0.04 * rate)]);
    } else if (type === 's') {
      const y = band(noise(len, 1, seed + k), 4500, 10000, rate);
      shape(y, 0.02 * rate);
      scaleTo(y, 10 ** (sibilantDb / 20));
      x.set(y, at);
      sibilants.push([at + Math.round(0.025 * rate), at + len - Math.round(0.025 * rate)]);
    } else {
      pauses.push([at, at + len]);
    }
    at += len;
    k++;
  }
  return { x, vowels, sibilants, pauses };
}

/** Raised-cosine fade in and out over `fade` frames, in place. */
function shape(y, fade) {
  const f = Math.max(1, Math.round(fade));
  for (let i = 0; i < f && i < y.length; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / f);
    y[i] *= g;
    y[y.length - 1 - i] *= g;
  }
}

function scaleTo(y, target) {
  const r = rms(y, Math.floor(y.length * 0.2), Math.floor(y.length * 0.8));
  const g = r > 0 ? target / r : 0;
  for (let i = 0; i < y.length; i++) y[i] *= g;
}

/**
 * Runs effect `id` over `channels` offline (latency compensated) with its
 * defaults overridden by `values`. Realtime effects go through the WASM
 * processor; offline ones through their `run`.
 */
export async function runFx(id, values = {}, channels, { rate = RATE, extra = {}, data = null, tail = 0 } = {}) {
  const def = getEffect(id);
  const all = { ...defaults(def), ...values };
  const d = await dsp();
  if (def.run) {
    const out = await def.run({ channels, rate, values: all, extra, dsp: d });
    return Array.isArray(out) ? out : out;
  }
  const spec = data || (def.data ? def.data(all, { rate, doc: extra.doc || null }) : []);
  return d.runEffect(def.kind, rate, channels, paramArray(def, all), { data: spec || [], tail });
}

/** In-place radix-2 FFT of re/im (length a power of two). */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/**
 * Musical-noise measure of a residual over segments: mean(p^2) / mean(p)^2 of
 * the STFT bin powers in [lo, hi] Hz, each bin normalised by its own mean.
 * Steady noise (Rayleigh magnitudes) reads about 2; isolated tonal blips
 * that come and go (the "musical" residue of spectral gating) read higher.
 */
export function spectralPeakiness(x, segs, { n = 1024, lo = 500, hi = 8000, rate = RATE } = {}) {
  const k0 = Math.ceil((lo * n) / rate);
  const k1 = Math.floor((hi * n) / rate);
  const frames = [];
  for (const [a, b] of segs) {
    for (let at = a; at + n <= b; at += n / 2) {
      const re = new Float64Array(n);
      const im = new Float64Array(n);
      for (let i = 0; i < n; i++) re[i] = x[at + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
      fft(re, im);
      const p = new Float64Array(k1 - k0 + 1);
      for (let k = k0; k <= k1; k++) p[k - k0] = re[k] * re[k] + im[k] * im[k];
      frames.push(p);
    }
  }
  let ratio = 0;
  const bins = k1 - k0 + 1;
  for (let k = 0; k < bins; k++) {
    let m1 = 0;
    let m2 = 0;
    for (const p of frames) {
      m1 += p[k];
      m2 += p[k] * p[k];
    }
    m1 /= frames.length;
    m2 /= frames.length;
    ratio += m2 / Math.max(1e-30, m1 * m1);
  }
  return ratio / bins;
}
