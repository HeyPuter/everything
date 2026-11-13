/**
 * Find highlights: show Puter AI the transcript of a long video as numbered
 * lines, let it pick the most engaging self-contained moments, check every
 * number it sends back, and turn the chosen moments into short clips with
 * captions (a new project each, or compound clips in the open project).
 *
 * Words here are clip-local: { text, start, end } in microseconds from the
 * start of the source clip on the timeline.
 */
import { US } from '../lib/time.js';
import { uid } from '../lib/ids.js';
import { makeClip, makeTrack, createProject, RATIOS } from '../model/project.js';
import { TEXT_PRESETS } from '../model/catalog.js';
import { MIN_CLIP } from '../model/timeline.js';
import { trimTo } from '../model/slice.js';
import { groupWords, buildCaptionClips, lineCharsFor, joinWords } from './transcribe.js';
import { extractJson, chatText } from './script-video.js';

export const HIGHLIGHT_COUNTS = [3, 5, 8];

export const HIGHLIGHT_LENGTHS = [
  { id: 'short', label: '15 to 30 seconds', min: 15, max: 30 },
  { id: 'medium', label: '30 to 60 seconds', min: 30, max: 60 },
  { id: 'long', label: '60 to 90 seconds', min: 60, max: 90 },
];

/** Most words shown to the model; longer transcripts are cut (about an hour of speech). */
export const PROMPT_WORDS = 9000;

const SENTENCE_END = /[.!?。！？…]["'’”)]*$/;

/**
 * Transcript lines for the prompt: words grouped at sentence ends, long
 * pauses or maxWords. Returns [{ first, last, text, start }] (word indexes).
 */
export function transcriptLines(words, { maxWords = 22, pause = 1.2 * US, limit = PROMPT_WORDS } = {}) {
  const lines = [];
  const n = Math.min(words.length, limit);
  let first = 0;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const end = last
      || SENTENCE_END.test(words[i].text)
      || i - first + 1 >= maxWords
      || words[i + 1].start - words[i].end >= pause;
    if (end) {
      lines.push({ first, last: i, start: words[first].start, text: joinWords(words.slice(first, i + 1).map((w) => w.text)) });
      first = i + 1;
    }
  }
  return lines;
}

function clockLabel(t) {
  const s = Math.max(0, Math.floor(t / US));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The chat prompt that asks for highlights as strict JSON. */
export function highlightsPrompt(words, { count = 5, length = 'short' } = {}) {
  const len = HIGHLIGHT_LENGTHS.find((l) => l.id === length) || HIGHLIGHT_LENGTHS[0];
  const lines = transcriptLines(words);
  return [
    `Below is the transcript of a video, one line per sentence. Each line starts with [first-last], the numbers of its first and last word, then the time it starts.`,
    `Choose the ${count} most engaging moments that make sense on their own as short clips: a clear point, a story, a surprising fact or a strong opinion, with a natural start and ending.`,
    `Each moment should last ${len.min} to ${len.max} seconds. Moments must not overlap. Start each at the first word of a line and end it at the last word of a line.`,
    'Give each a catchy title of at most 8 words, without hashtags or emoji.',
    'Reply with only JSON in this form: {"highlights":[{"title":"...","start":12,"end":96}]} where start and end are word numbers, best moment first.',
    '',
    ...lines.map((l) => `[${l.first}-${l.last}] (${clockLabel(l.start)}) ${l.text}`),
  ].join('\n');
}

const int = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(/[^\d.-]/g, '')) : Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

function cleanTitle(v, fallback) {
  const t = String(typeof v === 'string' ? v : '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/#\w+/g, '')
    .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return t || fallback;
}

/** Start and end (µs) of words a..b, reaching a little into the silence around them. */
export function wordSpan(words, a, b, { padBefore = 150_000, padAfter = 300_000 } = {}) {
  const prevEnd = a > 0 ? words[a - 1].end : -Infinity;
  const nextStart = b < words.length - 1 ? words[b + 1].start : Infinity;
  const start = Math.max(0, Math.round(Math.max(words[a].start - padBefore, Number.isFinite(prevEnd) ? (prevEnd + words[a].start) / 2 : -Infinity)));
  const end = Math.round(Math.min(words[b].end + padAfter, Number.isFinite(nextStart) ? (words[b].end + nextStart) / 2 : Infinity));
  return { start, end: Math.max(end, start + MIN_CLIP) };
}

/** A transcript excerpt of words a..b, cut to about maxChars. */
export function excerpt(words, a, b, maxChars = 180) {
  const text = joinWords(words.slice(a, b + 1).map((w) => w.text));
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), maxChars * 0.6)).trim()}…`;
}

/**
 * Highlights from a chat reply, never trusting it: word numbers are read as
 * integers, clamped to the transcript and put in order; moments that are too
 * short grow to the next sentence end, ones that are too long shrink to the
 * last sentence end that fits; overlapping and duplicate moments are dropped;
 * at most count are kept. Returns [{ id, title, first, last, start, end,
 * duration, excerpt }] with times in µs.
 */
export function parseHighlights(reply, words, { count = 5, length = 'short' } = {}) {
  const n = Math.min(words.length, PROMPT_WORDS);
  if (!n) return [];
  const len = HIGHLIGHT_LENGTHS.find((l) => l.id === length) || HIGHLIGHT_LENGTHS[0];
  const min = len.min * US * 0.6;
  const max = len.max * US * 1.25;
  const data = extractJson(reply);
  const items = Array.isArray(data) ? data : Array.isArray(data?.highlights) ? data.highlights : Array.isArray(data?.moments) ? data.moments : [];
  const out = [];
  const limit = Math.max(1, Math.min(20, Math.round(Number(count)) || 5));
  for (const item of items) {
    if (out.length >= limit) break;
    if (!item || typeof item !== 'object') continue;
    let a = int(item.start ?? item.startWord ?? item.start_word ?? item.first);
    let b = int(item.end ?? item.endWord ?? item.end_word ?? item.last);
    if (a === null || b === null) continue;
    a = Math.min(n - 1, Math.max(0, a));
    b = Math.min(n - 1, Math.max(0, b));
    if (a > b) [a, b] = [b, a];
    const dur = () => words[b].end - words[a].start;
    // Too short: run on to a sentence end once long enough.
    while (b < n - 1 && (dur() < min || (dur() < len.min * US && !SENTENCE_END.test(words[b].text)))) b++;
    // Too long: end at the last sentence end that fits, else at the last word that fits.
    if (dur() > max) {
      let fit = a;
      let sentence = -1;
      for (let i = a; i <= b && words[i].end - words[a].start <= max; i++) {
        fit = i;
        if (SENTENCE_END.test(words[i].text)) sentence = i;
      }
      b = sentence >= a && words[sentence].end - words[a].start >= min ? sentence : fit;
    }
    const span = wordSpan(words, a, b);
    const clash = out.some((o) => Math.min(o.end, span.end) - Math.max(o.start, span.start) > 0.25 * Math.min(o.end - o.start, span.end - span.start));
    if (clash) continue;
    out.push({
      id: uid('h'),
      title: cleanTitle(item.title ?? item.name, `Highlight ${out.length + 1}`),
      first: a,
      last: b,
      start: span.start,
      end: span.end,
      duration: span.end - span.start,
      excerpt: excerpt(words, a, b),
    });
  }
  return out;
}

/** Ask the chat model for highlights (chat is injectable for tests). */
export async function findHighlights(words, { count = 5, length = 'short', chat = (p) => puter.ai.chat(p) } = {}) {
  if (words.length < 8) throw new Error('There is not enough speech in this clip to find highlights.');
  const reply = await chat(highlightsPrompt(words, { count, length }));
  const list = parseHighlights(reply, words, { count, length });
  if (!list.length) throw new Error(chatText(reply).trim() ? 'The AI answer had no usable moments. Try again.' : 'The AI did not answer. Try again.');
  return list;
}

// ---- Building the clips -------------------------------------------------------------

/** A copy of the source clip cut to the highlight, starting at 0. */
export function highlightClip(clip, h) {
  const copy = structuredClone(clip);
  copy.id = uid('c');
  delete copy.group;
  // This standalone copy has no detached companion; include the source sound used by the search.
  if (copy.audioDetached) {
    copy.audioDetached = false;
    copy.muted = false;
  }
  copy.transition = null;
  copy.animIn = null;
  copy.animOut = null;
  copy.fadeIn = 0;
  copy.fadeOut = 0;
  const cut = trimTo(copy, clip.start + h.start, clip.start + Math.min(h.end, clip.duration));
  if (!cut) return null;
  cut.start = 0;
  return cut;
}

/** Caption clips for the words inside a highlight, timed from its start. */
export function highlightCaptions(words, h, { presetId = 'yellow-caption', width = 1080, position = 'bottom' } = {}) {
  const inside = words.slice(h.first, h.last + 1).map((w) => ({ text: w.text, start: Math.max(0, w.start - h.start) / US, end: Math.max(0, w.end - h.start) / US }));
  const preset = TEXT_PRESETS.find((p) => p.id === presetId);
  const lineChars = lineCharsFor(preset, width);
  const cues = groupWords(inside, { maxWords: 5, maxChars: Math.min(lineChars * 2, 60), maxGap: 0.8 });
  return buildCaptionClips(cues, { presetId, position, lineChars }).filter((c) => c.start < h.end - h.start);
}

/**
 * A new short project for a highlight.
 *  ratio     a RATIOS id, or 'keep' for the source project's frame
 *  captions  TEXT_PRESETS id or '' for none
 */
export function highlightProject(source, clip, words, h, { ratio = '9:16', captions = 'yellow-caption' } = {}) {
  const keep = ratio === 'keep' || !RATIOS.some((r) => r.id === ratio);
  const p = createProject({ name: h.title, ratio: keep ? '16:9' : ratio });
  if (keep) p.settings = { ...structuredClone(source.settings), ratio: source.settings.ratio === 'original' ? '16:9' : source.settings.ratio };
  p.settings.fps = source.settings.fps;
  const asset = source.assets[clip.assetId];
  if (asset) p.assets[asset.id] = structuredClone(asset);
  const c = highlightClip(clip, h);
  if (c) p.tracks[0].clips.push(c);
  if (captions) {
    const caps = highlightCaptions(words, h, { presetId: captions, width: p.settings.width });
    if (caps.length) p.tracks.unshift(makeTrack('text', { name: 'Captions', clips: caps }));
  }
  return p;
}

/** A compound clip (its own little timeline) holding a highlight and its captions. */
export function highlightCompound(project, clip, words, h, { captions = 'yellow-caption', start = 0 } = {}) {
  const c = highlightClip(clip, h);
  if (!c) return null;
  const tracks = [];
  if (captions) {
    const caps = highlightCaptions(words, h, { presetId: captions, width: project.settings.width });
    if (caps.length) tracks.push(makeTrack('text', { clips: caps }));
  }
  tracks.push(makeTrack('video', { main: true, clips: [c] }));
  return makeClip('compound', { name: h.title, start, duration: c.duration, sequence: { tracks } });
}

/** Words of a project transcript that fall inside a clip, made clip-local. */
export function wordsInClip(transcriptWords, clip) {
  const end = clip.start + clip.duration;
  return (transcriptWords || [])
    .filter((w) => w.start >= clip.start - 1000 && w.end <= end + 1000)
    .map((w) => ({ text: w.text, start: Math.max(0, w.start - clip.start), end: Math.min(clip.duration, w.end - clip.start) }));
}
