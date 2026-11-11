/**
 * Extract audio: the sound of a video clip as a WAV file of its own, for
 * the media library. The timeline is not touched.
 */
import { sourceRange } from '../model/audio.js';
import { wavHeader, writePcm16 } from './wav.js';

/** Samples per piece of the file being written (2 MB). */
const PIECE = 1 << 20;

/** File name for a clip's extracted sound: "<name> audio.wav", without the video's extension. */
export function extractedName(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim() || 'Clip';
  return `${base.slice(0, 100)} audio.wav`;
}

/**
 * Decode the source range the clip plays and encode it as 16-bit WAV.
 * Returns { file, seconds } or null when there is no sound. The range is
 * read at normal speed: a sped-up or slowed-down clip gives the sound of
 * the source it covers, not retimed, and volume, fades and audio effects
 * are not applied (the file is the clean source sound).
 * Each decoded piece is written out as 16-bit samples right away, so an
 * hour-long recording needs about the WAV's size in memory, not four times it.
 * open: asset => source (audio-mix mediabunnyOpener(library) or a test stub).
 */
export async function extractClipAudio(open, asset, clip, { name, signal, onProgress, maxSeconds = 3 * 3600 } = {}) {
  const src = await open(asset);
  if (!src) return null;
  const [from, to0] = sourceRange(clip);
  const to = Math.min(to0, from + maxSeconds);
  const parts = [];
  let piece = null;
  let used = 0;
  let rate = 0;
  let numCh = 0;
  let frames = 0;
  /** Append frames [a, b) of a decoded chunk to the pieces of the file. */
  const write = (channels, a, b) => {
    while (a < b) {
      piece ||= new Int16Array(PIECE - (PIECE % numCh));
      const k = Math.min(b - a, (piece.length - used) / numCh);
      used = writePcm16(piece, used, channels, a, a + k, numCh);
      a += k;
      if (used === piece.length) {
        parts.push(piece);
        piece = null;
        used = 0;
      }
    }
  };
  try {
    for await (const chunk of src.read(from)) {
      if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
      const n = chunk.channels[0]?.length || 0;
      if (!n) continue;
      if (!numCh) {
        rate = chunk.sampleRate;
        numCh = Math.min(2, chunk.channels.length);
      }
      const t0 = chunk.timestamp;
      const t1 = t0 + n / chunk.sampleRate;
      if (t1 <= from) continue;
      const a = Math.max(0, Math.round((from - t0) * chunk.sampleRate));
      const b = Math.min(n, Math.round((to - t0) * chunk.sampleRate));
      if (b > a) {
        write(chunk.channels, a, b);
        frames += b - a;
      }
      onProgress?.(Math.min(1, (t1 - from) / Math.max(1e-6, to - from)));
      if (t1 >= to) break;
    }
  } finally {
    src.close?.();
  }
  if (!frames) return null;
  if (used) parts.push(piece.subarray(0, used));
  const file = new File([wavHeader(frames, numCh, rate), ...parts], extractedName(name ?? clip.name ?? asset.name), { type: 'audio/wav' });
  return { file, seconds: frames / rate };
}
