// WAV encoding (16 and 24-bit PCM, 32-bit float) and small audio file
// helpers: header reading for tests and checks, format sniffing from the
// first bytes, and file extensions for the formats the browser can decode.
//
//   encodeWav({ channels: Float32Array[], rate }, { bits: 16 | 24 | 32 }) -> ArrayBuffer
//
// 16-bit output gets TPDF dither (two uniform random values, one LSB peak to
// peak each) so quiet tails fade into noise instead of distortion. 24-bit is
// quantized without dither (its noise floor is far below audibility) and
// 32-bit float is written as is.

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;

/**
 * Encodes planar float audio as a RIFF WAVE file.
 * `random` is injectable so tests get repeatable dither.
 */
export function encodeWav({ channels, rate }, { bits = 16, dither = bits === 16, random = Math.random } = {}) {
  if (!channels?.length) throw new Error('No audio to encode.');
  if (![16, 24, 32].includes(bits)) throw new Error('Unsupported bit depth.');
  const numCh = channels.length;
  const frames = channels[0].length;
  const float = bits === 32;
  const bytesPerSample = bits / 8;
  const blockAlign = numCh * bytesPerSample;
  const dataBytes = frames * blockAlign;
  // PCM uses the 16-byte fmt chunk. Float uses the 18-byte form (cbSize 0)
  // plus a fact chunk, as the format specification asks for non-PCM data.
  const fmtSize = float ? 18 : 16;
  const factBytes = float ? 12 : 0;
  const headerBytes = 12 + 8 + fmtSize + factBytes + 8;
  const buf = new ArrayBuffer(headerBytes + dataBytes + (dataBytes & 1));
  const dv = new DataView(buf);
  let o = 0;
  const tag = (s) => {
    for (let i = 0; i < 4; i++) dv.setUint8(o++, s.charCodeAt(i));
  };
  const u32 = (v) => {
    dv.setUint32(o, v, true);
    o += 4;
  };
  const u16 = (v) => {
    dv.setUint16(o, v, true);
    o += 2;
  };
  tag('RIFF');
  u32(buf.byteLength - 8);
  tag('WAVE');
  tag('fmt ');
  u32(fmtSize);
  u16(float ? FORMAT_FLOAT : FORMAT_PCM);
  u16(numCh);
  u32(rate);
  u32(rate * blockAlign);
  u16(blockAlign);
  u16(bits);
  if (float) {
    u16(0);
    tag('fact');
    u32(4);
    u32(frames);
  }
  tag('data');
  u32(dataBytes);

  if (float) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        dv.setFloat32(o, channels[c][i], true);
        o += 4;
      }
    }
  } else if (bits === 16) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = channels[c][i] * 32767;
        if (dither) s += random() - random();
        s = Math.round(s);
        dv.setInt16(o, s < -32768 ? -32768 : s > 32767 ? 32767 : s, true);
        o += 2;
      }
    }
  } else {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.round(channels[c][i] * 8388607);
        if (s < -8388608) s = -8388608;
        else if (s > 8388607) s = 8388607;
        dv.setUint8(o, s & 0xff);
        dv.setUint8(o + 1, (s >> 8) & 0xff);
        dv.setUint8(o + 2, (s >> 16) & 0xff);
        o += 3;
      }
    }
  }
  return buf;
}

export function wavBlob(audio, options) {
  return new Blob([encodeWav(audio, options)], { type: 'audio/wav' });
}

/** Reads a WAVE header: { format, channels, rate, bits, frames, dataOffset, dataBytes } or null. */
export function readWavHeader(buffer) {
  const dv = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
  const str = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (dv.byteLength < 12 || str(0) !== 'RIFF' || str(8) !== 'WAVE') return null;
  let o = 12;
  let fmt = null;
  while (o + 8 <= dv.byteLength) {
    const id = str(o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = { format: dv.getUint16(o + 8, true), channels: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    } else if (id === 'data' && fmt) {
      const blockAlign = (fmt.channels * fmt.bits) / 8;
      return { ...fmt, dataOffset: o + 8, dataBytes: size, frames: Math.floor(size / blockAlign) };
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

/** Decodes the samples of a WAV this module wrote (tests, round trips). */
export function decodeWavSamples(buffer) {
  const hdr = readWavHeader(buffer);
  if (!hdr) throw new Error('Not a WAV file.');
  const dv = new DataView(buffer);
  const channels = Array.from({ length: hdr.channels }, () => new Float32Array(hdr.frames));
  const bps = hdr.bits / 8;
  let o = hdr.dataOffset;
  for (let i = 0; i < hdr.frames; i++) {
    for (let c = 0; c < hdr.channels; c++) {
      let v;
      if (hdr.format === FORMAT_FLOAT) v = dv.getFloat32(o, true);
      else if (hdr.bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (hdr.bits === 24) {
        let s = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
        if (s & 0x800000) s -= 0x1000000;
        v = s / 8388608;
      } else v = (dv.getUint8(o) - 128) / 128;
      channels[c][i] = v;
      o += bps;
    }
  }
  return { channels, rate: hdr.rate };
}

/** Audio container from the first bytes: 'wav' | 'aiff' | 'mp3' | 'ogg' | 'flac' | 'm4a' | 'webm' | null. */
export function sniffAudio(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const s = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length < 12) return null;
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'wav';
  if (s(0, 4) === 'FORM' && (s(8, 4) === 'AIFF' || s(8, 4) === 'AIFC')) return 'aiff';
  if (s(0, 4) === 'OggS') return 'ogg';
  if (s(0, 4) === 'fLaC') return 'flac';
  if (s(4, 4) === 'ftyp') return 'm4a';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

/** File extensions the browser can usually decode. */
export const AUDIO_EXTENSIONS = ['.wav', '.wave', '.mp3', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac', '.aif', '.aiff', '.webm'];

export function isAudioName(name = '') {
  const n = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((e) => n.endsWith(e));
}

/** Extension (without the dot) for a stored sample, from its name or its bytes. */
export function audioExtension(name = '', bytes = null) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name);
  if (m && isAudioName(name)) return m[1].toLowerCase();
  return (bytes && sniffAudio(bytes)) || 'bin';
}
