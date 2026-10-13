/**
 * Lip sync from a voice recording, computed on the device. The sound is cut
 * into 20 ms frames; each frame gets four mouth values in 0..1:
 *   open   how far the jaw drops (loudness, more for vowels with a high first formant)
 *   wide   lips spread (bright vowels like "ee", a high spectral centroid)
 *   round  lips rounded ("oo", "oh", a low centroid)
 *   fric   teeth together for hissing sounds ("s", "f", "sh": energy above 2.6 kHz)
 * plus emphasis beats (stressed peaks at least 1.2 s apart) that drive the
 * presenter's gestures. Everything here is a pure function over samples, so
 * the same audio always gives the same mouth, in the preview and the export.
 *
 * Stored on the avatar clip compactly: { rate, data, beats } where data is
 * base64 of four bytes per frame (open, wide, round, fric).
 */
import { FFT } from './audio-fx.js';

/** Analysis frames per second. */
export const LIP_RATE = 50;
/** Longest voice analyzed (seconds); the mouth rests after that. */
export const LIP_MAX_SECONDS = 20 * 60;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (x, a, b) => clamp01((x - a) / (b - a));

function percentile(values, p) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

/**
 * Mouth curves for mono samples at sample rate sr:
 * { rate, frames, open, wide, round, fric (Float32Arrays in 0..1), beats: [frame] }.
 */
export function analyzeVoice(mono, sr, { rate = LIP_RATE } = {}) {
  const len = Math.min(mono?.length || 0, Math.floor(LIP_MAX_SECONDS * sr));
  const hop = sr / rate;
  const frames = Math.max(0, Math.ceil(len / hop));
  let N = 256;
  while (N < sr * 0.04 && N < 4096) N *= 2;
  const fft = new FFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const binHz = sr / N;
  const bin = (hz) => Math.max(1, Math.min(N / 2 - 1, Math.round(hz / binHz)));
  const [l0, l1, m1, h1] = [bin(150), bin(900), bin(2600), bin(Math.min(8000, sr * 0.48))];
  const c1 = bin(4000);
  const f1Top = bin(1000);
  const db = new Float32Array(frames);
  const f1 = new Float32Array(frames);
  const highR = new Float32Array(frames);
  const cent = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = Math.floor(f * hop);
    const b = Math.min(len, Math.floor((f + 1) * hop));
    let e = 0;
    for (let i = a; i < b; i++) e += mono[i] * mono[i];
    db[f] = 10 * Math.log10(e / Math.max(1, b - a) + 1e-12);
    const start = Math.round(a + hop / 2 - N / 2);
    for (let i = 0; i < N; i++) {
      const j = start + i;
      re[i] = j >= 0 && j < len ? mono[j] * win[i] : 0;
      im[i] = 0;
    }
    fft.transform(re, im);
    let low = 0;
    let mid = 0;
    let high = 0;
    let cw = 0;
    let cs = 0;
    let fw = 0;
    let fs = 0;
    for (let k = l0; k < h1; k++) {
      const pw = re[k] * re[k] + im[k] * im[k];
      if (k < l1) low += pw;
      else if (k < m1) mid += pw;
      else high += pw;
      if (k < f1Top) {
        fw += pw * k * binHz;
        fs += pw;
      }
      if (k < c1) {
        cw += pw * k * binHz;
        cs += pw;
      }
    }
    const tot = low + mid + high + 1e-12;
    f1[f] = fs > 0 ? fw / fs : 0;
    highR[f] = high / tot;
    cent[f] = cs > 0 ? cw / cs : 0;
  }
  // Loudness relative to this voice: its loud frames reach 1, its floor 0.
  const peak = percentile(db, 0.95);
  const quiet = percentile(db, 0.1);
  const floor = Math.max(peak - 40, Math.min(peak - 18, quiet + 6));
  const open = new Float32Array(frames);
  const wide = new Float32Array(frames);
  const round = new Float32Array(frames);
  const fric = new Float32Array(frames);
  const loud = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const l = peak > -100 ? smooth(db[f], floor, peak) : 0;
    loud[f] = l;
    const voiced = l > 0.06 ? 1 : 0;
    const fr = voiced * smooth(highR[f], 0.32, 0.7);
    fric[f] = fr;
    // The first formant rises as the jaw opens ("ah" over "ee").
    open[f] = l ** 0.85 * (0.5 + 0.5 * smooth(f1[f], 300, 720)) * (1 - 0.65 * fr);
    const c = smooth(cent[f], 450, 1600);
    wide[f] = voiced * smooth(c, 0.5, 0.85);
    round[f] = voiced * smooth(1 - c, 0.55, 0.9) * 0.85 * (1 - fr);
  }
  // Mouths open quickly and close a little slower; shapes glide.
  const follow = (arr, up, down) => {
    let y = 0;
    for (let f = 0; f < frames; f++) {
      const x = arr[f];
      y += (x - y) * (x > y ? up : down);
      arr[f] = y;
    }
  };
  follow(open, 0.75, 0.42);
  follow(wide, 0.5, 0.5);
  follow(round, 0.5, 0.5);
  follow(fric, 0.8, 0.5);
  // Lips move a moment before the sound they make.
  for (let f = 0; f < frames - 1; f++) open[f] = Math.max(open[f], open[f + 1] * 0.6);
  return { rate, frames, open, wide, round, fric, beats: emphasisBeats(loud, rate) };
}

/**
 * Stressed moments: peaks of the loudness (smoothed over ~140 ms) well above
 * the level around them, at least 1.2 s apart, strongest first.
 */
export function emphasisBeats(loud, rate = LIP_RATE, { minGap = 1.2, threshold = 0.5, lift = 0.1 } = {}) {
  const n = loud.length;
  const e = new Float32Array(n);
  const r = Math.max(1, Math.round(rate * 0.07));
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) {
      s += loud[j];
      c++;
    }
    e[i] = s / c;
  }
  const W = Math.round(rate * 0.8);
  const near = Math.round(rate * 0.2);
  const cands = [];
  for (let i = 0; i < n; i++) {
    if (e[i] < threshold) continue;
    let isMax = true;
    for (let j = Math.max(0, i - near); j <= Math.min(n - 1, i + near) && isMax; j++) if (e[j] > e[i] || (e[j] === e[i] && j < i)) isMax = false;
    if (!isMax) continue;
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) {
      s += e[j];
      c++;
    }
    if (e[i] - s / c >= lift) cands.push({ i, v: e[i] - s / c });
  }
  cands.sort((a, b) => b.v - a.v || a.i - b.i);
  const gap = Math.round(minGap * rate);
  const picked = [];
  for (const c of cands) if (picked.every((p) => Math.abs(p - c.i) >= gap)) picked.push(c.i);
  return picked.sort((a, b) => a - b);
}

/* ---- Storage -------------------------------------------------------------------- */

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Compact project form of an analysis: { rate, data (base64, 4 bytes a frame), beats }. */
export function encodeLips(a) {
  const bytes = new Uint8Array(a.frames * 4);
  for (let f = 0; f < a.frames; f++) {
    bytes[f * 4] = Math.round(clamp01(a.open[f]) * 255);
    bytes[f * 4 + 1] = Math.round(clamp01(a.wide[f]) * 255);
    bytes[f * 4 + 2] = Math.round(clamp01(a.round[f]) * 255);
    bytes[f * 4 + 3] = Math.round(clamp01(a.fric[f]) * 255);
  }
  return { rate: a.rate, data: toBase64(bytes), beats: [...a.beats] };
}

const MAX_DATA = Math.ceil((LIP_MAX_SECONDS * 100 * 4 * 4) / 3) + 4;

/** Validate stored lip data from untrusted JSON; null when unusable. */
export function normalizeLips(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rate = Math.round(Number(raw.rate));
  if (!(rate >= 10 && rate <= 100)) return null;
  const data = typeof raw.data === 'string' ? raw.data : '';
  if (!data || data.length > MAX_DATA || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4) return null;
  const frames = Math.floor(((data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)) / 4);
  const beats = (Array.isArray(raw.beats) ? raw.beats : [])
    .map(Number)
    .filter((b) => Number.isInteger(b) && b >= 0 && b < frames)
    .sort((a, b) => a - b)
    .filter((b, i, arr) => i === 0 || b !== arr[i - 1])
    .slice(0, 5000);
  return { rate, data, beats };
}

const decoded = new Map(); // data string -> Uint8Array (a few recent ones)

/** Byte frames of stored lips (decoded once and kept for reuse). */
export function lipBytes(lips) {
  if (!lips?.data) return null;
  let b = decoded.get(lips.data);
  if (!b) {
    try {
      b = fromBase64(lips.data);
    } catch {
      b = new Uint8Array(0);
    }
    decoded.set(lips.data, b);
    if (decoded.size > 16) decoded.delete(decoded.keys().next().value);
  }
  return b;
}

/** Duration in seconds covered by stored lips. */
export function lipsDuration(lips) {
  const b = lipBytes(lips);
  return b ? b.length / 4 / lips.rate : 0;
}

export const CLOSED_MOUTH = Object.freeze({ open: 0, wide: 0, round: 0, fric: 0 });

/** Mouth values at a time (seconds into the voice), interpolated between frames. */
export function mouthAt(lips, sec) {
  const b = lipBytes(lips);
  if (!b || !Number.isFinite(sec) || sec < 0) return CLOSED_MOUTH;
  const n = b.length / 4;
  const p = sec * lips.rate - 0.5;
  const i = Math.floor(p);
  if (i >= n || n === 0) return CLOSED_MOUTH;
  const f = p - i;
  const i0 = Math.max(0, Math.min(n - 1, i));
  const i1 = Math.max(0, Math.min(n - 1, i + 1));
  // The last frame fades out rather than holding the mouth open.
  const tail = i + 1 >= n ? 1 - f : 1;
  const v = (k) => ((b[i0 * 4 + k] * (1 - f) + b[i1 * 4 + k] * f) / 255) * tail;
  return { open: v(0), wide: v(1), round: v(2), fric: v(3) };
}

/** Mean openness over the 0.4 s before sec: how much the presenter is talking right now. */
export function talkLevel(lips, sec) {
  const b = lipBytes(lips);
  if (!b || !Number.isFinite(sec) || sec < 0) return 0;
  const n = b.length / 4;
  const end = Math.min(n, Math.floor(sec * lips.rate) + 1);
  const start = Math.max(0, end - Math.round(lips.rate * 0.4));
  if (end <= start) return 0;
  let s = 0;
  for (let i = start; i < end; i++) s += b[i * 4];
  return s / (end - start) / 255;
}
