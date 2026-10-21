/**
 * The singing of a song, apart from the music (lyrics). Kept apart from
 * lyrics.js so the lyrics worker loads only the sound math.
 */
import { Separator } from './audio-fx.js';

/**
 * The singing of a song as mono: the separator in voice mode at full
 * strength over both channels (a mono song gives the same channel twice,
 * where only the voice band is kept), with its latency taken out.
 * onProgress(fraction) follows along.
 */
export function isolateVocals(channels, sr, { amount = 100, onProgress } = {}) {
  const n = channels[0]?.length || 0;
  const s = new Separator(sr, { mode: 'voice', amount });
  const lat = s.latency;
  const L = new Float32Array(n + lat);
  const R = new Float32Array(n + lat);
  L.set(channels[0]);
  R.set(channels[1] || channels[0]);
  const B = 512;
  const every = B * 256;
  for (let i = 0; i < L.length; i += B) {
    const m = Math.min(B, L.length - i);
    s.process(L.subarray(i, i + m), R.subarray(i, i + m), m);
    if (onProgress && i && i % every === 0) onProgress(i / L.length);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (L[i + lat] + R[i + lat]) / 2;
  return out;
}
