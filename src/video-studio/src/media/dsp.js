/**
 * Audio sample kernels backed by the Rust module in wasm/dsp, with plain
 * JavaScript fallbacks so everything still works where WebAssembly SIMD is
 * unavailable. Works in the page, in workers and under Node (tests).
 */
import wasmUrl from './dsp.wasm?url';

let instance = null;
let loading = null;

export async function loadDsp(bytes) {
  if (instance) return instance;
  if (!loading) {
    loading = (async () => {
      try {
        let buf = bytes;
        if (!buf) {
          const res = await fetch(wasmUrl);
          buf = await res.arrayBuffer();
        }
        const { instance: inst } = await WebAssembly.instantiate(buf, {});
        instance = inst.exports;
      } catch {
        instance = null;
      }
      return instance;
    })();
  }
  return loading;
}

/** Copy a Float32Array into wasm scratch memory at offset; returns the byte offset after it. */
function put(ex, offset, arr) {
  new Float32Array(ex.memory.buffer, offset, arr.length).set(arr);
  return offset + arr.length * 4;
}

export function peaksJS(data, buckets) {
  const out = new Float32Array(buckets * 2);
  const len = data.length;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * len) / buckets);
    const end = Math.min(len, Math.max(start + 1, Math.floor(((b + 1) * len) / buckets)));
    let lo = 0;
    let hi = 0;
    if (start < end) {
      lo = Infinity;
      hi = -Infinity;
      for (let i = start; i < end; i++) {
        const s = data[i];
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
    }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
}

/** Interleaved (min, max) per bucket over data. */
export function peaks(data, buckets) {
  const ex = instance;
  if (!ex || buckets <= 0) return peaksJS(data, Math.max(0, buckets));
  const bytes = data.length * 4 + buckets * 8;
  const base = ex.reserve(bytes);
  if (!base) return peaksJS(data, buckets);
  const outOff = put(ex, base, data);
  ex.peaks(base, data.length, buckets, outOff);
  return new Float32Array(ex.memory.buffer, outOff, buckets * 2).slice();
}

/** { peak, rms } of a buffer. */
export function levels(data) {
  const ex = instance;
  const base = ex ? ex.reserve(data.length * 4 + 8) : 0;
  // No module, or it could not grow its memory: use the JS version.
  if (!base) {
    let peak = 0;
    let sum = 0;
    for (const s of data) {
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sum += s * s;
    }
    return { peak, rms: data.length ? Math.sqrt(sum / data.length) : 0 };
  }
  const outOff = put(ex, base, data);
  ex.levels(base, data.length, outOff);
  const r = new Float32Array(ex.memory.buffer, outOff, 2);
  return { peak: r[0], rms: r[1] };
}

/** dst += src * gain ramping g0 -> g1 (mutates dst). */
export function mixRamp(dst, src, g0, g1) {
  const n = Math.min(dst.length, src.length);
  const ex = instance;
  const base = ex && n >= 256 ? ex.reserve(n * 8) : 0;
  if (!base) {
    const step = n > 1 ? (g1 - g0) / (n - 1) : 0;
    for (let i = 0; i < n; i++) dst[i] += src[i] * (g0 + step * i);
    return dst;
  }
  const srcOff = put(ex, base, dst.subarray(0, n));
  put(ex, srcOff, src.subarray(0, n));
  ex.mix_ramp(base, srcOff, n, g0, g1);
  dst.set(new Float32Array(ex.memory.buffer, base, n));
  return dst;
}

/** Linear resample of src from fractional pos by step into a new array of count samples. */
export function resample(src, pos, step, count) {
  const ex = instance;
  const base = ex ? ex.reserve(src.length * 4 + count * 4) : 0;
  if (!base) {
    const out = new Float32Array(count);
    let p = pos;
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(p);
      const f = p - idx;
      out[i] = idx < 0 ? 0 : idx + 1 < src.length ? src[idx] + (src[idx + 1] - src[idx]) * f : idx < src.length ? src[idx] : 0;
      p += step;
    }
    return out;
  }
  const outOff = put(ex, base, src);
  ex.resample(base, src.length, pos, step, outOff, count);
  return new Float32Array(ex.memory.buffer, outOff, count).slice();
}

/**
 * Look-ahead peak limiter for the final mix, streaming over chunks. The
 * gain eases down over the look-ahead before a peak (so no sample goes over
 * the threshold and nothing is clipped) and recovers smoothly after it;
 * the channels share one gain so the stereo image holds. Sound that stays
 * under the threshold passes bit for bit.
 */
export class PeakLimiter {
  constructor(sampleRate, { threshold = 0.9, lookAheadMs = 5, releaseMs = 80 } = {}) {
    this.t = threshold;
    this.L = Math.max(1, Math.round((lookAheadMs * sampleRate) / 1000));
    this.rel = 1 - Math.exp(-1 / ((releaseMs * sampleRate) / 1000));
    this.g = 1;
  }

  /**
   * Limit cur (planar channels, in place) given the start of the chunk that
   * follows it (next, or null at the end). Chunks must come in order.
   */
  process(cur, next) {
    const { t, L } = this;
    const n = cur[0].length;
    const nNext = next ? Math.min(L, next[0].length) : 0;
    const over = (chs, len) => {
      for (const ch of chs) {
        for (let i = 0; i < len; i++) if (ch[i] > t || ch[i] < -t) return true;
      }
      return false;
    };
    // Nothing near the threshold and no gain to recover: leave the sound as it is.
    if (this.g === 1 && !over(cur, n) && !(next && over(next, nNext))) return cur;
    // Gain each sample may have at most: 1, or what brings its peak to the threshold.
    let att = null;
    for (let j = 0; j < n + nNext; j++) {
      const chs = j < n ? cur : next;
      const k = j < n ? j : j - n;
      let peak = 0;
      for (let c = 0; c < chs.length; c++) {
        const v = Math.abs(chs[c][k]);
        if (v > peak) peak = v;
      }
      if (!(peak > t)) continue;
      const r = t / peak;
      att ||= new Float32Array(n).fill(1);
      // Ease down over the look-ahead so the gain is r when the peak arrives.
      for (let i = Math.max(0, j - L); i <= Math.min(j, n - 1); i++) {
        const v = r + ((1 - r) * (j - i)) / L;
        if (v < att[i]) att[i] = v;
      }
    }
    let g = this.g;
    if (!att && g === 1) return cur;
    const { rel } = this;
    for (let i = 0; i < n; i++) {
      g += (1 - g) * rel;
      if (g > 1 - 1e-6) g = 1;
      if (att && att[i] < g) g = att[i];
      if (g !== 1) for (const ch of cur) ch[i] *= g;
    }
    this.g = g;
    return cur;
  }
}

/** Gentle limiter so summed tracks never clip harshly (mutates buf). */
export function softClip(buf) {
  const ex = instance;
  const base = ex ? ex.reserve(buf.length * 4) : 0;
  if (!base) {
    // Reaches exactly 1 with zero slope at x = 3 (see wasm/dsp soft_clip).
    const t = (x) => (x > 3 ? 1 : (x * (27 + x * x)) / (27 + 9 * x * x));
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      if (x > 0.9) buf[i] = 0.9 + 0.1 * t((x - 0.9) * 10);
      else if (x < -0.9) buf[i] = -0.9 - 0.1 * t((-x - 0.9) * 10);
    }
    return buf;
  }
  put(ex, base, buf);
  ex.soft_clip(base, buf.length);
  buf.set(new Float32Array(ex.memory.buffer, base, buf.length));
  return buf;
}

export function dspReady() {
  return Boolean(instance);
}
