// Sample Sound Frequencies: amplitude of a frequency band of a sound at a time (windowed FFT).
// The Sound input names an audio file stored in the project (see importers.ts).
import { gn, prop } from './defs';
import { app } from '../../app/app';
import { soundNow } from '../../sequencer/media';
import { fileBody, packedFile } from './importers';
import { place } from './menu';

export interface DecodedSound {
  channels: Float32Array[];
  rate: number;
}

/** PCM WAV decoder (8/16/24/32-bit integer and 32-bit float); null for other files. */
export function decodeWav(bytes: Uint8Array): DecodedSound | null {
  if (bytes.length < 44) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12;
  let fmt = 0,
    ch = 0,
    rate = 0,
    bits = 0;
  while (o + 8 <= bytes.length) {
    const id = tag(o),
      size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = dv.getUint16(o + 8, true);
      ch = dv.getUint16(o + 10, true);
      rate = dv.getUint32(o + 12, true);
      bits = dv.getUint16(o + 22, true);
      if (fmt === 0xfffe && size >= 26) fmt = dv.getUint16(o + 32, true);
    } else if (id === 'data' && ch) {
      const bps = bits / 8;
      const frames = Math.floor(Math.min(size, bytes.length - o - 8) / (bps * ch));
      const channels = Array.from({ length: ch }, () => new Float32Array(frames));
      let p = o + 8;
      for (let i = 0; i < frames; i++)
        for (let c = 0; c < ch; c++, p += bps) {
          let v = 0;
          if (fmt === 3 && bits === 32) v = dv.getFloat32(p, true);
          else if (bits === 8) v = (bytes[p] - 128) / 128;
          else if (bits === 16) v = dv.getInt16(p, true) / 32768;
          else if (bits === 24) v = (((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8) >> 8) / 8388608;
          else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
          channels[c][i] = v;
        }
      return { channels, rate };
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

const decoded = new WeakMap<Uint8Array, DecodedSound | null>();

/** Decoded samples of an audio file: WAV synchronously, other formats once the browser decoded them. */
export function decodeSound(bytes: Uint8Array, onReady?: () => void): DecodedSound | null | undefined {
  if (decoded.has(bytes)) return decoded.get(bytes);
  const wav = decodeWav(bytes);
  if (wav) {
    decoded.set(bytes, wav);
    return wav;
  }
  let buf: AudioBuffer | null | undefined;
  try {
    buf = soundNow(bytes, onReady);
  } catch {
    buf = null;
  }
  if (buf === undefined) return undefined;
  const r = buf ? { channels: Array.from({ length: buf.numberOfChannels }, (_, c) => buf!.getChannelData(c)), rate: buf.sampleRate } : null;
  decoded.set(bytes, r);
  return r;
}

/** In-place radix-2 FFT of (re, im). */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang),
      wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j,
          b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci,
          xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

export type WindowFunction = 'Hann' | 'Hamming' | 'Blackman' | 'Rectangular';

function windowWeights(kind: WindowFunction, n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / n;
    w[i] = kind === 'Hann' ? 0.5 - 0.5 * Math.cos(x) : kind === 'Hamming' ? 0.54 - 0.46 * Math.cos(x) : kind === 'Blackman' ? 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x) : 1;
  }
  return w;
}

/**
 * Amplitude of the band [low, high] Hz at `time` seconds: magnitudes of a windowed FFT
 * starting at that time, integrated over the band and normalized so a sine wave of
 * amplitude A gives about A.
 */
export function bandAmplitude(s: DecodedSound, time: number, low: number, high: number, size: number, win: WindowFunction, allChannels: boolean, channel: number): number {
  const n = size;
  const w = windowWeights(win, n);
  let wsum = 0;
  for (const x of w) wsum += x;
  const chans = allChannels ? s.channels : s.channels[Math.max(0, Math.min(s.channels.length - 1, channel))] ? [s.channels[Math.max(0, Math.min(s.channels.length - 1, channel))]] : [];
  if (!chans.length || high <= low) return 0;
  const start = Math.round(time * s.rate);
  const mags = new Float64Array(n / 2 + 1);
  const re = new Float64Array(n),
    im = new Float64Array(n);
  for (const data of chans) {
    for (let i = 0; i < n; i++) {
      const k = start + i;
      re[i] = k >= 0 && k < data.length ? data[k] * w[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= n / 2; k++) mags[k] += Math.hypot(re[k], im[k]) / chans.length;
  }
  // bin k covers [k, k + 1) in bin units; partially covered bins count by their overlap
  const b0 = (low * n) / s.rate,
    b1 = (high * n) / s.rate;
  let sum = 0;
  for (let k = Math.max(0, Math.floor(b0)); k <= Math.min(n / 2, Math.ceil(b1)); k++) {
    const ov = Math.min(k + 1, b1) - Math.max(k, b0);
    if (ov > 0) sum += mags[k] * Math.min(1, ov);
  }
  return sum / wsum;
}

const FFT_SIZES = ['128', '256', '512', '1024', '2048', '4096', '8192', '16384', '32768'];
const WINDOWS: WindowFunction[] = ['Hann', 'Hamming', 'Blackman', 'Rectangular'];
const AUDIO = ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.webm'];

let pending = false;
gn(
  'GeometryNodeSampleSoundFrequencies',
  'converter',
  {
    exec: (ctx) => {
      const name = ctx.idRef('Sound');
      const f = name ? packedFile(ctx.env.doc, name) : null;
      if (!f) {
        if (name) ctx.warn(`Sound not found: "${name}"`);
        return { Amplitude: 0 };
      }
      const s = decodeSound(f.bytes, () => {
        // re-evaluate once the browser decoded the file
        if (pending) return;
        pending = true;
        queueMicrotask(() => {
          pending = false;
          app.graph?.invalidate?.();
          app.changed('doc');
        });
      });
      if (!s) {
        if (s === null) ctx.warn('The sound file could not be decoded');
        return { Amplitude: 0 };
      }
      const size = Number(prop(ctx.node, 'FFT Size') ?? 4096) || 4096;
      const win = (String(prop(ctx.node, 'Window Function')) as WindowFunction) || 'Hann';
      return { Amplitude: bandAmplitude(s, ctx.float('Time'), ctx.float('Low'), ctx.float('High'), size, win, ctx.bool('All Channels'), ctx.int('Channel')) };
    },
    sig: (node, env) => {
      const v = node.inputs.Sound;
      const f = typeof v === 'string' ? packedFile(env.doc, v) : null;
      return f ? `${f.id}:${decoded.has(f.bytes) ? 'ready' : 'loading'}` : '-';
    },
  },
  {
    menus: { 'FFT Size': FFT_SIZES.map((x) => [x, x]), 'Window Function': WINDOWS.map((x) => [x, x]) },
    available: (n, s) => (s.identifier === 'Channel' ? n.inputs['All Channels'] === false : true),
    drawBody: fileBody(AUDIO, 'audio/*', 'Sound'),
    bodyHeight: () => 26,
  },
);

place('Utilities/Sound', 'GeometryNodeSampleSoundFrequencies');
