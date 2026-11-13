// Configured audio-clip playback speed, shared by source-position seeking
// and waveform drawing. Tuning is in semitones; strip/master pitch in cents.
// The combined range matches AudioPlayer::render in wasm/engine/src/sampler.rs.
import { INSTRUMENTS } from '../instruments/catalog.js';
import { toNorm } from '../lib/params.js';
import { curveShape } from '../automation/evaluate.js';

export const AUDIO_TUNE = INSTRUMENTS.audio.params.findIndex((p) => p.id === 'tune');
export const AUDIO_REVERSE = INSTRUMENTS.audio.params.findIndex((p) => p.id === 'reverse');

export function audioPlaybackRate(tune = 0, pitch = 0, master = 0) {
  const semitones = tune + (pitch + master) / 100;
  return 2 ** (Math.max(-96, Math.min(96, semitones)) / 12);
}

/** Boundaries where a stepped automation parameter changes its rounded value. */
export function audioStepCuts(def, seg, start, end, cut) {
  if (!def.step) return;
  const pts = seg.pts;
  for (let j = 0; j + 3 < pts.length; j += 2) {
    const a = pts[j], b = pts[j + 2], v0 = pts[j + 1], v1 = pts[j + 3];
    if (b <= start || a >= end || b <= a || v0 === v1) continue;
    for (let n = Math.floor(def.min / def.step); n < Math.ceil(def.max / def.step); n++) {
      const value = toNorm(def, (n + 0.5) * def.step);
      const fraction = (value - v0) / (v1 - v0);
      if (!(fraction > 0 && fraction < 1)) continue;
      let u = fraction;
      const curve = seg.cs?.[j / 2] || 0;
      if (curve) {
        let lo = 0, hi = 1;
        for (let k = 0; k < 40; k++) {
          const mid = (lo + hi) / 2;
          if (curveShape(mid, curve) < fraction) lo = mid;
          else hi = mid;
        }
        u = (lo + hi) / 2;
      }
      const tick = a + (b - a) * u;
      if (tick > start && tick < end) cut(tick);
    }
  }
}

/** Integrate a playback rate over seconds, without stepping through audio frames. */
export function integrateAudioRate(rateAt, start, end) {
  const gauss = (a, b) => {
    const mid = (a + b) / 2;
    const half = (b - a) / 2;
    const delta = half / Math.sqrt(3);
    return half * (rateAt(mid - delta) + rateAt(mid + delta));
  };
  const refine = (a, b, whole, tolerance, depth) => {
    const mid = (a + b) / 2;
    const left = gauss(a, mid), right = gauss(mid, b);
    if (!depth || Math.abs(left + right - whole) <= tolerance) return left + right;
    return refine(a, mid, left, tolerance / 2, depth - 1) + refine(mid, b, right, tolerance / 2, depth - 1);
  };
  return refine(start, end, gauss(start, end), 1e-7, 16);
}
