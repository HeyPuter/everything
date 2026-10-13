// Decoded sound for the timeline (loaded on first use): audio files and the
// sound of footage are decoded with Web Audio at the mixing rate, kept in a
// memory-bounded cache by asset, and summarized as waveform peaks.
import type { DocumentSession } from '../../app/session';
import { sourceMimeType } from '../../model/embedded';
import { audioFileLimit, maxAudioSeconds, type AudioSource } from '../../model/audio-timeline';
import { computePeaks, type Peaks } from '../../imaging/audio/peaks';
import type { Pcm } from '../../imaging/audio/mix';

/** Every source is decoded (and resampled) to this rate. */
export const mixRate = 48000;
type Entry = { pcm: Pcm; peaks?: Peaks; bytes: number };
const decoded = new Map<string, Entry>();
const pending = new Map<string, Promise<Pcm>>();
const failed = new Set<string>();
let used = 0;
const budget = 1024 * 1024 * 1024;
const listeners = new Set<() => void>();
/** Called when a source finished decoding (waveforms can be drawn). */
export function onAudioDecoded(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function remember(asset: string, pcm: Pcm) {
  const bytes = pcm.channels.reduce((n, c) => n + c.byteLength, 0);
  const old = decoded.get(asset);
  if (old) used -= old.bytes;
  decoded.delete(asset);
  decoded.set(asset, { pcm, bytes });
  used += bytes;
  // Least recently used first.
  for (const [k, v] of decoded) {
    if (used <= budget || decoded.size <= 1) break;
    decoded.delete(k);
    used -= v.bytes;
  }
}
/** Decode an encoded file (any format the browser's audio decoder reads). */
export async function decodeAudioBytes(data: ArrayBuffer): Promise<Pcm> {
  const ctx = new OfflineAudioContext(1, 1, mixRate);
  const buffer = await ctx.decodeAudioData(data);
  return { sampleRate: buffer.sampleRate, channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)) };
}

/** The decoded sound of a source when it is ready. */
export function audioPcm(source: AudioSource): Pcm | undefined {
  const hit = decoded.get(source.asset);
  if (!hit) return undefined;
  // Most recently used last.
  decoded.delete(source.asset);
  decoded.set(source.asset, hit);
  return hit.pcm;
}
/** Decode a source from the session's assets (cached). */
export function loadAudio(s: DocumentSession, source: AudioSource): Promise<Pcm> {
  const hit = audioPcm(source);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(source.asset);
  if (!p) {
    p = (async () => {
      try {
        const pcm = await decodeAudioBytes(await s.assets.blob(source.asset).arrayBuffer());
        remember(source.asset, pcm);
        failed.delete(source.asset);
        return pcm;
      } catch (error) {
        failed.add(source.asset);
        throw error;
      } finally {
        pending.delete(source.asset);
        listeners.forEach((fn) => fn());
      }
    })();
    pending.set(source.asset, p);
  }
  return p;
}
/** Decode every source a list of sources needs; missing ones stay silent. */
export async function loadAll(s: DocumentSession, sources: AudioSource[]) {
  await Promise.all(sources.map((src) => loadAudio(s, src).catch(() => undefined)));
}
export const audioFailed = (source: AudioSource) => failed.has(source.asset);

/** Waveform peaks of a source; starts decoding and returns undefined until ready. */
export function audioPeaks(s: DocumentSession, source: AudioSource): Peaks | undefined {
  const entry = decoded.get(source.asset);
  if (!entry) {
    if (!failed.has(source.asset) && s.assets.has(source.asset)) void loadAudio(s, source).catch(() => {});
    return undefined;
  }
  return (entry.peaks ??= computePeaks(entry.pcm.channels, entry.pcm.sampleRate));
}

/** Store an audio file in the session's assets. */
export async function addAudioFile(s: DocumentSession, file: Blob, name: string): Promise<AudioSource> {
  if (file.size > audioFileLimit) throw new Error('Audio files are limited to 256 MB.');
  let pcm: Pcm;
  try {
    pcm = await decodeAudioBytes(await file.arrayBuffer());
  } catch {
    throw new Error(`This browser cannot decode the audio in ${name}.`);
  }
  const source = describe(pcm, name, file.type || guessType(name), '');
  if (!source) throw new Error(`${name} contains no sound.`);
  source.asset = await s.assets.add(new Blob([file], { type: sourceMimeType }));
  remember(source.asset, pcm);
  return source;
}
/** The sound of a footage file already stored as `asset`, or undefined when
 * it has none (or the browser cannot decode it). */
export async function footageSound(file: Blob, name: string, type: string, asset: string): Promise<AudioSource | undefined> {
  if (file.size > audioFileLimit * 2) return undefined;
  try {
    const pcm = await decodeAudioBytes(await file.arrayBuffer());
    const source = describe(pcm, name, type, asset);
    if (source) remember(asset, pcm);
    return source;
  } catch {
    return undefined;
  }
}
function describe(pcm: Pcm, name: string, type: string, asset: string): AudioSource | undefined {
  const length = pcm.channels[0]?.length ?? 0;
  if (!length) return undefined;
  const seconds = length / pcm.sampleRate;
  if (seconds > maxAudioSeconds) throw new Error('Audio is limited to four hours.');
  return { asset, name, type, seconds, channels: Math.min(32, pcm.channels.length), sampleRate: pcm.sampleRate };
}
const guessType = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ({ wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm' } as Record<string, string>)[ext] ?? 'application/octet-stream';
};
/** Drop every decoded source (Purge Video Cache). */
export function purgeAudioCache() {
  decoded.clear();
  failed.clear();
  used = 0;
}
