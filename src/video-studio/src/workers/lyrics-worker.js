/**
 * The slow sound math of lyrics (media/lyrics.js) off the main thread:
 * separating the singing and finding the beat of a whole song take
 * seconds each.
 *
 * Messages in:  { op: 'isolate', channels: [Float32Array], sr }
 *               { op: 'beats', mono: Float32Array, sr }
 * Messages out: { progress } while isolating, then { ok, result } | { ok: false, error }
 */
import { isolateVocals } from '../media/vocals.js';
import { detectBeats } from '../media/audio-analysis.js';

self.onmessage = (e) => {
  const msg = e.data || {};
  try {
    if (msg.op === 'isolate') {
      const result = isolateVocals(msg.channels, msg.sr, { onProgress: (progress) => self.postMessage({ progress }) });
      self.postMessage({ ok: true, result }, [result.buffer]);
    } else {
      self.postMessage({ ok: true, result: detectBeats(msg.mono, msg.sr) });
    }
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};
