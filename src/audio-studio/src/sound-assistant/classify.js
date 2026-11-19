// Suggests an audio type (Dialogue, Music, SFX, Ambience) from the sound
// itself, so the Sound Assistant can offer one before the user picks.
// Heuristic and cheap: it looks at up to 40 s of a mono mix through
//   - the loudness envelope (20 ms frames): how often it pauses, how much it
//     moves, and how strongly it pulses at the 2-8 Hz rate of syllables;
//   - spectral flatness (noise-like vs tonal) from a small FFT per frame;
//   - the duration (short, isolated sounds are usually effects).
// Pure: no DOM, no app.

const FRAME_S = 0.02;
const MAX_S = 40;

/** In-place radix-2 FFT of re/im (length a power of two). */
function fft(re, im) {
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
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Mono mix of Float32Array channels over [start, end), at most MAX_S seconds from the middle. */
function monoMix(channels, rate, start, end) {
  const maxN = Math.round(MAX_S * rate);
  let a = start;
  let b = end;
  if (b - a > maxN) {
    a = Math.round((start + end - maxN) / 2);
    b = a + maxN;
  }
  const out = new Float32Array(Math.max(0, b - a));
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[a + i] / channels.length;
  return out;
}

/**
 * Measurements used to choose a type:
 *   seconds     length analysed
 *   silence     share of frames 35 dB or more under the loud frames
 *   spread      standard deviation of the voiced frames' level, dB
 *   syllabic    share of the envelope's movement in the 2-8 Hz band (0..1)
 *   pulse       how much of that movement sits at one rate (a beat or tremolo: near 1)
 *   flatness    mean spectral flatness of the loud frames (0 tonal .. 1 noise)
 *   peakToMedian loudest frame over the median one, dB
 */
export function audioFeatures(channels, rate, start = 0, end = channels[0]?.length || 0) {
  const x = monoMix(channels, rate, start, end);
  const hop = Math.max(1, Math.round(FRAME_S * rate));
  const frames = Math.floor(x.length / hop);
  const seconds = x.length / rate;
  if (frames < 4) return { seconds, silence: 1, spread: 0, syllabic: 0, pulse: 0, flatness: 0, peakToMedian: 0, frames };
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * hop, e = i + hop; i < e; i++) s += x[i] * x[i];
    db[f] = 10 * Math.log10(s / hop + 1e-12);
  }
  const sorted = Float32Array.from(db).sort();
  const loud = sorted[Math.floor(frames * 0.95)];
  const median = sorted[Math.floor(frames * 0.5)];
  if (loud < -70) return { seconds, silence: 1, spread: 0, syllabic: 0, pulse: 0, flatness: 0, peakToMedian: 0, frames };
  const floor = loud - 35;
  let quiet = 0;
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (const v of db) {
    if (v < floor) quiet++;
    else {
      n++;
      sum += v;
      sum2 += v * v;
    }
  }
  const mean = n ? sum / n : 0;
  const spread = n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0;

  // Envelope modulation: DFT of the (floored, mean-removed) level curve, sampled at 50 Hz.
  const env = Array.from(db, (v) => Math.max(v, floor));
  const envMean = env.reduce((a, b) => a + b, 0) / env.length;
  let size = 1;
  while (size < env.length) size <<= 1;
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  for (let i = 0; i < env.length; i++) re[i] = env[i] - envMean;
  fft(re, im);
  const envRate = 1 / FRAME_S;
  let band = 0;
  let total = 0;
  let peak = 0;
  let rhythm = 0;
  for (let k = 1; k < size / 2; k++) {
    const hz = (k * envRate) / size;
    if (hz < 0.5) continue;
    const p = re[k] * re[k] + im[k] * im[k];
    total += p;
    if (hz >= 2 && hz <= 8) band += p;
    if (hz <= 10) {
      rhythm += p;
      // A steady beat or tremolo puts its movement in a few bins; speech spreads it.
      const p3 = p + (k > 1 ? re[k - 1] ** 2 + im[k - 1] ** 2 : 0) + (re[k + 1] ** 2 + im[k + 1] ** 2);
      if (p3 > peak) peak = p3;
    }
  }
  const syllabic = total > 0 ? band / total : 0;
  const pulse = rhythm > 0 ? Math.min(1, peak / rhythm) : 0;

  // Spectral flatness on up to 200 loud frames (geometric over arithmetic mean of the power).
  const N = 512;
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const loudFrames = [];
  for (let f = 0; f < frames; f++) if (db[f] >= loud - 15 && f * hop + N <= x.length) loudFrames.push(f);
  const step = Math.max(1, Math.floor(loudFrames.length / 200));
  let flat = 0;
  let counted = 0;
  const fr = new Float32Array(N);
  const fi = new Float32Array(N);
  const lo = Math.max(1, Math.floor((80 * N) / rate));
  const hi = Math.min(N / 2, Math.floor((Math.min(10000, rate / 2) * N) / rate));
  for (let j = 0; j < loudFrames.length; j += step) {
    const at = loudFrames[j] * hop;
    for (let i = 0; i < N; i++) {
      fr[i] = x[at + i] * win[i];
      fi[i] = 0;
    }
    fft(fr, fi);
    let logSum = 0;
    let linSum = 0;
    for (let k = lo; k < hi; k++) {
      const p = fr[k] * fr[k] + fi[k] * fi[k] + 1e-20;
      logSum += Math.log(p);
      linSum += p;
    }
    const m = hi - lo;
    if (m > 0 && linSum > 0) {
      flat += Math.exp(logSum / m) / (linSum / m);
      counted++;
    }
  }
  return { seconds, silence: quiet / frames, spread, syllabic, pulse, flatness: counted ? flat / counted : 0, peakToMedian: loud - median, frames };
}

/**
 * The likeliest type for some features, with a score per type (0..1) and
 * how sure the suggestion is (`confidence`: the lead over the runner-up).
 * Returns { type: null } for silence.
 */
export function suggestType(f) {
  if (!f || f.frames < 4 || f.silence >= 0.99) return { type: null, scores: {}, confidence: 0 };
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const ramp = (v, a, b) => clamp((v - a) / (b - a));
  // Speech: pulses at the syllable rate, with short pauses and a lively level.
  const irregular = 1 - ramp(f.pulse, 0.25, 0.6);
  const dialogue = (0.5 * ramp(f.syllabic, 0.15, 0.4) + 0.25 * ramp(f.silence, 0.02, 0.15) * (1 - ramp(f.silence, 0.6, 0.85)) + 0.25 * ramp(f.spread, 3, 8)) * (0.4 + 0.6 * irregular);
  // Ambience: steady and noise-like, rarely silent
  // (a steady beat or tremolo is music, not a room).
  const ambience = (0.4 * (1 - ramp(f.spread, 2, 6)) + 0.35 * ramp(f.flatness, 0.04, 0.15) + 0.25 * (1 - ramp(f.silence, 0.05, 0.3))) * (1 - 0.5 * ramp(f.pulse, 0.4, 0.8));
  // Effects: short, or isolated sounds standing out of silence.
  const sfx = 0.45 * (1 - ramp(f.seconds, 2, 8)) + 0.3 * ramp(f.silence, 0.3, 0.7) + 0.25 * ramp(f.peakToMedian, 12, 30);
  // Music: tonal and continuous, with little syllabic pulse.
  const music = 0.4 * (1 - ramp(f.flatness, 0.03, 0.12)) + 0.3 * (1 - ramp(f.silence, 0.05, 0.25)) + 0.3 * Math.max(1 - ramp(f.syllabic, 0.2, 0.45), ramp(f.pulse, 0.3, 0.7));
  const scores = { dialogue, music, sfx, ambience };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return { type: ranked[0][0], scores, confidence: ranked[0][1] - ranked[1][1] };
}

/** Suggestion for audio channels (Float32Array[] or Channel[] with toArray). */
export function classifyAudio(channels, rate, start, end) {
  const arrays = channels.map((c) => (typeof c.toArray === 'function' ? c.toArray(start ?? 0, end ?? c.length) : c.subarray(start ?? 0, end ?? c.length)));
  const features = audioFeatures(arrays, rate, 0, arrays[0]?.length || 0);
  return { ...suggestType(features), features };
}
