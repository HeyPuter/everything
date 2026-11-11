/**
 * Local analysis behind the smart editing tools: shot changes in a video,
 * silent stretches in the sound, and the offset that lines up two
 * recordings of the same sound. The math is pure (tested directly); the
 * decoders use Mediabunny and run in the browser.
 */
import { US } from '../lib/time.js';

// ---- Silences -----------------------------------------------------------------

/**
 * Silent stretches (seconds) in a level envelope (dB per hop): below
 * thresholdDb for at least minSilence, each shrunk by pad on both sides so
 * cuts keep a little breathing room.
 */
export function silentRanges(levels, hopSec, { thresholdDb = -38, minSilence = 0.6, pad = 0.12 } = {}) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= levels.length; i++) {
    const quiet = i < levels.length && levels[i] < thresholdDb;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      const a = start * hopSec;
      const b = i * hopSec;
      if (b - a >= minSilence && b - a - 2 * pad > 0.05) out.push({ start: a + pad, end: b - pad });
      start = -1;
    }
  }
  return out;
}

// ---- Scene changes --------------------------------------------------------------

export const SIG_W = 16;
export const SIG_H = 9;
const HUE_BINS = 12;

/** Signature of an RGBA frame (SIG_W x SIG_H): luma grid plus a hue/saturation histogram. */
export function frameSignature(rgba) {
  const n = SIG_W * SIG_H;
  const sig = new Float32Array(n + HUE_BINS);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] / 255;
    const g = rgba[i * 4 + 1] / 255;
    const b = rgba[i * 4 + 2] / 255;
    sig[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const d = mx - mn;
    if (d > 0.08) {
      let hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      if (hue < 0) hue += 6;
      sig[n + Math.min(HUE_BINS - 1, Math.floor((hue / 6) * HUE_BINS))] += d / n;
    }
  }
  return sig;
}

/** How different two signatures are (0 = same, about 1 = unrelated). */
export function signatureDistance(a, b) {
  const n = SIG_W * SIG_H;
  let luma = 0;
  for (let i = 0; i < n; i++) luma += Math.abs(a[i] - b[i]);
  let hue = 0;
  for (let i = n; i < a.length; i++) hue += Math.abs(a[i] - b[i]);
  return (luma / n) * 2.2 + hue * 1.2;
}

/**
 * Indices where a new shot starts, from consecutive frame distances: a
 * distance well above its neighbourhood (and above a floor), at least
 * minGap frames after the previous cut. sensitivity 0..1 (higher = more cuts).
 */
export function sceneCuts(distances, { sensitivity = 0.5, minGap = 4, window = 12 } = {}) {
  const floor = 0.32 - 0.22 * sensitivity;
  const k = 4.5 - 3 * sensitivity;
  const cuts = [];
  let last = -Infinity;
  for (let i = 0; i < distances.length; i++) {
    const d = distances[i];
    if (d < floor) continue;
    // Robust neighbourhood statistics (median and MAD) so one cut nearby
    // does not hide another.
    const near = [];
    for (let j = Math.max(0, i - window); j <= Math.min(distances.length - 1, i + window); j++) if (j !== i) near.push(distances[j]);
    near.sort((x, y) => x - y);
    const median = near.length ? near[near.length >> 1] : 0;
    const dev = near.map((x) => Math.abs(x - median)).sort((x, y) => x - y);
    const mad = dev.length ? dev[dev.length >> 1] * 1.4826 : 0;
    if (d > median + k * Math.max(mad, 0.02) && i + 1 - last >= minGap) {
      cuts.push(i + 1); // distances[i] is between frames i and i + 1
      last = i + 1;
    }
  }
  return cuts;
}

/**
 * Source times (µs) of shot changes in [from, to) of a video blob, sampling
 * fps frames per second.
 */
export async function detectScenes(blob, from, to, { fps = 5, sensitivity = 0.5, signal, onProgress } = {}) {
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('This video can not be decoded here.');
    const sink = new CanvasSink(track, { width: SIG_W, height: SIG_H, fit: 'fill', poolSize: 1 });
    const scratch = new OffscreenCanvas(SIG_W, SIG_H);
    const g = scratch.getContext('2d', { willReadFrequently: true });
    const a = from / US;
    const b = to / US;
    const times = [];
    for (let t = a; t < b; t += 1 / fps) times.push(t);
    const sigs = [];
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
      if (wrapped) {
        g.drawImage(wrapped.canvas, 0, 0, SIG_W, SIG_H);
        sigs.push({ t: times[i], sig: frameSignature(g.getImageData(0, 0, SIG_W, SIG_H).data) });
      }
      i++;
      if (i % 10 === 0) onProgress?.(i / times.length);
    }
    const dist = [];
    for (let j = 1; j < sigs.length; j++) dist.push(signatureDistance(sigs[j - 1].sig, sigs[j].sig));
    const out = [];
    for (const j of sceneCuts(dist, { sensitivity, minGap: Math.max(2, Math.round(fps * 0.6)) })) {
      // The shot changed somewhere between two samples (up to 1 / fps apart):
      // find the frame it changed on, so no frame of the next shot is left behind.
      let best = -1;
      let at = sigs[j].t;
      let prev = null;
      for await (const wrapped of sink.canvases(sigs[j - 1].t, sigs[j].t + 1e-3)) {
        if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
        g.drawImage(wrapped.canvas, 0, 0, SIG_W, SIG_H);
        const sig = frameSignature(g.getImageData(0, 0, SIG_W, SIG_H).data);
        if (prev) {
          const d = signatureDistance(prev, sig);
          if (d > best) {
            best = d;
            at = wrapped.timestamp;
          }
        }
        prev = sig;
      }
      out.push(Math.round(at * US));
    }
    return out;
  } finally {
    input.dispose();
  }
}

// ---- Syncing two recordings ----------------------------------------------------------

/** Onset-ish envelope at 1 / hopSec: positive changes of RMS level, mean removed. */
export function syncEnvelope(mono, sr, hopSec = 0.01) {
  const hop = Math.max(1, Math.round(sr * hopSec));
  const n = Math.floor(mono.length / hop);
  const env = new Float32Array(n);
  let prev = 0;
  for (let b = 0; b < n; b++) {
    let s = 0;
    for (let i = b * hop; i < (b + 1) * hop; i++) s += mono[i] * mono[i];
    const level = Math.sqrt(s / hop);
    env[b] = Math.max(0, level - prev);
    prev = level;
  }
  let mean = 0;
  for (const v of env) mean += v;
  mean /= Math.max(1, n);
  for (let i = 0; i < n; i++) env[i] -= mean;
  return env;
}

/**
 * Lag (in envelope steps) that best lines b up with a: b[i] matches
 * a[i + lag]. Searches |lag| <= maxLag. Returns { lag, score } where score
 * is the normalized correlation (about 1 = clear match).
 */
export function bestLag(a, b, maxLag) {
  let best = 0;
  let bestScore = -Infinity;
  let ea = 0;
  let eb = 0;
  for (const v of a) ea += v * v;
  for (const v of b) eb += v * v;
  const norm = Math.sqrt(ea * eb) || 1;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    const i0 = Math.max(0, -lag);
    const i1 = Math.min(b.length, a.length - lag);
    for (let i = i0; i < i1; i++) s += a[i + lag] * b[i];
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  return { lag: best, score: bestScore / norm };
}
