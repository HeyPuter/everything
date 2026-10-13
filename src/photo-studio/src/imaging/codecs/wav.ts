// WAV (RIFF WAVE) audio: 16-bit PCM writer and a reader for 16-bit, 24-bit,
// 32-bit integer and 32-bit float PCM, following the RIFF/WAVE format
// description (little-endian chunks "fmt " and "data").
import { CodecError } from './bytes';

/** Interleave planar float channels into a 16-bit PCM WAV file. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const ch = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * ch * 2;
  if (44 + dataBytes > 0xffffffff) throw new CodecError('The audio is too long for a WAV file.');
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, ch, true);
  v.setUint32(24, Math.round(sampleRate), true);
  v.setUint32(28, Math.round(sampleRate) * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0));
      v.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
      o += 2;
    }
  return out;
}

/** Read a PCM or float WAV file into planar float channels. */
export function decodeWav(bytes: Uint8Array): { sampleRate: number; channels: Float32Array[] } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new CodecError('Not a WAV file.');
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  let p = 12;
  while (p + 8 <= bytes.length) {
    const id = tag(p),
      size = v.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE names the format in its sub-format GUID.
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true);
      fmt = { format, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt || !fmt.channels) throw new CodecError('The WAV file has no format chunk.');
      const { channels: ch, bits, format } = fmt;
      if (format !== 1 && format !== 3) throw new CodecError('Unsupported WAV sample format.');
      const width = bits / 8;
      const frames = Math.floor(Math.min(size, bytes.length - body) / (width * ch));
      const out = Array.from({ length: ch }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++)
        for (let c = 0; c < ch; c++) {
          const at = body + (i * ch + c) * width;
          let s: number;
          if (format === 3 && bits === 32) s = v.getFloat32(at, true);
          else if (bits === 16) s = v.getInt16(at, true) / 0x8000;
          else if (bits === 24) s = ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) << 8 >> 8) / 0x800000;
          else if (bits === 32) s = v.getInt32(at, true) / 0x80000000;
          else if (bits === 8) s = (bytes[at] - 128) / 128;
          else throw new CodecError('Unsupported WAV sample format.');
          out[c][i] = s;
        }
      return { sampleRate: fmt.rate, channels: out };
    }
    p = body + size + (size & 1);
  }
  throw new CodecError('The WAV file has no audio data.');
}
