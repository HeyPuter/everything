// Streaming WAV (RIFF, RF64 past 4 GB, WAVE_FORMAT_EXTENSIBLE for more than
// two channels) and AIFF/AIFF-C writers. The total frame count is known up
// front, so headers are written first and samples stream after them.
//
// Writer contract (shared by every export format):
//   new Writer({ sampleRate, channels, bitDepth, dither, frames, markers, meta, settings })
//   await writer.init?.()
//   await writer.write(planar Float32Array[], n)   (any block size)
//   await writer.finish() -> Blob

import { ByteSink, ascii, concatBytes } from './sink.js';
import { Quantizer } from '../audio/quantize.js';
import { buildCue } from '../audio/wav.js';
import { writeExtended } from '../audio/aiff.js';
import { riffInfoChunk, bextChunk, cartChunk, aiffMetaChunks, concatChunks, hasXmpOnly } from '../audio/meta.js';
import { wavXmpChunk } from '../audio/xmp.js';

function u32le(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

const SUBFORMAT_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/** Interleaves and encodes one block of samples as little- or big-endian PCM bytes. */
function packPcm(planar, n, { bitDepth, float, little, quantizer, unsigned8 }) {
  const nch = planar.length;
  const bytes = bitDepth / 8;
  const out = new Uint8Array(n * nch * bytes);
  const dv = new DataView(out.buffer);
  if (float) {
    for (let c = 0; c < nch; c++) {
      const src = planar[c];
      for (let i = 0, p = c * 4; i < n; i++, p += nch * 4) dv.setFloat32(p, src[i], little);
    }
    return out;
  }
  const ints = new Int32Array(n * nch);
  for (let c = 0; c < nch; c++) quantizer.convert(c, planar[c], n, ints, c, nch);
  const total = n * nch;
  if (bytes === 2) {
    for (let k = 0, p = 0; k < total; k++, p += 2) dv.setInt16(p, ints[k], little);
  } else if (bytes === 3) {
    for (let k = 0, p = 0; k < total; k++, p += 3) {
      const v = ints[k];
      if (little) {
        out[p] = v & 255;
        out[p + 1] = (v >> 8) & 255;
        out[p + 2] = (v >> 16) & 255;
      } else {
        out[p] = (v >> 16) & 255;
        out[p + 1] = (v >> 8) & 255;
        out[p + 2] = v & 255;
      }
    }
  } else if (bytes === 1) {
    for (let k = 0; k < total; k++) out[k] = unsigned8 ? ints[k] + 128 : ints[k] & 255;
  } else {
    for (let k = 0, p = 0; k < total; k++, p += 4) dv.setInt32(p, ints[k], little);
  }
  return out;
}

export class WavWriter {
  constructor({ sampleRate, channels, bitDepth = 16, dither = 'triangular', frames, markers = [], meta = {}, chunks = [] }) {
    this.nch = channels;
    this.bitDepth = bitDepth;
    this.float = bitDepth === 32;
    this.quantizer = this.float ? null : new Quantizer(bitDepth, channels, dither);
    const bytes = bitDepth / 8;
    this.dataSize = frames * channels * bytes;
    this.sink = new ByteSink();
    // LIST/INFO, bext, cart and XMP (_PMX) chunks, then chunks kept from the opened file
    // (iXML...), all before the audio data.
    const kept = chunks.map(({ id, bytes: b }) => {
      return concatBytes([ascii(id), u32le(b.length), b, new Uint8Array(b.length & 1)]);
    });
    const xmp = hasXmpOnly(meta) ? wavXmpChunk(meta) : null;
    const tags = [bextChunk(meta), riffInfoChunk(meta), cartChunk(meta), xmp];
    const info = concatChunks([...tags, ...kept]);
    const cue = markers.length ? new Uint8Array(buildCue(markers.map((m) => ({ ...m, start: Math.min(m.start, frames), duration: Math.max(0, Math.min(m.duration || 0, frames - m.start)) })))) : null;
    this.tail = cue;
    const extensible = channels > 2;
    const fmtSize = extensible ? 40 : 16;
    const pad = this.dataSize & 1;
    const after = (info ? info.length : 0) + (cue ? cue.length : 0);
    const riffBody = 4 + 8 + fmtSize + 8 + this.dataSize + pad + after;
    this.rf64 = riffBody + 36 > 0xfffffff0;
    const head = new Uint8Array(12 + (this.rf64 ? 36 : 0) + 8 + fmtSize);
    const dv = new DataView(head.buffer);
    head.set(ascii(this.rf64 ? 'RF64' : 'RIFF'), 0);
    dv.setUint32(4, this.rf64 ? 0xffffffff : riffBody, true);
    head.set(ascii('WAVE'), 8);
    let o = 12;
    if (this.rf64) {
      head.set(ascii('ds64'), o);
      dv.setUint32(o + 4, 28, true);
      dv.setBigUint64(o + 8, BigInt(riffBody + 36), true);
      dv.setBigUint64(o + 16, BigInt(this.dataSize), true);
      dv.setBigUint64(o + 24, BigInt(frames), true);
      dv.setUint32(o + 32, 0, true);
      o += 36;
    }
    head.set(ascii('fmt '), o);
    dv.setUint32(o + 4, fmtSize, true);
    const tag = this.float ? 3 : 1;
    dv.setUint16(o + 8, extensible ? 0xfffe : tag, true);
    dv.setUint16(o + 10, channels, true);
    dv.setUint32(o + 12, sampleRate, true);
    dv.setUint32(o + 16, sampleRate * channels * bytes, true);
    dv.setUint16(o + 20, channels * bytes, true);
    dv.setUint16(o + 22, bitDepth, true);
    if (extensible) {
      dv.setUint16(o + 24, 22, true);
      dv.setUint16(o + 26, bitDepth, true);
      // Speaker positions for surround layouts up to 7.1; more channels are unassigned.
      dv.setUint32(o + 28, channels > 8 ? 0 : 2 ** channels - 1, true);
      dv.setUint16(o + 32, tag, true);
      head.set(SUBFORMAT_TAIL, o + 34);
    }
    this.sink.push(head);
    if (info) this.sink.push(info);
    const data = new Uint8Array(8);
    data.set(ascii('data'));
    new DataView(data.buffer).setUint32(4, this.rf64 ? 0xffffffff : this.dataSize, true);
    this.sink.push(data);
    this.written = 0;
  }

  write(planar, n) {
    this.sink.push(packPcm(planar, n, { bitDepth: this.bitDepth, float: this.float, little: true, quantizer: this.quantizer, unsigned8: true }));
    this.written += n * this.nch * (this.bitDepth / 8);
  }

  finish() {
    if (this.written !== this.dataSize) throw new Error(`WAV writer received ${this.written} of ${this.dataSize} bytes.`);
    if (this.dataSize & 1) this.sink.push(new Uint8Array(1));
    if (this.tail) this.sink.push(this.tail);
    return new Blob(this.sink.take(), { type: 'audio/wav' });
  }
}

function chunk(id, body) {
  const head = new Uint8Array(8);
  head.set(ascii(id));
  new DataView(head.buffer).setUint32(4, body.length, false);
  return concatBytes([head, body, new Uint8Array(body.length & 1)]);
}

const utf8 = new TextEncoder();

/**
 * Pascal string: a count byte, then the text, padded to an even length. Text that fits
 * Latin-1 is written one byte per character; other text as UTF-8 (which parseAiff reads),
 * cut to 255 bytes on a character boundary, rather than turning every such character into "?".
 */
function pstring(text) {
  const s = String(text);
  const latin1 = /^[\x00-\xff]*$/.test(s);
  let t = latin1 ? Uint8Array.from(s.slice(0, 255), (c) => c.charCodeAt(0)) : utf8.encode(s);
  if (t.length > 255) {
    let n = 255;
    while (n > 0 && (t[n] & 0xc0) === 0x80) n--;
    t = t.subarray(0, n);
  }
  const out = new Uint8Array(1 + t.length + ((t.length + 1) & 1));
  out[0] = t.length;
  out.set(t, 1);
  return out;
}

export class AiffWriter {
  constructor({ sampleRate, channels, bitDepth = 16, dither = 'triangular', frames, markers = [], meta = {} }) {
    this.nch = channels;
    this.bitDepth = bitDepth;
    this.float = bitDepth === 32;
    this.quantizer = this.float ? null : new Quantizer(bitDepth, channels, dither);
    const bytes = bitDepth / 8;
    this.dataSize = frames * channels * bytes;
    if (this.dataSize + 1024 > 0xfffffff0) throw new Error('AIFF files are limited to 4 GB. Choose WAV or FLAC for audio this long.');
    this.sink = new ByteSink();
    const aifc = this.float;
    // COMM
    const commBody = new Uint8Array(aifc ? 18 + 4 + 24 : 18);
    const cdv = new DataView(commBody.buffer);
    cdv.setInt16(0, channels);
    cdv.setUint32(2, frames);
    cdv.setInt16(6, bitDepth);
    writeExtended(cdv, 8, sampleRate);
    if (aifc) {
      commBody.set(ascii('fl32'), 18);
      const name = pstring('32-bit floating point');
      commBody.set(name, 22);
    }
    const chunks = [];
    if (aifc) {
      const fver = new Uint8Array(4);
      new DataView(fver.buffer).setUint32(0, 0xa2805140);
      chunks.push(chunk('FVER', fver));
    }
    chunks.push(chunk('COMM', aifc ? commBody.subarray(0, 22 + pstring('32-bit floating point').length) : commBody));
    if (markers.length) {
      const items = markers.slice(0, 65535).map((m, i) => {
        const head = new Uint8Array(6);
        const dv = new DataView(head.buffer);
        dv.setUint16(0, i + 1);
        dv.setUint32(2, Math.min(frames, Math.max(0, Math.round(m.start))));
        return concatBytes([head, pstring(m.name || `Marker ${i + 1}`)]);
      });
      const count = new Uint8Array(2);
      new DataView(count.buffer).setUint16(0, items.length);
      chunks.push(chunk('MARK', concatBytes([count, ...items])));
    }
    chunks.push(...aiffMetaChunks(meta));
    const ssndHead = new Uint8Array(16);
    ssndHead.set(ascii('SSND'));
    new DataView(ssndHead.buffer).setUint32(4, this.dataSize + 8, false);
    const before = concatBytes(chunks);
    const formSize = 4 + before.length + 16 + this.dataSize + (this.dataSize & 1);
    const form = new Uint8Array(12);
    form.set(ascii('FORM'));
    new DataView(form.buffer).setUint32(4, formSize, false);
    form.set(ascii(aifc ? 'AIFC' : 'AIFF'), 8);
    this.sink.push(form);
    this.sink.push(before);
    this.sink.push(ssndHead);
    this.written = 0;
  }

  write(planar, n) {
    this.sink.push(packPcm(planar, n, { bitDepth: this.bitDepth, float: this.float, little: false, quantizer: this.quantizer, unsigned8: false }));
    this.written += n * this.nch * (this.bitDepth / 8);
  }

  finish() {
    if (this.written !== this.dataSize) throw new Error(`AIFF writer received ${this.written} of ${this.dataSize} bytes.`);
    if (this.dataSize & 1) this.sink.push(new Uint8Array(1));
    return new Blob(this.sink.take(), { type: 'audio/aiff' });
  }
}
