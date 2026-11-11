/**
 * Offline audio analysis for the details panel: integrated loudness
 * (ITU-R BS.1770 style, K-weighted and gated), a noise profile from the
 * quietest frames, beat tracking and a level envelope for ducking.
 * Pure functions over Float32Array channels, plus decodeClipSound() which
 * pulls a clip's source range through the mixdown decoder.
 */
import { US } from '../lib/time.js';
import { Biquad, FFT, sqrtHann } from './audio-fx.js';
import { NOISE_BANDS, NOISE_BAND_EDGES, sourceRange } from '../model/audio.js';

/* ---- Loudness ----------------------------------------------------------------- */

/** The two K-weighting stages (head-related high shelf, then a ~38 Hz high-pass) for a sample rate. */
export function kWeighting(sr) {
  return [new Biquad(sr, 'highshelf', 1681.974450955533, 0.7071752369554196, 3.999843853973347), new Biquad(sr, 'highpass', 38.13547087602444, 0.5003270373238773)];
}

/**
 * Integrated loudness in LUFS of planar channels (all weighted 1, as for
 * mono/stereo). 400 ms blocks with 75% overlap, -70 LUFS absolute gate and
 * a relative gate 10 LU below the ungated mean. Returns null for silence.
 */
export function integratedLoudness(channels, sr) {
  const len = channels[0]?.length || 0;
  if (!len) return null;
  const weighted = channels.map((ch) => {
    const y = Float32Array.from(ch);
    for (const f of kWeighting(sr)) f.run(y, 0, len);
    return y;
  });
  const block = Math.round(0.4 * sr);
  const step = Math.round(0.1 * sr);
  const powers = [];
  // Running sums of squares per channel make each block O(1).
  const cums = weighted.map((y) => {
    const c = new Float64Array(len + 1);
    for (let i = 0; i < len; i++) c[i + 1] = c[i] + y[i] * y[i];
    return c;
  });
  const blockPower = (a, b) => cums.reduce((s, c) => s + (c[b] - c[a]) / (b - a), 0);
  if (len < block) powers.push(blockPower(0, len));
  else for (let a = 0; a + block <= len; a += step) powers.push(blockPower(a, a + block));
  const lufs = (p) => -0.691 + 10 * Math.log10(p);
  const abs = powers.filter((p) => p > 0 && lufs(p) > -70);
  if (!abs.length) return null;
  const mean = (arr) => arr.reduce((s, p) => s + p, 0) / arr.length;
  const rel = lufs(mean(abs)) - 10;
  const gated = abs.filter((p) => lufs(p) > rel);
  return lufs(mean(gated.length ? gated : abs));
}

/**
 * Loudness of a clip's sound as it plays in the project: the mix is stereo
 * and a mono source plays on both sides, which sounds 3 dB louder than the
 * mono channel measured alone. Normalization targets are met with this one.
 */
export function clipLoudness(channels, sr) {
  return integratedLoudness(channels.length === 1 ? [channels[0], channels[0]] : channels, sr);
}

/* ---- Noise profile -------------------------------------------------------------- */

/**
 * Noise level per band (dB of per-sample power, see audio-fx Denoiser),
 * averaged over the quietest 10% of 1024-point frames.
 */
export function noiseProfile(channels, sr, { fraction = 0.1 } = {}) {
  const N = 1024;
  const hop = N / 2;
  const len = channels[0]?.length || 0;
  const win = sqrtHann(N);
  let wp = 0;
  for (let i = 0; i < N; i++) wp += win[i] ** 2;
  const fft = new FFT(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const frames = [];
  for (let a = 0; a + N <= len || (a === 0 && len > 0); a += hop) {
    const spec = new Float64Array(N / 2 + 1);
    let energy = 0;
    for (const ch of channels) {
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < N && a + i < len; i++) re[i] = ch[a + i] * win[i];
      fft.transform(re, im);
      for (let k = 0; k <= N / 2; k++) {
        const p = (re[k] * re[k] + im[k] * im[k]) / wp / channels.length;
        spec[k] += p;
        energy += p;
      }
    }
    frames.push({ energy, spec });
    if (a + N > len) break;
  }
  if (!frames.length) return null;
  frames.sort((x, y) => x.energy - y.energy);
  const take = frames.slice(0, Math.max(3, Math.ceil(frames.length * fraction)));
  const sums = new Float64Array(NOISE_BANDS);
  const counts = new Float64Array(NOISE_BANDS);
  let b = 0;
  for (let k = 0; k <= N / 2; k++) {
    const f = (k * sr) / N;
    while (b < NOISE_BANDS - 1 && f >= NOISE_BAND_EDGES[b + 1]) b++;
    for (const fr of take) sums[b] += fr.spec[k];
    counts[b] += take.length;
  }
  const out = new Array(NOISE_BANDS).fill(null);
  for (let i = 0; i < NOISE_BANDS; i++) if (counts[i]) out[i] = Math.round(10 * Math.log10(sums[i] / counts[i] + 1e-20) * 10) / 10;
  // Narrow low bands may hold no FFT bin: borrow the nearest measured neighbor.
  for (let i = 0; i < NOISE_BANDS; i++) {
    if (out[i] !== null) continue;
    for (let j = 1; j < NOISE_BANDS; j++) {
      const v = counts[i + j] ? out[i + j] : counts[i - j] ? out[i - j] : null;
      if (v !== null) {
        out[i] = v;
        break;
      }
    }
    if (out[i] === null) out[i] = -120;
  }
  return out;
}

/* ---- Beats ------------------------------------------------------------------------- */

/**
 * Spectral-flux onset strength, one value per hop. Returns { env, rate
 * (frames per second), offset (seconds from a frame index to its center) }.
 */
export function onsetEnvelope(mono, sr) {
  const N = 1024;
  const hop = Math.max(64, Math.round(sr / 100));
  const fft = new FFT(N);
  const win = sqrtHann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const top = Math.min(N / 2, Math.round((8000 * N) / sr));
  let prev = new Float64Array(top);
  const env = [];
  for (let a = 0; a + N <= mono.length; a += hop) {
    for (let i = 0; i < N; i++) {
      re[i] = mono[a + i] * win[i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    const mag = new Float64Array(top);
    let flux = 0;
    for (let k = 1; k < top; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = mag[k] - prev[k];
      if (d > 0) flux += d;
    }
    prev = mag;
    env.push(flux);
  }
  // Remove the slowly varying part (local mean over ~0.5 s) and half-wave rectify.
  const rate = sr / hop;
  const w = Math.max(1, Math.round(rate * 0.25));
  const out = new Float64Array(env.length);
  let sum = 0;
  const cum = [0];
  for (const v of env) cum.push((sum += v));
  for (let i = 0; i < env.length; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(env.length, i + w + 1);
    out[i] = Math.max(0, env[i] - (cum[b] - cum[a]) / (b - a));
  }
  // Normalize to unit standard deviation.
  let sd = 0;
  for (const v of out) sd += v * v;
  sd = Math.sqrt(sd / Math.max(1, out.length)) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= sd;
  return { env: out, rate, offset: N / 2 / sr };
}

/** Tempo in beats per minute from the onset envelope's autocorrelation (60..180 BPM, prior near 115). */
export function estimateTempo(env, rate) {
  const minLag = Math.round((rate * 60) / 180);
  const maxLag = Math.round((rate * 60) / 60);
  let best = 0;
  let bestLag = 0;
  const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    scores[lag] = s / Math.max(1, env.length - lag);
  }
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * rate) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.9) ** 2);
    const s = scores[lag] * prior;
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  if (!bestLag) return null;
  // Parabolic refinement of the peak.
  const a = scores[bestLag - 1] || 0;
  const b = scores[bestLag];
  const c = scores[bestLag + 1] || 0;
  const den = a - 2 * b + c;
  const lag = den < 0 ? bestLag + (0.5 * (a - c)) / den : bestLag;
  return (60 * rate) / lag;
}

/**
 * Beat times (seconds) by dynamic programming over the onset envelope:
 * each beat rewards onset strength and penalizes spacing that strays from
 * the tempo period.
 */
export function trackBeats(env, rate, bpm, tightness = 100) {
  const period = (60 * rate) / bpm;
  const n = env.length;
  if (!n || !(period > 1)) return [];
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let best = 0;
    let arg = -1;
    const lo = Math.max(0, Math.round(i - 2 * period));
    const hi = Math.round(i - period / 2);
    for (let j = lo; j <= hi; j++) {
      const s = score[j] - tightness * Math.log((i - j) / period) ** 2;
      if (arg < 0 || s > best) {
        best = s;
        arg = j;
      }
    }
    score[i] = env[i] + (arg >= 0 ? Math.max(0, best) : 0);
    back[i] = arg >= 0 && best > 0 ? arg : -1;
  }
  // Start from the best score in the last period and walk back.
  let end = n - 1;
  for (let i = Math.max(0, Math.floor(n - period)); i < n; i++) if (score[i] > score[end]) end = i;
  const beats = [];
  for (let i = end; i >= 0; i = back[i]) {
    beats.push(i / rate);
    if (back[i] < 0) break;
  }
  return beats.reverse();
}

/** { bpm, beats: [seconds] } for mono audio, or null when nothing rhythmic is found. */
export function detectBeats(mono, sr) {
  const { env, rate, offset } = onsetEnvelope(mono, sr);
  if (env.length < rate * 2) return null;
  const bpm = estimateTempo(env, rate);
  if (!bpm) return null;
  const beats = trackBeats(env, rate, bpm).map((t) => t + offset);
  return beats.length >= 2 ? { bpm, beats } : null;
}

/* ---- Levels and ducking -------------------------------------------------------- */

/** RMS level in dB per hop (seconds) of mono audio. */
export function levelEnvelope(mono, sr, hopSec = 0.05) {
  const hop = Math.max(1, Math.round(sr * hopSec));
  const out = new Float32Array(Math.ceil(mono.length / hop));
  for (let b = 0; b < out.length; b++) {
    let s = 0;
    const a = b * hop;
    const e = Math.min(mono.length, a + hop);
    for (let i = a; i < e; i++) s += mono[i] * mono[i];
    out[b] = 10 * Math.log10(s / Math.max(1, e - a) + 1e-12);
  }
  return out;
}

/**
 * Regions (seconds) where a level envelope says something is playing:
 * above max(floorDb, loudest - rangeDb), with short gaps bridged and blips
 * dropped.
 */
export function activeRegions(levels, hopSec, { floorDb = -45, rangeDb = 28, bridge = 0.45, minLen = 0.15 } = {}) {
  let peak = -Infinity;
  for (const v of levels) if (v > peak) peak = v;
  const thr = Math.max(floorDb, peak - rangeDb);
  const regions = [];
  let start = -1;
  for (let i = 0; i <= levels.length; i++) {
    const on = i < levels.length && levels[i] > thr;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      regions.push([start * hopSec, i * hopSec]);
      start = -1;
    }
  }
  const merged = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < bridge) last[1] = r[1];
    else merged.push([...r]);
  }
  return merged.filter((r) => r[1] - r[0] >= minLen);
}

/**
 * Ducking gain curve as points [{ t (s), g }] over [0, length]: unity, a
 * ramp down to duckGain before each region, a ramp back up after it.
 */
export function duckCurve(regions, length, duckGain, { attack = 0.25, release = 0.6 } = {}) {
  const pts = [{ t: 0, g: 1 }];
  const push = (t, g) => {
    t = Math.min(length, Math.max(0, t));
    const last = pts[pts.length - 1];
    if (t < last.t) return;
    if (Math.abs(t - last.t) < 1e-6) last.g = Math.min(last.g, g);
    else pts.push({ t, g });
  };
  for (const [a, b] of regions) {
    push(a - attack, 1);
    push(a, duckGain);
    push(b, duckGain);
    push(b + release, 1);
  }
  push(length, pts[pts.length - 1].g === duckGain && regions.length && regions[regions.length - 1][1] >= length ? duckGain : 1);
  return pts;
}

/** Linear interpolation of a duck curve at t. */
export function curveAt(pts, t) {
  if (t <= pts[0].t) return pts[0].g;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1];
      const b = pts[i];
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return a.g + (b.g - a.g) * f;
    }
  }
  return pts[pts.length - 1].g;
}

/* ---- Decoding --------------------------------------------------------------------- */

export function downmix(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

/**
 * Decode a clip's source range ({ sampleRate, channels }) through the
 * mixdown's decoder. maxSeconds caps very long clips; onProgress(0..1).
 * open: asset => source (audio-mix mediabunnyOpener(library) or a test stub).
 */
export async function decodeClipSound(open, asset, clip, { maxSeconds = 1200, signal, onProgress } = {}) {
  const src = await open(asset);
  if (!src) return null;
  const [from, to0] = sourceRange(clip);
  const to = Math.min(to0, from + maxSeconds);
  const parts = [];
  let rate = src.sampleRate;
  let nch = 1;
  try {
    for await (const chunk of src.read(from)) {
      if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
      rate = chunk.sampleRate;
      nch = Math.max(nch, chunk.channels.length);
      const n = chunk.channels[0]?.length || 0;
      const t0 = chunk.timestamp;
      const t1 = t0 + n / rate;
      if (t1 <= from) continue;
      const a = Math.max(0, Math.round((from - t0) * rate));
      const b = Math.min(n, Math.round((to - t0) * rate));
      if (b > a) parts.push(chunk.channels.map((c) => c.slice(a, b)));
      onProgress?.(Math.min(1, (t1 - from) / Math.max(1e-6, to - from)));
      if (t1 >= to) break;
    }
  } finally {
    src.close?.();
  }
  const total = parts.reduce((s, p) => s + p[0].length, 0);
  const channels = [];
  for (let c = 0; c < Math.min(2, nch); c++) {
    const out = new Float32Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p[Math.min(c, p.length - 1)], at);
      at += p[0].length;
    }
    channels.push(out);
  }
  return { sampleRate: rate, channels, start: from * US };
}
