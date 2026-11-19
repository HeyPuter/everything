// Wrappers for the analysis and spectral kernels in dsp.wasm (see
// wasm/dsp/src/{spectral,loudness,limiter,pitch,stats,spectrum}.rs). Each
// takes a Dsp instance (src/audio/dsp.js) so the same code runs on the main
// thread, in workers and in tests.

/** Copies arrays into WASM memory, runs fn(ptrs), frees them. */
function withFloats(d, arrays, fn) {
  const bufs = arrays.map((a) => {
    const b = d.floats(typeof a === 'number' ? a : a.length);
    if (typeof a !== 'number') b.view().set(a);
    return b;
  });
  try {
    return fn(bufs);
  } finally {
    for (const b of bufs) b.free();
  }
}

/**
 * Masked part of `diff`: the signal whose STFT is mask * STFT(diff).
 * mask: Float32Array cols x (n/2+1), column c centred at buffer index first + c * hop.
 */
export function maskBlend(d, diff, mask, cols, n, hop, first) {
  return withFloats(d, [diff, diff.length, mask], ([src, out, m]) => {
    d.x.spec_mask_blend(src.ptr, diff.length, out.ptr, m.ptr, cols, n, hop, first);
    return out.view().slice();
  });
}

/** Spot healing delta for src under mask (add it to src). */
export function healDelta(d, src, mask, cols, n, hop, first) {
  return withFloats(d, [src, src.length, mask], ([s, out, m]) => {
    d.x.spec_heal(s.ptr, src.length, out.ptr, m.ptr, cols, n, hop, first);
    return out.view().slice();
  });
}

/** Streaming BS.1770-4 loudness meter. push() takes per-channel arrays of equal length. */
export function loudnessMeter(d, rate, channels) {
  const h = d.x.lufs_new(rate, channels);
  let pushed = 0;
  return {
    push(chans) {
      const frames = chans[0].length;
      if (!frames) return;
      pushed += frames;
      const buf = d.floats(frames * channels);
      const v = buf.view();
      for (let c = 0; c < channels; c++) v.set(chans[Math.min(c, chans.length - 1)], c * frames);
      d.x.lufs_push(h, buf.ptr, frames);
      buf.free();
    },
    /** { integrated, range, momentary, shortTerm, maxMomentary, maxShortTerm, truePeak[], samplePeak[] } (LUFS, LU, linear) */
    result() {
      const out = d.floats(6 + 2 * channels);
      d.x.lufs_result(h, out.ptr);
      const r = Array.from(out.view());
      out.free();
      const inf = (v) => (v <= -999 ? -Infinity : v);
      return {
        integrated: inf(r[0]),
        range: r[1],
        momentary: inf(r[2]),
        shortTerm: inf(r[3]),
        maxMomentary: inf(r[4]),
        maxShortTerm: inf(r[5]),
        truePeak: r.slice(6, 6 + channels),
        samplePeak: r.slice(6 + channels, 6 + 2 * channels),
      };
    },
    /**
     * Momentary and short-term loudness through the measured audio, at most
     * `maxPoints` of each: { step (s between points), momentary[], shortTerm[] } (LUFS).
     */
    series(maxPoints = 600) {
      if (!d.x.lufs_series) return null;
      const subs = Math.floor((pushed * 10) / rate); // completed 100 ms sub-blocks
      const step = Math.max(1, Math.ceil(subs / maxPoints));
      const cap = Math.floor(subs / step) + 1;
      const read = (n) => {
        const out = d.floats(cap);
        const k = d.x.lufs_series(h, n, step, out.ptr, cap);
        const r = Array.from(out.view().subarray(0, k), (v) => (v <= -999 ? -Infinity : v));
        out.free();
        return r;
      };
      return { step: step / 10, momentary: read(4), shortTerm: read(30) };
    },
    free() {
      d.x.lufs_free(h);
    },
  };
}

/** Streaming look-ahead true-peak limiter with input gain. Output is delayed by `latency`. */
export function limiter(d, rate, channels, { ceiling, lookMs = 5, releaseMs = 80, gain = 1 }) {
  const h = d.x.lim_new(rate, channels, ceiling, lookMs, releaseMs, gain);
  return {
    latency: d.x.lim_latency(h),
    /** Processes per-channel arrays in place. */
    process(chans) {
      const frames = chans[0].length;
      if (!frames) return chans;
      const buf = d.floats(frames * channels);
      let v = buf.view();
      for (let c = 0; c < channels; c++) v.set(chans[c], c * frames);
      d.x.lim_process(h, buf.ptr, frames);
      v = buf.view();
      for (let c = 0; c < channels; c++) chans[c].set(v.subarray(c * frames, (c + 1) * frames));
      buf.free();
      return chans;
    },
    free() {
      d.x.lim_free(h);
    },
  };
}

/** YIN f0 track: frames of n samples hop apart from samples[0]; 0 = unvoiced. */
export function pitchTrack(d, samples, rate, { n = 2048, hop, frames, fmin = 50, fmax = 2000, threshold = 0.15 }) {
  return withFloats(d, [samples, frames], ([s, out]) => {
    d.x.pitch_track(s.ptr, samples.length, rate, n, hop, frames, fmin, fmax, threshold, out.ptr);
    return out.view().slice();
  });
}

/** Bits needed for samples (0 silence, 32 float). */
export function bitDepth(d, samples) {
  return withFloats(d, [samples], ([s]) => d.x.stats_bits(s.ptr, samples.length));
}

/** Window RMS over consecutive windows: [min, max, sum, count]. */
export function windowRms(d, samples, win) {
  return withFloats(d, [samples, 4], ([s, out]) => {
    d.x.stats_rms(s.ptr, samples.length, win, out.ptr);
    return Array.from(out.view());
  });
}

/**
 * Average power spectrum in dBFS of `frames` windows laid out `hop` apart in
 * samples (window i covers samples[i*hop .. i*hop + size]).
 */
export function averageSpectrum(d, samples, size, window, hop, frames) {
  const h = d.x.spec_new(size, window);
  try {
    return withFloats(d, [samples, size / 2 + 1], ([s, out]) => {
      d.x.spec_average(h, s.ptr, samples.length, hop, frames, out.ptr);
      return out.view().slice();
    });
  } finally {
    d.x.spec_free(h);
  }
}
