// Audio helpers without DOM dependencies: sound strip timing and WAV encoding (unit tested).
import type { Strip } from './types';
import { finalStart, finalEnd } from './strips';

export interface SoundSegment {
  /** seconds from the timeline position `from` until the sound starts */
  delay: number;
  /** seconds into the source file */
  offset: number;
  /** seconds to play */
  duration: number;
}

/**
 * Which part of a sound strip plays when playback starts at timeline frame `from`:
 * the strip's visible range is [frame_final_start, frame_final_end); the content frame 0 maps to
 * second `sound_offset` + animation_offset_start / fps of the file.
 */
export function soundSegment(s: Strip, fps: number, from: number, to = Infinity): SoundSegment | null {
  const a = Math.max(finalStart(s), from);
  const b = Math.min(finalEnd(s), to);
  if (b <= a) return null;
  const contentStart = (s.animation_offset_start + (a - s.frame_start)) / fps + (s.sound_offset ?? 0);
  return { delay: (a - from) / fps, offset: Math.max(0, contentStart), duration: (b - a) / fps };
}

/** Constant-power-free linear pan used by the mixer: -1 left … 1 right. */
export function panGains(pan: number): [number, number] {
  const p = Math.max(-1, Math.min(1, pan));
  return [p > 0 ? 1 - p : 1, p < 0 ? 1 + p : 1];
}

export type WavFormat = 'U8' | 'S16' | 'S24' | 'S32' | 'F32';

/** Encode planar float channels as a RIFF/WAVE file. */
export function encodeWav(channels: Float32Array[], rate: number, format: WavFormat = 'S16'): Uint8Array {
  const nch = channels.length;
  const n = channels[0]?.length ?? 0;
  const bytes = format === 'U8' ? 1 : format === 'S16' ? 2 : format === 'S24' ? 3 : 4;
  const dataLen = n * nch * bytes;
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, format === 'F32' ? 3 : 1, true);
  dv.setUint16(22, nch, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * nch * bytes, true);
  dv.setUint16(32, nch * bytes, true);
  dv.setUint16(34, bytes * 8, true);
  str(36, 'data');
  dv.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < nch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      switch (format) {
        case 'U8':
          out[o] = Math.round((v + 1) * 127.5);
          break;
        case 'S16':
          dv.setInt16(o, Math.round(v < 0 ? v * 32768 : v * 32767), true);
          break;
        case 'S24': {
          const x = Math.round(v < 0 ? v * 8388608 : v * 8388607);
          out[o] = x & 0xff;
          out[o + 1] = (x >> 8) & 0xff;
          out[o + 2] = (x >> 16) & 0xff;
          break;
        }
        case 'S32':
          dv.setInt32(o, Math.round(v < 0 ? v * 2147483648 : v * 2147483647), true);
          break;
        case 'F32':
          dv.setFloat32(o, channels[c][i], true);
          break;
      }
      o += bytes;
    }
  return out;
}

/** Min/max peaks of a signal in `buckets` slices (waveform display). */
export function peaks(data: Float32Array, buckets: number): Float32Array {
  return mixPeaks([data], buckets);
}

/** Min/max peaks of the mono mix of channels (mixed on the fly: no mono copy of the whole sound). */
export function mixPeaks(channels: Float32Array[], buckets: number): Float32Array {
  const out = new Float32Array(buckets * 2);
  const n = channels[0]?.length ?? 0;
  const k = 1 / Math.max(1, channels.length);
  const [c0, c1] = channels;
  const per = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per),
      e = Math.min(n, Math.max(s + 1, Math.floor((b + 1) * per)));
    let lo = 0,
      hi = 0;
    for (let i = s; i < e; i++) {
      let v: number;
      if (channels.length === 1) v = c0[i];
      else if (channels.length === 2) v = (c0[i] + c1[i]) * k;
      else {
        v = 0;
        for (const c of channels) v += c[i];
        v *= k;
      }
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
}
