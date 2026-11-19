// Measurements the tutorials use to check results: level over a stretch, how rough
// (clicky) a stretch is, the peak, and integrated loudness.

import { measureLoudness } from '../analysis/loudness.js';

const range = (doc, t0, t1) => {
  const r = doc.sampleRate;
  const a = Math.max(0, Math.min(doc.length, Math.round(t0 * r)));
  const b = Math.max(a, Math.min(doc.length, Math.round(t1 * r)));
  return [a, b];
};

/** RMS level (dBFS) of seconds t0..t1 over all channels. */
export function rmsDb(doc, t0, t1) {
  const [a, b] = range(doc, t0, t1);
  let sum = 0;
  let n = 0;
  for (const c of doc.state.channels) {
    const x = c.toArray(a, b);
    for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
    n += x.length;
  }
  return n && sum > 0 ? 10 * Math.log10(sum / n) : -Infinity;
}

/** Largest second difference in seconds t0..t1 (a click stands out sharply). */
export function roughness(doc, t0, t1) {
  const [a, b] = range(doc, t0, t1);
  let max = 0;
  for (const c of doc.state.channels) {
    const x = c.toArray(a, b);
    for (let i = 2; i < x.length; i++) max = Math.max(max, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]));
  }
  return max;
}

/** Sample peak (dBFS) of the whole file. */
export function peakDb(doc) {
  let peak = 0;
  for (const c of doc.state.channels) {
    const x = c.toArray();
    for (let i = 0; i < x.length; i++) {
      const v = Math.abs(x[i]);
      if (v > peak) peak = v;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Integrated loudness (LUFS) of the file, measured in the analysis worker. */
export async function integratedLoudness(doc, measure = measureLoudness) {
  const m = await measure(doc.state);
  return m.integrated;
}
