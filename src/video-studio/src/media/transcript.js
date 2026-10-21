/**
 * Transcript helpers for editing video by its words: filler words, long
 * pauses, turning selections of words into time ranges, and AI translation
 * of caption lines. Word times are timeline microseconds.
 */
import { US } from '../lib/time.js';
import { marksForNamed } from '../model/text-marks.js';
import { MIN_CLIP, clipEnd, sourceTimeAt } from '../model/timeline.js';
import { localAtSource, sourceSpan } from '../model/speed-curve.js';
import { audibleClips } from '../engine/scene.js';

// ---- Words that follow their media -----------------------------------------
//
// A transcript word remembers the media it was heard in: asset a, source
// times s..e (µs). Its place on the timeline is worked out from the clips now
// playing that part of the asset, so the transcript stays right through any
// edit (trims, moves, ripple deletes, speed changes), and words whose media
// was cut drop out. start/end keep the timeline times from when it was heard;
// words without an anchor (older projects) are used as they are.

/** Audible clips that can carry speech, base track first. */
function speechClips(project) {
  return audibleClips(project)
    .filter(({ clip }) => !clip.freeze && clip.assetId)
    .sort((x, y) => Number(Boolean(y.track.main)) - Number(Boolean(x.track.main)))
    .map(({ clip }) => clip);
}

/** Anchor timeline words (µs) to the media heard under them in project. */
export function anchorWords(project, words) {
  const clips = speechClips(project);
  return words.map((w) => {
    const mid = (w.start + w.end) / 2;
    const c = clips.find((x) => x.start <= mid && mid < clipEnd(x));
    if (!c) return w;
    return { ...w, a: c.assetId, s: Math.round(sourceTimeAt(c, w.start)), e: Math.round(sourceTimeAt(c, w.end)) };
  });
}

const placeCache = new WeakMap(); // words array -> { key, out }

/**
 * The transcript's words where they now play on the timeline, sorted by
 * time: [{ text, start, end }] in µs. Words whose media is no longer on the
 * timeline are left out; media that plays twice gives its words twice.
 */
export function transcriptWords(project) {
  const words = project?.transcript?.words;
  if (!words?.length) return [];
  if (!words.some((w) => w.a)) return words;
  const clips = speechClips(project);
  const key = clips.map((c) => `${c.assetId}:${c.start}:${c.duration}:${c.in}:${c.speed}:${c.speedCurve ? JSON.stringify(c.speedCurve) : ''}`).join('|');
  const hit = placeCache.get(words);
  if (hit?.key === key) return hit.out;
  const byAsset = new Map();
  for (const c of clips) {
    if (!byAsset.has(c.assetId)) byAsset.set(c.assetId, []);
    byAsset.get(c.assetId).push(c);
  }
  const placed = [];
  for (const w of words) {
    if (!w.a) {
      placed.push({ text: w.text, start: w.start, end: w.end });
      continue;
    }
    const mid = (w.s + w.e) / 2;
    for (const c of byAsset.get(w.a) || []) {
      const span = sourceSpan(c);
      if (mid < c.in || mid >= c.in + span) continue;
      const at = (src) => c.start + Math.round(localAtSource(c, Math.min(span, Math.max(0, src - c.in))));
      const start = at(w.s);
      placed.push({ text: w.text, start, end: Math.max(start, at(w.e)), a: w.a, s: w.s });
    }
  }
  placed.sort((x, y) => x.start - y.start);
  // The same words heard twice at once (two copies of a clip) show once.
  const out = [];
  for (const w of placed) {
    let dup = false;
    for (let i = out.length - 1; w.a && !dup && i >= 0 && out[i].start > w.start - MIN_CLIP; i--) dup = out[i].a === w.a && out[i].s === w.s;
    if (!dup) out.push(w);
  }
  const clean = out.map(({ text, start, end }) => ({ text, start, end }));
  placeCache.set(words, { key, out: clean });
  return clean;
}

/**
 * Hesitation sounds per language (lowercase, without punctuation). Only
 * sounds that are never real words in that language, since they are cut.
 */
export const FILLERS = {
  en: ['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mhm', 'eh'],
  es: ['eh', 'em', 'mmm'],
  fr: ['euh', 'heu', 'bah', 'hum'],
  de: ['äh', 'ähm', 'öh', 'hm', 'hmm'],
  it: ['ehm', 'eh', 'mmm'],
  pt: ['hum', 'ahn'],
};

/** Hesitations that are not words in any language above: used for every language. */
const COMMON_FILLERS = ['uh', 'uhh', 'uhm', 'umm', 'erm', 'hmm', 'hm', 'mm', 'mhm'];

/** Words that are also fillers in some sentences; only removed when asked. */
export const SOFT_FILLERS = {
  en: ['like', 'you know', 'i mean', 'sort of', 'kind of', 'basically', 'actually', 'literally'],
  es: ['este', 'pues'],
  fr: ['ben'],
  it: ['cioè'],
  pt: ['tipo'],
};

const clean = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}'\s]+/gu, '').trim();

// Common English words that are not words in the other languages above.
const ENGLISH = new Set(['the', 'and', 'is', 'to', 'of', 'you', 'that', 'it', 'this', 'we', 'what', 'for', 'with', 'are', 'have', 'they', 'be', 'not', 'just', 'my']);

/** Whether a transcript in an unknown language reads as English. */
function looksEnglish(words) {
  const n = Math.min(words.length, 500);
  let hits = 0;
  for (let i = 0; i < n; i++) if (ENGLISH.has(clean(words[i].text))) hits++;
  return n > 0 && hits / n >= 0.15;
}

/**
 * Indices of filler words (and multi-word soft fillers when soft is on).
 * language 'auto' uses English fillers only when the words read as English.
 */
export function findFillers(words, { language = 'en', soft = false } = {}) {
  const lang = language === 'auto' ? (looksEnglish(words) ? 'en' : null) : FILLERS[language] ? language : null;
  const hard = new Set([...COMMON_FILLERS, ...(lang ? FILLERS[lang] : [])]);
  const phrases = soft && lang ? (SOFT_FILLERS[lang] || []).map((p) => p.split(' ')) : [];
  const out = new Set();
  for (let i = 0; i < words.length; i++) {
    const w = clean(words[i].text);
    if (hard.has(w)) out.add(i);
    for (const p of phrases) {
      if (p.every((part, k) => clean(words[i + k]?.text || '') === part)) for (let k = 0; k < p.length; k++) out.add(i + k);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Silences between words longer than minGap (µs), shortened so pad (µs) of
 * breathing room stays on each side. Returns [{ start, end }].
 */
export function findPauses(words, { minGap = 1.2 * US, pad = 0.2 * US } = {}) {
  const out = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1].end + pad;
    const b = words[i].start - pad;
    if (words[i].start - words[i - 1].end >= minGap && b - a > 0) out.push({ start: Math.round(a), end: Math.round(b) });
  }
  return out;
}

/**
 * Time ranges covering the given word indices, merged where they touch.
 * Each range reaches into the silence around its words (up to half the gap,
 * at most pad) so cuts land between words rather than on them.
 */
export function rangesForWords(words, indices, { pad = 0.06 * US } = {}) {
  const sorted = [...new Set(indices)].filter((i) => words[i]).sort((a, b) => a - b);
  const ranges = [];
  for (const i of sorted) {
    const w = words[i];
    const prevEnd = words[i - 1]?.end ?? -Infinity;
    const nextStart = words[i + 1]?.start ?? Infinity;
    const start = Math.max(0, Math.round(Math.max(w.start - pad, (w.start + prevEnd) / 2)));
    const end = Math.round(Math.min(w.end + pad, (w.end + nextStart) / 2));
    const last = ranges.at(-1);
    if (last && start <= last.end + 1000) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

/** Merge overlapping ranges and sort them from last to first (safe removal order). */
export function removalOrder(ranges) {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of sorted) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.reverse();
}

/** Index of the word playing at time t, or -1. */
export function wordAt(words, t) {
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < words[mid].start) hi = mid - 1;
    else if (t >= words[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Plain text of the transcript with paragraph breaks at long pauses. */
export function transcriptText(words, { paragraphGap = 2 * US } = {}) {
  let out = '';
  words.forEach((w, i) => {
    if (i > 0) out += w.start - words[i - 1].end >= paragraphGap ? '\n\n' : ' ';
    out += w.text;
  });
  return out;
}

// ---- Translation ------------------------------------------------------------

/** Pull a JSON array of strings out of a chat reply (tolerates code fences and chatter). */
export function parseJsonArray(reply, expected) {
  const text = typeof reply === 'string' ? reply : reply?.message?.content?.[0]?.text ?? reply?.message?.content ?? reply?.text ?? String(reply ?? '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('The translation came back in an unexpected form.');
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('The translation came back in an unexpected form.');
  const out = arr.map((x) => String(x ?? ''));
  if (expected !== undefined && out.length !== expected) throw new Error('The translation did not match the captions one to one.');
  return out;
}

/**
 * Translate lines with Puter AI chat, in batches, keeping order and count.
 * chat is injectable for tests.
 */
export async function translateLines(lines, language, { chat = (p) => puter.ai.chat(p), batch = 40, signal, onProgress } = {}) {
  const out = [];
  for (let i = 0; i < lines.length; i += batch) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const part = lines.slice(i, i + batch);
    const prompt = [
      `Translate each caption line in this JSON array into ${language}.`,
      'Keep the meaning and tone natural for subtitles, keep each line about as short as the original, and keep line breaks inside a line.',
      'Reply with only a JSON array of strings with exactly the same number of items, in the same order.',
      JSON.stringify(part),
    ].join('\n');
    const reply = await chat(prompt);
    out.push(...parseJsonArray(reply, part.length));
    onProgress?.(Math.min(1, (i + part.length) / lines.length));
  }
  return out;
}

/**
 * Key words per caption line (word indexes, see model/text-marks.js), via
 * Puter AI chat: the words a viewer should notice, at most a few per line.
 */
export async function keywordsForLines(lines, { chat = (p) => puter.ai.chat(p), batch = 60 } = {}) {
  const out = [];
  for (let i = 0; i < lines.length; i += batch) {
    const part = lines.slice(i, i + batch);
    const prompt = [
      'For each caption line in this JSON array, pick the one or two words that carry the point (names, numbers, strong verbs or nouns). Pick none for lines without one.',
      'Copy the words exactly as they appear in the line. Reply with only a JSON array with exactly the same number of items, in the same order, where each item is an array of strings.',
      JSON.stringify(part),
    ].join('\n');
    const reply = await chat(prompt);
    const text = typeof reply === 'string' ? reply : reply?.message?.content?.[0]?.text ?? reply?.message?.content ?? reply?.text ?? String(reply ?? '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    let arr = null;
    try {
      arr = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null;
    } catch {
      arr = null;
    }
    if (!Array.isArray(arr) || arr.length !== part.length) throw new Error('The key words came back in an unexpected form.');
    out.push(...part.map((line, j) => marksForNamed(line, Array.isArray(arr[j]) ? arr[j] : [arr[j]], 2)));
  }
  return out;
}

/** One emoji (or '') per caption line that fits its mood, via Puter AI chat. */
export async function emojiForLines(lines, { chat = (p) => puter.ai.chat(p), batch = 60 } = {}) {
  const out = [];
  for (let i = 0; i < lines.length; i += batch) {
    const part = lines.slice(i, i + batch);
    const prompt = [
      'For each caption line in this JSON array, choose one emoji that fits it, or an empty string when none fits well. Use emoji for at most about half of the lines.',
      'Reply with only a JSON array of strings with exactly the same number of items, in the same order.',
      JSON.stringify(part),
    ].join('\n');
    const reply = await chat(prompt);
    out.push(...parseJsonArray(reply, part.length).map((e) => e.trim().slice(0, 8)));
  }
  return out;
}
