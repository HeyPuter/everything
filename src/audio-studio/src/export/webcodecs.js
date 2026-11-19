// Ogg Opus and M4A (AAC) writers on the browser's WebCodecs AudioEncoder.
// The encoder runs inside the export worker; muxing is done by ogg.js/mp4.js.

import { muxOggOpus } from './ogg.js';
import { muxM4a } from './mp4.js';
import { vorbisChapterEntries } from '../audio/chapters.js';

/** Encoder delay of AAC-LC as produced by the platform encoders (measured in Chrome). */
export const AAC_PRIMING = 2112;

export const CODEC_CONFIG = {
  opus: (o) => ({ codec: 'opus', sampleRate: 48000, numberOfChannels: o.channels, bitrate: o.bitrate, opus: { frameDuration: 20000, complexity: 10 } }),
  m4a: (o) => ({ codec: 'mp4a.40.2', sampleRate: o.sampleRate, numberOfChannels: o.channels, bitrate: o.bitrate, aac: { format: 'aac' } }),
};

/** Resolves true when this browser can encode the format with the given options. */
export async function codecSupported(format, { sampleRate = 48000, channels = 2, bitrate = 128000 } = {}) {
  if (typeof AudioEncoder === 'undefined' || !CODEC_CONFIG[format]) return false;
  try {
    const r = await AudioEncoder.isConfigSupported(CODEC_CONFIG[format]({ sampleRate, channels, bitrate }));
    return Boolean(r.supported);
  } catch {
    return false;
  }
}

class WebCodecsWriter {
  constructor(format, { sampleRate, sourceRate, channels, frames, meta = {}, markers = [], settings = {} }) {
    this.markers = markers;
    this.inputRate = sourceRate || sampleRate;
    this.format = format;
    this.rate = sampleRate;
    this.nch = Math.min(2, channels);
    this.frames = frames;
    this.meta = meta;
    this.bitrate = Math.round((settings.bitrate ?? (format === 'opus' ? 128 : 192)) * 1000);
    this.packets = [];
    this.description = null;
    this.error = null;
    this.timestamp = 0;
  }

  async init() {
    if (typeof AudioEncoder === 'undefined') throw new Error('This browser cannot encode this format (WebCodecs is not available).');
    const config = CODEC_CONFIG[this.format]({ sampleRate: this.rate, channels: this.nch, bitrate: this.bitrate });
    const support = await AudioEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (!support.supported) throw new Error(`This browser cannot encode ${this.format === 'opus' ? 'Opus' : 'AAC'} audio with these settings.`);
    this.encoder = new AudioEncoder({
      output: (chunk, md) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.packets.push({ data, duration: chunk.duration, timestamp: chunk.timestamp });
        if (md?.decoderConfig?.description && !this.description) this.description = new Uint8Array(md.decoderConfig.description.buffer ?? md.decoderConfig.description);
      },
      error: (e) => {
        this.error = e;
      },
    });
    this.encoder.configure(config);
  }

  async write(planar, n) {
    if (this.error) throw this.error;
    const data = new Float32Array(n * this.nch);
    for (let c = 0; c < this.nch; c++) data.set(planar[c].subarray(0, n), c * n);
    const frame = new AudioData({ format: 'f32-planar', sampleRate: this.rate, numberOfFrames: n, numberOfChannels: this.nch, timestamp: Math.round((this.timestamp / this.rate) * 1e6), data });
    this.timestamp += n;
    this.encoder.encode(frame);
    frame.close();
    // Backpressure: never let the encoder queue grow without bound.
    while (this.encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
  }

  async finish() {
    await this.encoder.flush();
    if (this.error) throw this.error;
    this.encoder.close();
    if (this.format === 'opus') {
      let preSkip = 312;
      const d = this.description;
      if (d && d.length >= 12 && String.fromCharCode(...d.subarray(0, 8)) === 'OpusHead') preSkip = d[10] | (d[11] << 8);
      const pages = muxOggOpus({
        channels: this.nch,
        preSkip,
        inputRate: this.inputRate,
        packets: this.packets.map((p) => ({ data: p.data, samples: Math.round(((p.duration || 20000) * 48000) / 1e6) })),
        totalSamples: this.frames,
        meta: this.meta,
        chapters: vorbisChapterEntries(this.markers, this.rate),
      });
      return new Blob(pages, { type: 'audio/ogg' });
    }
    // AAC encoders prime the stream with 2112 samples (1024 + 1088 of filter delay).
    const parts = muxM4a({ sampleRate: this.rate, channels: this.nch, asc: this.description, packets: this.packets.map((p) => p.data), totalFrames: this.frames, priming: AAC_PRIMING, bitrate: this.bitrate, meta: this.meta, markers: this.markers });
    return new Blob(parts, { type: 'audio/mp4' });
  }

  abort() {
    try {
      this.encoder?.close();
    } catch {
      // Already closed.
    }
  }
}

export class OpusWriter extends WebCodecsWriter {
  constructor(o) {
    super('opus', o);
  }
}

export class AacWriter extends WebCodecsWriter {
  constructor(o) {
    super('m4a', o);
  }
}
