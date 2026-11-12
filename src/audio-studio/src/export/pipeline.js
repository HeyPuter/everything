// The export pipeline: pulls source blocks on demand, maps channels,
// converts the sample rate with the streaming WASM resampler and feeds a
// format writer. Runs in the export worker; tests call it directly.

import { WavWriter, AiffWriter } from './pcm.js';
import { FlacWriter } from './flac.js';
import { Mp3Writer } from './mp3.js';
import { OpusWriter, AacWriter } from './webcodecs.js';
import { outputFrames } from './formats.js';
import { keptChunks } from '../audio/wav.js';

export const WRITERS = { wav: WavWriter, aiff: AiffWriter, flac: FlacWriter, mp3: Mp3Writer, opus: OpusWriter, m4a: AacWriter };

const BLOCK = 1 << 16;

/** Maps planar source channels onto `count` output channels. */
export function mapChannels(src, count, n = src[0]?.length ?? 0) {
  if (src.length === count) return src;
  if (count === 1) {
    const out = new Float32Array(n);
    const k = 1 / src.length;
    for (const ch of src) for (let i = 0; i < n; i++) out[i] += ch[i] * k;
    return [out];
  }
  return Array.from({ length: count }, (_, i) => src[Math.min(i, src.length - 1)]);
}

/** Streaming sample-rate converter for one channel on the WASM kernel. */
export class StreamResampler {
  constructor(dsp, from, to, maxIn = BLOCK, { quality = 50, filter = true } = {}) {
    this.x = dsp.x;
    this.h = this.x.rs_new_q ? this.x.rs_new_q(from, to, quality, filter ? 1 : 0) : this.x.rs_new(from, to);
    this.maxIn = maxIn;
    this.cap = Math.ceil((maxIn * to) / from) + 1024;
    this.inPtr = this.x.mem_alloc(maxIn * 4);
    this.outPtr = this.x.mem_alloc(this.cap * 4);
  }

  process(samples) {
    let out = [];
    for (let at = 0; at < samples.length; at += this.maxIn) {
      const part = samples.subarray(at, Math.min(samples.length, at + this.maxIn));
      new Float32Array(this.x.memory.buffer, this.inPtr, part.length).set(part);
      const n = this.x.rs_process(this.h, this.inPtr, part.length, this.outPtr, this.cap);
      out.push(new Float32Array(this.x.memory.buffer, this.outPtr, n).slice());
    }
    return out.length === 1 ? out[0] : concatFloats(out);
  }

  flush() {
    const n = this.x.rs_flush(this.h, this.outPtr, this.cap);
    return new Float32Array(this.x.memory.buffer, this.outPtr, n).slice();
  }

  free() {
    this.x.rs_free(this.h);
    this.x.mem_free(this.inPtr, this.maxIn * 4);
    this.x.mem_free(this.outPtr, this.cap * 4);
  }
}

function concatFloats(parts) {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * @param {object} job
 * @param {object} job.options   conformed export options (see formats.js)
 * @param {number} job.sourceRate
 * @param {number} job.frames    source frames to export
 * @param {(at: number, n: number) => Promise<Float32Array[]>|Float32Array[]} job.read  planar source blocks
 * @param {object[]} [job.markers] already in output frames
 * @param {object} [job.meta]
 * @param {object} [job.chunks] WAV chunks kept from the opened file (keptChunks in audio/wav.js)
 * @param {object} [job.dsp]     Dsp instance (needed for FLAC and rate conversion)
 * @param {{ quality?: number, filter?: boolean }} [job.resampler] sample-rate conversion settings
 * @param {(fraction: number) => void} [job.onProgress]
 * @param {() => boolean} [job.cancelled]
 * @returns {Promise<Blob>}
 */
export async function runExport({ options, sourceRate, frames, read, markers = [], meta = {}, chunks = null, dsp, resampler, onProgress, cancelled = () => false }) {
  const rate = options.sampleRate;
  const nch = options.channels;
  const total = outputFrames(frames, sourceRate, rate);
  const Writer = WRITERS[options.format];
  const target = { sampleRate: rate, channels: nch, frames: total };
  if (!Writer) throw new Error(`Unknown export format "${options.format}".`);
  const writer = new Writer({
    sampleRate: rate,
    sourceRate,
    channels: nch,
    bitDepth: options.bitDepth,
    dither: options.dither,
    frames: total,
    markers: options.markers === false ? [] : markers,
    meta: options.meta === false ? {} : meta,
    chunks: options.meta === false ? [] : keptChunks(chunks, target),
    settings: options.settings || {},
    dsp,
  });
  const resample = rate !== sourceRate;
  if (resample && !dsp) throw new Error('Sample rate conversion needs the DSP module.');
  const resamplers = resample ? Array.from({ length: nch }, () => new StreamResampler(dsp, sourceRate, rate, BLOCK, resampler)) : null;
  let written = 0;
  const emit = async (planar) => {
    const n = Math.min(planar[0].length, total - written);
    if (n <= 0) return;
    await writer.write(n === planar[0].length ? planar : planar.map((c) => c.subarray(0, n)), n);
    written += n;
  };
  try {
    await writer.init?.();
    for (let at = 0; at < frames; at += BLOCK) {
      if (cancelled()) throw new Error('Cancelled');
      const n = Math.min(BLOCK, frames - at);
      const src = await read(at, n);
      const mapped = mapChannels(src, nch, n).map((c) => (c.length === n ? c : c.subarray(0, n)));
      await emit(resample ? mapped.map((c, i) => resamplers[i].process(c)) : mapped);
      onProgress?.(Math.min(0.99, (at + n) / frames));
    }
    if (resample) await emit(resamplers.map((r) => r.flush()));
    if (written < total) {
      const pad = Array.from({ length: nch }, () => new Float32Array(total - written));
      await emit(pad);
    }
    const blob = await writer.finish();
    onProgress?.(1);
    return blob;
  } catch (err) {
    writer.abort?.();
    throw err;
  } finally {
    resamplers?.forEach((r) => r.free());
  }
}
