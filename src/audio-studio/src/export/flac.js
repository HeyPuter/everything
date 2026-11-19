// FLAC writer: drives the Rust encoder (wasm/dsp/src/flac.rs) block by block
// and wraps its frames in a file with STREAMINFO, Vorbis comments and padding.

import { ByteSink, ascii, concatBytes } from './sink.js';
import { Quantizer } from '../audio/quantize.js';
import { vorbisComment } from '../audio/meta.js';
import { vorbisChapterEntries } from '../audio/chapters.js';

function metadataBlock(type, body, last) {
  const head = Uint8Array.of((last ? 0x80 : 0) | type, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255);
  return concatBytes([head, body]);
}

export class FlacWriter {
  /** @param {object} o writer options plus `dsp` (a Dsp instance) */
  constructor({ sampleRate, channels, bitDepth = 16, dither = 'triangular', meta = {}, markers = [], settings = {}, dsp }) {
    // Markers travel as chapter comments (CHAPTERnnn), the convention players read.
    this.chapters = vorbisChapterEntries(markers, sampleRate);
    if (!dsp) throw new Error('FLAC encoding needs the DSP module.');
    this.x = dsp.x;
    this.nch = channels;
    this.bits = Math.min(24, Math.max(8, bitDepth === 32 ? 24 : bitDepth));
    this.quantizer = new Quantizer(this.bits, channels, dither);
    this.meta = meta;
    const level = Math.max(0, Math.min(8, Math.round(settings.level ?? 5)));
    this.h = this.x.flac_new(sampleRate, channels, this.bits, level);
    if (!this.h) throw new Error('These settings cannot be written as FLAC.');
    this.bs = this.x.flac_block_size(this.h);
    this.block = Array.from({ length: channels }, () => new Int32Array(this.bs));
    this.fill = 0;
    this.sink = new ByteSink();
  }

  #encode(n) {
    const ptr = this.x.flac_input(this.h);
    const input = new Int32Array(this.x.memory.buffer, ptr, this.bs * this.nch);
    for (let c = 0; c < this.nch; c++) input.set(n === this.bs ? this.block[c] : this.block[c].subarray(0, n), c * this.bs);
    const size = this.x.flac_encode(this.h, n);
    const out = new Uint8Array(this.x.memory.buffer, this.x.flac_output(this.h), size);
    this.sink.push(out);
  }

  write(planar, n) {
    let at = 0;
    while (at < n) {
      const take = Math.min(n - at, this.bs - this.fill);
      for (let c = 0; c < this.nch; c++) this.quantizer.convert(c, planar[c].subarray(at, at + take), take, this.block[c], this.fill);
      this.fill += take;
      at += take;
      if (this.fill === this.bs) {
        this.#encode(this.bs);
        this.fill = 0;
      }
    }
  }

  finish() {
    if (this.fill) this.#encode(this.fill);
    this.fill = 0;
    const info = new Uint8Array(this.x.memory.buffer, this.x.flac_streaminfo(this.h), 34).slice();
    this.x.flac_free(this.h);
    this.h = 0;
    const head = concatBytes([
      ascii('fLaC'),
      metadataBlock(0, info, false),
      metadataBlock(4, vorbisComment(this.meta, 'Audio Studio FLAC encoder', this.chapters), false),
      metadataBlock(1, new Uint8Array(4096), true),
    ]);
    return new Blob([head, ...this.sink.take()], { type: 'audio/flac' });
  }

  abort() {
    if (this.h) this.x.flac_free(this.h);
    this.h = 0;
  }
}
