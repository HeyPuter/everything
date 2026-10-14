// Magnitude response of the Parametric EQ, computed from the same biquad
// designs the engine runs, so the graph shows what is heard. The designs are
// the RBJ "Audio EQ Cookbook" formulas:
//
//   low cut     2nd-order high pass, Q = 1/sqrt(2) (Butterworth)
//   low shelf   shelf slope S = 1 (Q = 1/sqrt(2)), gain low_gain at low_freq
//   band 1, 2   peaking (bell) filters with their own Q
//   high shelf  shelf slope S = 1, gain high_gain at high_freq
//   high cut    2nd-order low pass, Q = 1/sqrt(2)
//   output      flat gain after the chain
//
// Engine contract (keep both sides in step): the low cut at its minimum
// (20 Hz) and the high cut at its maximum (20 kHz) are bypassed; bands with
// 0 dB gain are exactly flat with these formulas; centre frequencies are
// clamped below 0.49 x the sample rate. The graph assumes 48 kHz.

export const EQ_SAMPLE_RATE = 48000;
export const BUTTERWORTH_Q = Math.SQRT1_2;
export const LOW_CUT_OFF = 20; // at or below: bypassed
export const HIGH_CUT_OFF = 20000; // at or above: bypassed

/**
 * Biquad coefficients { b0, b1, b2, a1, a2 } normalized by a0 for one of
 * 'peak' | 'lowshelf' | 'highshelf' | 'lowpass' | 'highpass'.
 */
export function biquad(type, freq, gainDb = 0, q = BUTTERWORTH_Q, fs = EQ_SAMPLE_RATE) {
  const f = Math.min(Math.max(freq, 1), fs * 0.49);
  const w0 = (2 * Math.PI * f) / fs;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const A = 10 ** (gainDb / 40);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  switch (type) {
    case 'peak': {
      const alpha = sin / (2 * q);
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    }
    case 'lowshelf':
    case 'highshelf': {
      const alpha = sin / (2 * q);
      const k = 2 * Math.sqrt(A) * alpha;
      if (type === 'lowshelf') {
        b0 = A * (A + 1 - (A - 1) * cos + k);
        b1 = 2 * A * (A - 1 - (A + 1) * cos);
        b2 = A * (A + 1 - (A - 1) * cos - k);
        a0 = A + 1 + (A - 1) * cos + k;
        a1 = -2 * (A - 1 + (A + 1) * cos);
        a2 = A + 1 + (A - 1) * cos - k;
      } else {
        b0 = A * (A + 1 + (A - 1) * cos + k);
        b1 = -2 * A * (A - 1 + (A + 1) * cos);
        b2 = A * (A + 1 + (A - 1) * cos - k);
        a0 = A + 1 - (A - 1) * cos + k;
        a1 = 2 * (A - 1 - (A + 1) * cos);
        a2 = A + 1 - (A - 1) * cos - k;
      }
      break;
    }
    case 'lowpass':
    case 'highpass': {
      const alpha = sin / (2 * q);
      const lp = type === 'lowpass';
      b0 = lp ? (1 - cos) / 2 : (1 + cos) / 2;
      b1 = lp ? 1 - cos : -(1 + cos);
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    default:
      return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** |H(f)| in dB of one biquad at frequency `f`. */
export function biquadDb(c, f, fs = EQ_SAMPLE_RATE) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
  const ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2;
  const di = -(c.a1 * s1 + c.a2 * s2);
  const mag2 = (nr * nr + ni * ni) / (dr * dr + di * di);
  return 10 * Math.log10(Math.max(mag2, 1e-30));
}

/** The EQ bands, in handle order, with the parameter ids they use. */
export const EQ_BANDS = [
  { key: 'hp', label: 'Low cut', type: 'highpass', freq: 'hp_freq' },
  { key: 'low', label: 'Low shelf', type: 'lowshelf', freq: 'low_freq', gain: 'low_gain' },
  { key: 'm1', label: 'Band 1', type: 'peak', freq: 'm1_freq', gain: 'm1_gain', q: 'm1_q' },
  { key: 'm2', label: 'Band 2', type: 'peak', freq: 'm2_freq', gain: 'm2_gain', q: 'm2_q' },
  { key: 'high', label: 'High shelf', type: 'highshelf', freq: 'high_freq', gain: 'high_gain' },
  { key: 'lp', label: 'High cut', type: 'lowpass', freq: 'lp_freq' },
];

/** Whether a band changes the sound at these parameters. */
export function bandActive(band, params) {
  if (band.key === 'hp') return params.hp_freq > LOW_CUT_OFF;
  if (band.key === 'lp') return params.lp_freq < HIGH_CUT_OFF;
  return Math.abs(params[band.gain] || 0) > 1e-6;
}

/** Coefficients of every active band for a parameter set. */
export function eqFilters(params, fs = EQ_SAMPLE_RATE) {
  const out = [];
  for (const b of EQ_BANDS) {
    if (!bandActive(b, params)) continue;
    const q = b.q ? params[b.q] : BUTTERWORTH_Q;
    out.push({ band: b.key, c: biquad(b.type, params[b.freq], b.gain ? params[b.gain] : 0, q, fs) });
  }
  return out;
}

/** Total response in dB at frequency `f` (including the output gain). */
export function eqResponseDb(params, f, filters = eqFilters(params)) {
  let db = params.output || 0;
  for (const x of filters) db += biquadDb(x.c, f);
  return db;
}

/**
 * Fills `out` (Float32Array) with the total response at `freqs`. Pass
 * precomputed filters to avoid recomputing them per point.
 */
export function eqCurve(params, freqs, out = new Float32Array(freqs.length), filters = eqFilters(params)) {
  for (let i = 0; i < freqs.length; i++) out[i] = eqResponseDb(params, freqs[i], filters);
  return out;
}

/** n log-spaced frequencies from lo to hi. */
export function logFreqs(n, lo = 20, hi = 20000) {
  const out = new Float32Array(n);
  const r = Math.log(hi / lo);
  for (let i = 0; i < n; i++) out[i] = lo * Math.exp((r * i) / (n - 1));
  return out;
}
