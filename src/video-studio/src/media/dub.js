/**
 * Dubbing: the timeline's speech in another language. The captions give
 * the words and their timing; each caption is translated, consecutive
 * captions of one sentence are joined into a segment, every segment is
 * spoken with text to speech, and the speech is placed where the segment
 * starts, sped up a little when it would run into the next one.
 */
import { US } from '../lib/time.js';

/** How much a dubbed line may be sped up to fit its slot. */
export const MAX_FIT_SPEED = 1.35;

/**
 * Join caption cues (seconds) into segments to speak: cues closer than
 * maxGap seconds that don't end a sentence carry on, up to maxLength
 * seconds. Returns [{ start, end, cues: [index] }].
 */
export function dubSegments(cues, { maxGap = 0.45, maxLength = 12 } = {}) {
  const out = [];
  let cur = null;
  cues.forEach((c, i) => {
    const sentenceEnded = cur && /[.!?…。！？]["')\]]?\s*$/.test(cues[cur.cues.at(-1)].text);
    if (cur && c.start - cur.end <= maxGap && c.end - cur.start <= maxLength && !sentenceEnded) {
      cur.end = Math.max(cur.end, c.end);
      cur.cues.push(i);
    } else {
      cur = { start: c.start, end: c.end, cues: [i] };
      out.push(cur);
    }
  });
  return out;
}

/** Text of a segment from (translated) cue lines. */
export function segmentText(seg, lines) {
  return seg.cues.map((i) => String(lines[i] || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
}

/**
 * Speed for a line of speech so it ends before `slot` seconds (the time
 * until the next segment): 1 when it fits, at most MAX_FIT_SPEED.
 */
export function fitSpeed(speech, slot, max = MAX_FIT_SPEED) {
  if (!(speech > 0) || !(slot > 0) || speech <= slot) return 1;
  return Math.min(max, Math.round((speech / slot) * 100) / 100);
}

/**
 * Where each segment's speech goes: [{ start, speed }] in microseconds.
 * durations are the speech lengths in seconds, end the timeline end.
 */
export function placeSpeech(segments, durations, end = Infinity) {
  return segments.map((seg, i) => {
    const next = segments[i + 1]?.start ?? Math.max(end, seg.end);
    // Room until the next segment, but never less than the segment itself.
    const slot = Math.max(next - seg.start, seg.end - seg.start);
    return { start: Math.round(seg.start * US), speed: fitSpeed(durations[i], slot) };
  });
}

/**
 * Translate and speak. cues: [{ start, end, text }] in seconds. Returns
 * { lines (translated per cue), segments, speech: [{ text, blob }] }.
 * translate(lines) and speak(text) are injected (Puter AI in the app).
 */
export async function makeDub(cues, { translate, speak, signal, onProgress } = {}) {
  const check = () => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  };
  const lines = await translate(cues.map((c) => c.text));
  check();
  onProgress?.(0.2);
  const segments = dubSegments(cues);
  const speech = [];
  for (let i = 0; i < segments.length; i++) {
    const text = segmentText(segments[i], lines);
    speech.push({ text, blob: text ? await speak(text) : null });
    check();
    onProgress?.(0.2 + (0.8 * (i + 1)) / segments.length);
  }
  return { lines, segments, speech };
}
