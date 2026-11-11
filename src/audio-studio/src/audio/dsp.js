// Loads the Rust DSP module (src/audio/dsp.wasm, built from wasm/dsp) and wraps
// the kernels used on the main thread and in workers. The compiled
// WebAssembly.Module is shared with workers; the playback worklet gets the bytes.

import wasmUrl from './dsp.wasm?url';

let modulePromise = null;
let instancePromise = null;
let bytesPromise = null;

/** Sample-rate conversion settings (Preferences > Data): quality 0..100 and the pre/post filter. */
const resampleDefaults = { quality: 50, filter: true };

export function resampleSettings() {
  return { ...resampleDefaults };
}

export function setResampleSettings({ quality, filter } = {}) {
  if (Number.isFinite(Number(quality))) resampleDefaults.quality = Math.max(0, Math.min(100, Number(quality)));
  if (filter !== undefined) resampleDefaults.filter = Boolean(filter);
}

/** Compiled module, shared by every context that needs DSP. */
export function dspModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const res = await fetch(wasmUrl);
      if (WebAssembly.compileStreaming && res.headers.get('content-type')?.includes('wasm')) {
        try {
          return await WebAssembly.compileStreaming(res.clone());
        } catch {
          // Fall through to the buffered path (wrong MIME type on some hosts).
        }
      }
      return WebAssembly.compile(await res.arrayBuffer());
    })();
    modulePromise.catch(() => {
      modulePromise = null;
    });
  }
  return modulePromise;
}

/**
 * The module's bytes. The playback worklet compiles its own copy: browsers
 * (Chrome) refuse a compiled WebAssembly.Module posted to an AudioWorklet.
 */
export function dspBytes() {
  if (!bytesPromise) {
    bytesPromise = fetch(wasmUrl).then((res) => {
      if (!res.ok) throw new Error(`DSP module: HTTP ${res.status}`);
      return res.arrayBuffer();
    });
    bytesPromise.catch(() => {
      bytesPromise = null;
    });
  }
  return bytesPromise;
}

/** For tests and workers that already hold the bytes. */
export function setDspBytes(bytes) {
  modulePromise = WebAssembly.compile(bytes);
  instancePromise = null;
}

/** For workers handed a compiled module by the main thread. */
export function setDspModule(module) {
  modulePromise = Promise.resolve(module);
  instancePromise = null;
}

export async function dsp() {
  if (!instancePromise) {
    instancePromise = dspModule().then((m) => new Dsp(new WebAssembly.Instance(m, {})));
    instancePromise.catch(() => {
      instancePromise = null;
    });
  }
  return instancePromise;
}

export class Dsp {
  constructor(instance) {
    this.x = instance.exports;
  }

  get memory() {
    return this.x.memory.buffer;
  }

  /** Allocates n floats and returns { ptr, view() } ; call free() when done. */
  floats(n) {
    const bytes = Math.max(4, n * 4);
    const ptr = this.x.mem_alloc(bytes);
    if (!ptr) throw new Error('Out of DSP memory');
    return {
      ptr,
      n,
      view: () => new Float32Array(this.memory, ptr, n),
      free: () => this.x.mem_free(ptr, bytes),
    };
  }

  bytes(n) {
    const size = Math.max(1, n);
    const ptr = this.x.mem_alloc(size);
    if (!ptr) throw new Error('Out of DSP memory');
    return {
      ptr,
      n,
      view: () => new Uint8Array(this.memory, ptr, n),
      free: () => this.x.mem_free(ptr, size),
    };
  }

  /** Returns a reusable spectrum analyzer of `size` points (power of two). */
  analyzer(size, window = 0) {
    const h = this.x.spec_new(size, window);
    const bins = size / 2 + 1;
    const input = this.floats(size);
    const out = this.floats(bins);
    const dsp = this;
    return {
      size,
      bins,
      /** dBFS magnitudes of `samples` (first `size` used, zero padded). */
      frame(samples) {
        const v = input.view();
        v.fill(0);
        v.set(samples.subarray(0, Math.min(size, samples.length)));
        dsp.x.spec_frame(h, input.ptr, size, out.ptr);
        return out.view().slice();
      },
      /**
       * Spectrogram columns of samples (already padded by size/2 on both ends):
       * `frames` columns `hop` samples apart, as bytes in [floorDb, 0] -> [0, 255].
       */
      columns(samples, hop, frames, floorDb = -120) {
        const src = dsp.floats(samples.length);
        src.view().set(samples);
        const dst = dsp.bytes(frames * bins);
        dsp.x.spec_columns(h, src.ptr, samples.length, hop, frames, floorDb, dst.ptr);
        const result = dst.view().slice();
        src.free();
        dst.free();
        return result;
      },
      free() {
        dsp.x.spec_free(h);
        input.free();
        out.free();
      },
    };
  }

  /**
   * Band-limited resampling of one channel to `outLength` samples, at
   * `opts.quality` (0..100) with or without `opts.filter` (the pre/post filter);
   * both default to the Preferences > Data settings.
   */
  resample(samples, from, to, outLength = Math.round((samples.length * to) / from), opts = {}) {
    const src = this.floats(samples.length);
    src.view().set(samples);
    const dst = this.floats(outLength);
    const quality = opts.quality ?? resampleDefaults.quality;
    const filter = opts.filter ?? resampleDefaults.filter;
    if (this.x.resample_block_q) this.x.resample_block_q(src.ptr, samples.length, from, to, dst.ptr, outLength, quality, filter ? 1 : 0);
    else this.x.resample_block(src.ptr, samples.length, from, to, dst.ptr, outLength);
    const out = dst.view().slice();
    src.free();
    dst.free();
    return out;
  }

  /** Copies a Float32Array into fresh WASM memory; call free() on the result. */
  copyIn(samples) {
    const f = this.floats(samples.length);
    f.view().set(samples);
    return f;
  }

  /**
   * Runs a realtime WASM effect (fx/mod.rs kind) over whole channels, for
   * offline processes that reuse a streaming processor. The effect's reported
   * latency is compensated, and `tail` extra frames are rendered after the
   * input. Returns new Float32Arrays of length input + tail.
   * @param {number} kind
   * @param {number} rate
   * @param {Float32Array[]} channels one or two
   * @param {number[]} params in registry order
   * @param {{ data?: {slot:number, values:Float32Array}[], tail?: number,
   *           onProgress?: (fraction:number) => void, block?: number }} [o]
   */
  runEffect(kind, rate, channels, params, { data = [], tail = 0, onProgress, block = 8192 } = {}) {
    const nch = channels.length;
    const h = this.x.fx_new(kind, rate, nch);
    if (!h) throw new Error(`Unknown effect kind ${kind}`);
    try {
      for (const d of data) {
        const buf = this.copyIn(d.values);
        this.x.fx_data(h, d.slot, buf.ptr, d.values.length);
        buf.free();
      }
      params.forEach((v, i) => this.x.fx_set(h, i, v));
      this.x.fx_reset(h);
      const latency = this.x.fx_latency(h);
      const len = channels[0].length;
      const outLen = len + tail;
      const total = outLen + latency;
      const out = channels.map(() => new Float32Array(outLen));
      const io = this.floats(nch * block);
      for (let at = 0; at < total; at += block) {
        const n = Math.min(block, total - at);
        let v = new Float32Array(this.memory, io.ptr, nch * n);
        v.fill(0);
        if (at < len) for (let c = 0; c < nch; c++) v.set(channels[c].subarray(at, Math.min(len, at + n)), c * n);
        this.x.fx_process(h, io.ptr, n);
        v = new Float32Array(this.memory, io.ptr, nch * n);
        // Output frame (at + i) maps to result frame (at + i - latency).
        const from = Math.max(0, latency - at);
        for (let c = 0; c < nch; c++) {
          const dst = at + from - latency;
          const count = Math.min(n - from, outLen - dst);
          if (count > 0) out[c].set(v.subarray(c * n + from, c * n + from + count), dst);
        }
        onProgress?.(Math.min(1, (at + n) / total));
      }
      io.free();
      return out;
    } finally {
      this.x.fx_free(h);
    }
  }

  /** [min, max, sum, sumSq, clipped, nonFinite] of samples. */
  stats(samples) {
    const src = this.floats(samples.length);
    src.view().set(samples);
    const out = this.floats(6);
    this.x.stats_block(src.ptr, samples.length, out.ptr);
    const r = Array.from(out.view());
    src.free();
    out.free();
    return r;
  }
}
