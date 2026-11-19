// Mains hum detection for the DeHummer's Auto frequency: finds the
// fundamental (40..70 Hz, so 50 Hz, 60 Hz or an off-nominal supply) whose
// harmonic comb stands out as steady narrow lines in the audio.
//
// The audio is mixed to mono, low-passed and decimated to about 1.6 kHz,
// and up to four stretches of two seconds spread over the range are
// analysed (zero-padded FFT, Hann window). Each candidate fundamental scores
// how far its harmonics rise above the spectrum a few hertz either side;
// the score that counts is the lowest over the stretches, so only a line
// that is there all the time (hum, not a held note) wins.

const F_MIN = 40;
const F_MAX = 70;
const STEP = 0.02;
const CHUNK_SECONDS = 2;
const MAX_CHUNKS = 4;
const N = 32768;
/** Lowest per-stretch score accepted as hum (about two clear harmonics). */
const MIN_SCORE = 1.5;

/** In-place iterative radix-2 complex FFT. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr0 = Math.cos(ang);
    const wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const t = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = t;
      }
    }
  }
}

/** 4th-order Butterworth low-pass (two biquad sections) applied in place. */
function lowpass(x, f, rate) {
  for (const q of [0.5412, 1.3066]) {
    const w = (2 * Math.PI * f) / rate;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    const b0 = (1 - cs) / 2 / a0;
    const b1 = (1 - cs) / a0;
    const a1 = (-2 * cs) / a0;
    const a2 = (1 - al) / a0;
    let [x1, x2, y1, y2] = [0, 0, 0, 0];
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = y;
      x[i] = y;
    }
  }
}

/** Power spectrum (N / 2 bins) of one decimated stretch, with its prefix sums. */
function spectrum(x) {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const m = Math.min(x.length, N);
  for (let i = 0; i < m; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / m));
  fft(re, im);
  const p = new Float64Array(N / 2);
  const prefix = new Float64Array(N / 2 + 1);
  for (let k = 0; k < N / 2; k++) {
    p[k] = re[k] * re[k] + im[k] * im[k];
    prefix[k + 1] = prefix[k] + p[k];
  }
  return { p, prefix };
}

/**
 * Candidate scores for one stretch: for each fundamental, the summed
 * log-ratio (capped at 30 dB) of each harmonic line over its surroundings.
 * Also returns the uncapped line power sum used to refine the estimate.
 */
function scores(spec, fs, cands) {
  const { p, prefix } = spec;
  const hz = N / fs;
  // Lines are judged against at least a floor 70 dB under the stretch's mean
  // power, so near-silent stretches do not turn rounding noise into lines.
  const floor = (prefix[p.length] / p.length) * 1e-7 + 1e-30;
  const top = Math.min(fs * 0.45, 720);
  const capped = new Float64Array(cands.length);
  const fine = new Float64Array(cands.length);
  const mean = (a, b) => {
    const lo = Math.max(0, Math.floor(a));
    const hi = Math.min(p.length, Math.ceil(b));
    return hi > lo ? (prefix[hi] - prefix[lo]) / (hi - lo) : 0;
  };
  for (let c = 0; c < cands.length; c++) {
    const f0 = cands[c];
    let s = 0;
    let f = 0;
    for (let h = 1; h * f0 < top; h++) {
      const bin = h * f0 * hz;
      const k = Math.floor(bin);
      const t = bin - k;
      const line = p[k] * (1 - t) + p[k + 1] * t;
      const bg = 0.5 * (mean(bin - 4 * hz, bin - 1.5 * hz) + mean(bin + 1.5 * hz, bin + 4 * hz)) + floor;
      const r = line / bg;
      if (r > 10) s += Math.min(3, Math.log10(r));
      f += Math.log10(line + 1e-30);
    }
    capped[c] = s;
    fine[c] = f;
  }
  return { capped, fine };
}

/**
 * Detects the hum fundamental of `channels` (Float32Array[] or Channel-like
 * objects with toArray) over [start, end).
 * @returns {{ frequency: number, strength: number } | null} null when no steady hum stands out
 */
export function detectHum(channels, rate, start = 0, end = null) {
  if (!channels?.length) return null;
  const len = channels[0].length;
  end = Math.min(len, end ?? len);
  start = Math.max(0, Math.min(end, start));
  const total = end - start;
  if (total < rate * 0.5) return null;
  const read = (ch, a, b) => (ch.toArray ? ch.toArray(a, b) : ch.subarray(a, b));
  const chunkLen = Math.min(total, Math.round(CHUNK_SECONDS * rate));
  const count = Math.max(1, Math.min(MAX_CHUNKS, Math.floor(total / chunkLen)));
  const D = Math.max(1, Math.floor(rate / 1600));
  const fs = rate / D;
  const cands = [];
  for (let f = F_MIN; f <= F_MAX + 1e-9; f += STEP) cands.push(Math.round(f * 100) / 100);
  let worst = null;
  let fineSum = null;
  for (let c = 0; c < count; c++) {
    const a = start + Math.round(count > 1 ? ((total - chunkLen) * c) / (count - 1) : 0);
    const mono = new Float64Array(chunkLen);
    for (const ch of channels) {
      const x = read(ch, a, a + chunkLen);
      for (let i = 0; i < x.length; i++) mono[i] += x[i] / channels.length;
    }
    lowpass(mono, Math.min(720, fs * 0.45), rate);
    const dec = new Float64Array(Math.floor(chunkLen / D));
    for (let i = 0; i < dec.length; i++) dec[i] = mono[i * D];
    const { capped, fine } = scores(spectrum(dec), fs, cands);
    if (!worst) {
      worst = capped;
      fineSum = fine;
    } else {
      for (let i = 0; i < cands.length; i++) {
        worst[i] = Math.min(worst[i], capped[i]);
        fineSum[i] += fine[i];
      }
    }
  }
  let best = 0;
  for (let i = 1; i < cands.length; i++) if (worst[i] > worst[best]) best = i;
  if (worst[best] < MIN_SCORE) return null;
  // Refine within +-0.3 Hz on the line power itself (the capped score is flat near the peak).
  let pick = best;
  for (let i = 0; i < cands.length; i++) {
    if (Math.abs(cands[i] - cands[best]) <= 0.3 && worst[i] >= MIN_SCORE && fineSum[i] > fineSum[pick]) pick = i;
  }
  return { frequency: cands[pick], strength: worst[best] };
}

const cache = new WeakMap();

/**
 * Hum detected in `state` (a file state) over `range`, else the selection of
 * `doc`, else the whole file; cached per state and range.
 */
export function humIn(state, range = null, doc = null) {
  const channels = state?.channels;
  if (!channels?.length) return null;
  const len = channels[0].length;
  const sel = doc?.selection;
  const [a, b] = range || (sel && sel.end > sel.start ? [sel.start, sel.end] : [0, len]);
  const key = `${a}:${b}`;
  let byRange = cache.get(state);
  if (!byRange) cache.set(state, (byRange = new Map()));
  if (!byRange.has(key)) {
    if (byRange.size > 16) byRange.clear();
    byRange.set(key, detectHum(channels, state.sampleRate || doc?.sampleRate || 48000, a, b));
  }
  return byRange.get(key);
}

const wrapped = new WeakMap();

/**
 * Hum in a multitrack chain's audio: `sources` are [{ channels, rate, range }]
 * (a clip's source audio over the part it plays; a track's clips, longest
 * first), or a function returning them. The first source with a steady hum
 * wins. Cached per source audio.
 */
export function humInSources(sources) {
  if (typeof sources === 'function') sources = sources();
  for (const src of sources || []) {
    if (!src?.channels?.length) continue;
    let state = wrapped.get(src.channels);
    if (!state) wrapped.set(src.channels, (state = { channels: src.channels, sampleRate: src.rate }));
    const hum = humIn(state, src.range || null);
    if (hum) return hum;
  }
  return null;
}
