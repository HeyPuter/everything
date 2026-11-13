// RMS histogram for Amplitude Statistics: how often each windowed RMS level
// occurs, in 1 dB bins from HIST_FLOOR to 0 dBFS (full-scale square wave).
// Quieter windows land in the bottom bin.

export const HIST_FLOOR = -120;
export const HIST_BINS = -HIST_FLOOR + 1;

/** Adds the RMS of every whole `win`-sample window of `x` to `hist` (Uint32Array of HIST_BINS). */
export function accumulateRmsHistogram(hist, x, win) {
  for (let i = 0; i + win <= x.length; i += win) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += x[j] * x[j];
    if (!Number.isFinite(s)) {
      // NaN and infinite samples count as silence, as the window RMS statistics treat them.
      s = 0;
      for (let j = i; j < i + win; j++) if (Number.isFinite(x[j])) s += x[j] * x[j];
    }
    hist[rmsBin(Math.sqrt(s / win))]++;
  }
  return hist;
}

/** The histogram bin of an RMS level (linear). */
export function rmsBin(rms) {
  const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  return Math.max(0, Math.min(HIST_BINS - 1, Math.round(db - HIST_FLOOR)));
}

/** The level (dB) a histogram bin stands for. */
export const binDb = (bin) => HIST_FLOOR + bin;
