/**
 * Lyrics from a song: decode one music clip, isolate the singing with the
 * voice and music separator (audio-fx.js), transcribe it with the caption
 * speech to text (transcribe.js), and break the words into lines at the
 * song's phrasing: breaths between words, sentence ends and the bars of the
 * beat grid (audio-analysis.js), so a line tends to start on a downbeat.
 *
 * Every step is injectable (decode, separate, transcribe, beats) so tests
 * and the signed-out preview never touch Puter. Times out of this module
 * are timeline seconds (the clip's speed and in point applied).
 */
import { US } from '../lib/time.js';
import { Separator } from './audio-fx.js';
import { decodeClipSound, downmix, detectBeats } from './audio-analysis.js';
import { STT_RATE, transcribeMix, joinWords } from './transcribe.js';
import { localAtSource } from '../model/speed-curve.js';

/** Caption look lyrics get (a karaoke sweep through each line). */
export const LYRIC_STYLE = 'pop-sweep';
/** Longest stretch of a song that is listened to. */
export const MAX_SONG_SECONDS = 600;

const SENTENCE_END = /[.!?。！？…]["'’”)]*$/;

/** Clips whose sound can be turned into lyrics: audio clips, and video clips with sound. */
export function songClips(project) {
  const out = [];
  for (const t of project.tracks) {
    for (const c of t.clips) {
      const asset = project.assets[c.assetId];
      if (!asset || c.freeze) continue;
      if (c.type === 'audio' || (c.type === 'video' && asset.hasAudio && !c.audioDetached)) out.push({ clip: c, track: t, asset });
    }
  }
  // Music tracks first (a song is usually an audio clip), then by time.
  return out.sort((a, b) => (a.clip.type === 'audio' ? 0 : 1) - (b.clip.type === 'audio' ? 0 : 1) || a.clip.start - b.clip.start);
}

/** Resample one channel (box filter when going down, then linear interpolation). */
export function resample(x, from, to) {
  if (from === to) return Float32Array.from(x);
  const ratio = from / to;
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  const half = Math.max(0, Math.floor(ratio / 2));
  for (let j = 0; j < n; j++) {
    const c = j * ratio;
    if (half) {
      const a = Math.max(0, Math.round(c) - half);
      const b = Math.min(x.length, Math.round(c) + half + 1);
      let s = 0;
      for (let i = a; i < b; i++) s += x[i];
      out[j] = s / Math.max(1, b - a);
    } else {
      const i = Math.floor(c);
      const f = c - i;
      out[j] = i + 1 < x.length ? x[i] + (x[i + 1] - x[i]) * f : x[i] || 0;
    }
  }
  return out;
}

/**
 * The singing of a song as mono: the separator in voice mode at full
 * strength over both channels (a mono song gives the same channel twice,
 * where only the voice band is kept), with its latency taken out.
 */
export function isolateVocals(channels, sr, { amount = 100 } = {}) {
  const n = channels[0]?.length || 0;
  const s = new Separator(sr, { mode: 'voice', amount });
  const lat = s.latency;
  const L = new Float32Array(n + lat);
  const R = new Float32Array(n + lat);
  L.set(channels[0]);
  R.set(channels[1] || channels[0]);
  const B = 512;
  for (let i = 0; i < L.length; i += B) {
    const m = Math.min(B, L.length - i);
    s.process(L.subarray(i, i + m), R.subarray(i, i + m), m);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (L[i + lat] + R[i + lat]) / 2;
  return out;
}

/** Bar starts from beat times: every fourth beat, phased to the beat most words start on. */
export function barTimes(beats, words = []) {
  if (!beats || beats.length < 4) return [];
  let best = 0;
  let bestScore = -1;
  for (let phase = 0; phase < 4; phase++) {
    let score = 0;
    for (let i = phase; i < beats.length; i += 4) if (words.some((w) => Math.abs(w.start - beats[i]) < 0.12)) score++;
    if (score > bestScore) {
      best = phase;
      bestScore = score;
    }
  }
  const out = [];
  for (let i = best; i < beats.length; i += 4) out.push(beats[i]);
  return out;
}

const near = (list, t, tol) => list.some((b) => Math.abs(b - t) <= tol);

/** Lyric text for a line: words joined, trailing commas and periods dropped. */
function lineText(words) {
  return joinWords(words.map((w) => w.text)).replace(/[,.;:、，。]+$/u, '');
}

/**
 * Break timed words [{ text, start, end }] (seconds) into lyric lines at
 * musical phrasing:
 *  - a breath (a gap of at least pause seconds) always ends a line
 *  - a sentence end ends a line
 *  - with beats, a word starting on a bar line starts a new line once the
 *    current one has minWords
 *  - a full line (maxWords or maxChars) splits at the best point in its
 *    second half: the widest gap, favoring a split on a beat
 * Each line stays up to hold seconds past its last word (never into the
 * next). Returns [{ start, end, text }].
 */
export function lyricLines(words, { beats = [], maxWords = 8, maxChars = 36, minWords = 3, pause = 0.45, hold = 0.6 } = {}) {
  const list = (words || [])
    .map((w) => ({ text: String(w.text ?? '').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start);
  const bars = barTimes(beats, list);
  const groups = [];
  let cur = [];
  const fullWith = (w) => cur.length + 1 > maxWords || joinWords([...cur, w].map((x) => x.text)).length > maxChars;
  for (const w of list) {
    if (w.end < w.start) w.end = w.start;
    if (cur.length) {
      const last = cur.at(-1);
      const gap = w.start - last.end;
      const onBar = bars.length && cur.length >= minWords && near(bars, w.start, 0.1);
      if (gap >= pause || SENTENCE_END.test(last.text) || onBar) {
        groups.push(cur);
        cur = [];
      } else if (fullWith(w)) {
        // Split where the singer leaves the most room, preferring a beat.
        const from = Math.max(1, Math.ceil(cur.length / 2));
        let best = cur.length;
        let bestScore = -Infinity;
        for (let k = from; k <= cur.length; k++) {
          const next = k < cur.length ? cur[k] : w;
          const score = next.start - cur[k - 1].end + (near(beats, next.start, 0.08) ? 0.15 : 0);
          if (score > bestScore) {
            best = k;
            bestScore = score;
          }
        }
        groups.push(cur.slice(0, best));
        cur = cur.slice(best);
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => {
    const next = groups[i + 1]?.[0].start ?? Infinity;
    const end = g.at(-1).end;
    return { start: g[0].start, end: Math.max(end, Math.min(end + hold, next - 0.05)), text: lineText(g) };
  }).filter((l) => l.text);
}

function abortError() {
  return new DOMException('Cancelled', 'AbortError');
}

/** Timeline seconds for seconds into a clip's decoded source range. */
function toTimeline(clip, sec) {
  return (clip.start + localAtSource(clip, sec * US)) / US;
}

/**
 * Lyric lines for a song clip: { cues, isolated, words }.
 *  isolate     separate the singing first (default on)
 *  onStep      (step, fraction) with step 'decode' | 'isolate' | 'transcribe' | 'phrase'
 *  decode      (asset, clip, { maxSeconds, signal, onProgress }) => { sampleRate, channels }
 *  separate    (channels, sampleRate) => mono vocals
 *  transcribe  (mono, sampleRate, { language, signal, onProgress }) => timed words (seconds)
 *  beats       (mono, sampleRate) => { beats: [seconds] } | null
 */
export async function lyricsFromClip(project, clipId, {
  library, language = 'auto', isolate = true, signal, onStep,
  decode = null, separate = isolateVocals, transcribe = transcribeMix, beats = detectBeats,
} = {}) {
  const found = songClips(project).find((s) => s.clip.id === clipId);
  if (!found) throw new Error('Pick a song clip with sound.');
  const { clip, asset } = found;
  const step = (s, f = 0) => onStep?.(s, f);
  step('decode');
  const read = decode || (async (a, c, o) => {
    const { mediabunnyOpener } = await import('../engine/audio-mix.js');
    return decodeClipSound(mediabunnyOpener(library), a, c, o);
  });
  const snd = await read(asset, clip, { maxSeconds: MAX_SONG_SECONDS, signal, onProgress: (f) => step('decode', f) });
  if (signal?.aborted) throw abortError();
  if (!snd?.channels?.length || !snd.channels[0].length) throw new Error("This clip's sound couldn't be read.");
  // Speech services and the separator both work at 16 kHz; it keeps everything small.
  const channels = snd.channels.slice(0, 2).map((ch) => resample(ch, snd.sampleRate, STT_RATE));
  const full = downmix(channels);
  let voice = full;
  let isolated = false;
  if (isolate) {
    step('isolate');
    await new Promise((r) => setTimeout(r, 0));
    voice = separate(channels, STT_RATE);
    isolated = true;
  }
  if (signal?.aborted) throw abortError();
  step('transcribe');
  const words = await transcribe(voice, STT_RATE, { language, signal, onProgress: (f) => step('transcribe', f) });
  if (signal?.aborted) throw abortError();
  step('phrase');
  const grid = beats(full, STT_RATE)?.beats || [];
  const end = (clip.start + clip.duration) / US;
  const toT = (w) => ({ text: w.text, start: toTimeline(clip, w.start), end: toTimeline(clip, w.end) });
  const timed = words.map(toT).filter((w) => w.start < end - 0.05);
  const beatT = grid.map((b) => toTimeline(clip, b)).filter((b) => b <= end);
  const cues = lyricLines(timed, { beats: beatT }).map((c) => ({ ...c, end: Math.min(c.end, end) }));
  return { cues, isolated, words: timed.length };
}
