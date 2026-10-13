// Waveform peaks: the minimum and maximum sample of every block of samples
// (all channels together), at several block sizes so a waveform of any zoom
// is drawn from a few values per pixel. Level 0 summarizes `base` samples
// per bin; each further level combines `factor` bins of the one before.
export type PeakLevel = { per: number; min: Float32Array; max: Float32Array };
export type Peaks = { sampleRate: number; length: number; levels: PeakLevel[] };

export function computePeaks(channels: Float32Array[], sampleRate: number, base = 64, factor = 4): Peaks {
  const length = channels[0]?.length ?? 0;
  const bins = Math.max(1, Math.ceil(length / base));
  const min = new Float32Array(bins).fill(Infinity),
    max = new Float32Array(bins).fill(-Infinity);
  for (const ch of channels)
    for (let i = 0; i < length; i++) {
      const b = (i / base) | 0;
      const v = ch[i];
      if (v < min[b]) min[b] = v;
      if (v > max[b]) max[b] = v;
    }
  for (let b = 0; b < bins; b++)
    if (min[b] > max[b]) {
      min[b] = 0;
      max[b] = 0;
    }
  const levels: PeakLevel[] = [{ per: base, min, max }];
  while (levels.at(-1)!.min.length > 32) {
    const prev = levels.at(-1)!;
    const n = Math.ceil(prev.min.length / factor);
    const lo = new Float32Array(n),
      hi = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      let a = Infinity,
        z = -Infinity;
      for (let k = b * factor; k < Math.min(prev.min.length, (b + 1) * factor); k++) {
        if (prev.min[k] < a) a = prev.min[k];
        if (prev.max[k] > z) z = prev.max[k];
      }
      lo[b] = a;
      hi[b] = z;
    }
    levels.push({ per: prev.per * factor, min: lo, max: hi });
  }
  return { sampleRate, length, levels };
}

/** The coarsest level with at least one bin per `samplesPerColumn`. */
export function peakLevelFor(p: Peaks, samplesPerColumn: number): PeakLevel {
  let best = p.levels[0];
  for (const l of p.levels) if (l.per <= samplesPerColumn) best = l;
  return best;
}

/** Min/max of `columns` equal parts of seconds [from, from + seconds). */
export function peakColumns(p: Peaks, from: number, seconds: number, columns: number): { min: Float32Array; max: Float32Array } {
  const n = Math.max(1, Math.round(columns));
  const min = new Float32Array(n),
    max = new Float32Array(n);
  const s0 = from * p.sampleRate,
    spc = (seconds * p.sampleRate) / n;
  const level = peakLevelFor(p, spc);
  for (let c = 0; c < n; c++) {
    const a = Math.floor((s0 + c * spc) / level.per);
    const b = Math.max(a + 1, Math.ceil((s0 + (c + 1) * spc) / level.per));
    let lo = 0,
      hi = 0;
    for (let k = Math.max(0, a); k < Math.min(level.min.length, b); k++) {
      if (level.min[k] < lo) lo = level.min[k];
      if (level.max[k] > hi) hi = level.max[k];
    }
    min[c] = lo;
    max[c] = hi;
  }
  return { min, max };
}

/** An SVG path of a waveform in a box of `columns` x 2 (y from -1 at the top
 * to 1 at the bottom), for a viewBox of "0 -1 columns 2". */
export function waveformPath(cols: { min: Float32Array; max: Float32Array }, scale = 1) {
  const n = cols.min.length;
  const f = (v: number) => Math.max(-1, Math.min(1, v * scale)).toFixed(3);
  const top: string[] = [],
    bottom: string[] = [];
  for (let i = 0; i < n; i++) {
    // Keep a hairline where the sound is silent.
    const hi = Math.max(cols.max[i], 0.004),
      lo = Math.min(cols.min[i], -0.004);
    top.push(`${i} ${f(-hi)}`, `${i + 1} ${f(-hi)}`);
    bottom.push(`${i} ${f(-lo)}`, `${i + 1} ${f(-lo)}`);
  }
  return `M${top.join('L')}L${bottom.reverse().join('L')}Z`;
}
