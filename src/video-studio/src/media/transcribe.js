/**
 * Captions from speech: mix the project's speech to 16 kHz mono, send it to Puter
 * speech to text, and turn the timed words into caption cues. Also reads
 * and writes .srt / .vtt subtitle files.
 *
 * Cue times in this module are seconds; buildCaptionClips converts them to
 * the project's integer microseconds.
 */
import { Input, BlobSource, ALL_FORMATS, AudioBufferSink } from 'mediabunny';
import { US } from '../lib/time.js';
import { makeClip, DEFAULT_TEXT_STYLE } from '../model/project.js';
import { TEXT_PRESETS } from '../model/catalog.js';
import { MIN_CLIP, clipEnd } from '../model/timeline.js';
import { sourceMapper, sourceSpan, localAtSource } from '../model/speed-curve.js';
import { audibleClips, gainAt } from '../engine/scene.js';
import { encodeWav } from './wav.js';

export const LANGUAGES = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'sv', label: 'Swedish' },
  { value: 'pl', label: 'Polish' },
  { value: 'uk', label: 'Ukrainian' },
  { value: 'ru', label: 'Russian' },
  { value: 'tr', label: 'Turkish' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'id', label: 'Indonesian' },
  { value: 'vi', label: 'Vietnamese' },
  { value: 'th', label: 'Thai' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
];

export const CAPTION_POSITIONS = { bottom: 0.34, center: 0, top: -0.34 };

/** Speech services work best around this rate, and it keeps uploads small. */
export const STT_RATE = 16000;
/** Longer mixes are sent in pieces of at most this many seconds. */
export const CHUNK_SECONDS = 600;

// ---- Words to captions ----------------------------------------------------

const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;
const TRAILING_PUNCT = /^[.,!?;:%)\]}"'’”、。！？，…]+$/;
const SENTENCE_END = /[.!?。！？…]["'’”)]*$/;
const PHRASE_END = /[,;:、，]$/;

/** Join word tokens with spaces, except around CJK text and before punctuation. */
export function joinWords(tokens) {
  let out = '';
  for (const raw of tokens) {
    const w = raw.trim();
    if (!w) continue;
    if (!out) out = w;
    else if (TRAILING_PUNCT.test(w) || (CJK.test(out.at(-1)) && CJK.test(w[0]))) out += w;
    else out += ` ${w}`;
  }
  return out;
}

/**
 * Group timed words [{ text, start, end }] into captions.
 *  maxWords  most words on one caption
 *  maxChars  most characters on one caption
 *  maxGap    a pause longer than this (seconds) starts a new caption
 * Sentence ends always close a caption; commas close one that is at least
 * half full. Returns [{ start, end, text }].
 */
export function groupWords(words, { maxWords = 6, maxChars = 42, maxGap = 0.8 } = {}) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: joinWords(cur.map((w) => w.text)) });
    cur = [];
  };
  const list = (words || [])
    .map((w) => ({ text: String(w.text ?? w.word ?? '').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start);
  for (const w of list) {
    if (w.end < w.start) w.end = w.start;
    // Punctuation the service returned as its own token sticks to the previous word.
    if (TRAILING_PUNCT.test(w.text) && cur.length) {
      const last = cur[cur.length - 1];
      cur[cur.length - 1] = { ...last, text: last.text + w.text, end: Math.max(last.end, w.end) };
    } else {
      if (cur.length) {
        const len = joinWords([...cur.map((x) => x.text), w.text]).length;
        const gap = w.start - cur[cur.length - 1].end;
        if (cur.length >= maxWords || len > maxChars || gap > maxGap) flush();
      }
      cur.push(w);
    }
    const t = cur[cur.length - 1].text;
    if (SENTENCE_END.test(t)) flush();
    else if (PHRASE_END.test(t) && cur.length >= Math.ceil(maxWords / 2)) flush();
  }
  flush();
  return out;
}

/** Break a caption into at most two balanced lines of about lineChars each. */
export function wrapCaption(text, lineChars) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= lineChars || !t.includes(' ')) return t;
  // Split at the space closest to the middle.
  const mid = t.length / 2;
  let best = -1;
  for (let i = t.indexOf(' '); i >= 0; i = t.indexOf(' ', i + 1)) if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  return `${t.slice(0, best)}\n${t.slice(best + 1)}`;
}

/** Spread each segment's words over its time span, weighted by length. */
export function segmentsToWords(segments) {
  const out = [];
  for (const seg of segments || []) {
    const start = Number(seg.start);
    const end = Number(seg.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push(...spread(String(seg.text || ''), [{ start, end: Math.max(start, end) }]));
  }
  return out;
}

/** Words of text laid over the given time regions in proportion to their length. */
function spread(text, regions) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length || !regions.length) return [];
  const total = regions.reduce((s, r) => s + (r.end - r.start), 0);
  const weights = tokens.map((w) => w.length + 1);
  const sum = weights.reduce((a, b) => a + b, 0);
  // Map a 0..1 position through the regions so silence between them is skipped.
  const at = (f) => {
    let left = f * total;
    for (const r of regions) {
      const len = r.end - r.start;
      if (left < len) return { t: r.start + left, r };
      left -= len;
    }
    const last = regions[regions.length - 1];
    return { t: last.end, r: last };
  };
  const out = [];
  let acc = 0;
  for (let i = 0; i < tokens.length; i++) {
    const a = at(acc / sum);
    acc += weights[i];
    const b = at(acc / sum);
    out.push({ text: tokens[i], start: a.t, end: b.r === a.r ? b.t : a.r.end });
  }
  return out;
}

/** Spread a plain transcript over the stretches of the mix that contain sound. */
export function distributeText(text, regions) {
  return spread(String(text || ''), regions);
}

/**
 * Stretches of sound in a mono signal (seconds), from 20 ms RMS frames.
 * Pauses shorter than minPause join their neighbors.
 */
export function speechRegions(samples, sampleRate, { minPause = 0.3, minLength = 0.15 } = {}) {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const n = Math.floor(samples.length / frame);
  const rms = new Float32Array(n);
  let max = 0;
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * frame, e = i + frame; i < e; i++) s += samples[i] * samples[i];
    rms[f] = Math.sqrt(s / frame);
    if (rms[f] > max) max = rms[f];
  }
  const dur = samples.length / sampleRate;
  if (!n || max <= 0) return [];
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(n * 0.1)];
  const thr = Math.max(floor * 3, max * 0.06);
  const regions = [];
  let cur = null;
  for (let f = 0; f < n; f++) {
    const t = f * 0.02;
    if (rms[f] >= thr) {
      if (cur && t - cur.end <= minPause) cur.end = t + 0.02;
      else {
        cur = { start: t, end: t + 0.02 };
        regions.push(cur);
      }
    }
  }
  return regions
    .filter((r) => r.end - r.start >= minLength)
    .map((r) => ({ start: Math.max(0, r.start - 0.05), end: Math.min(dur, r.end + 0.05) }));
}

// ---- Subtitle files ---------------------------------------------------------

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function parseTime(s) {
  const m = TIME.exec(s);
  if (!m) return null;
  const [, hh, mm, ss, frac] = m;
  return Number(hh || 0) * 3600 + Number(mm) * 60 + Number(ss) + Number(frac.padEnd(3, '0')) / 1000;
}

// Formatting tags of SubRip and WebVTT cues, and WebVTT karaoke timestamps. Anything
// else between < and > is text ("if a < b and c > d").
const CUE_TAG = /<\/?(?:b|i|u|s|c|v|font|ruby|rt|lang)(?=[\s.>])[^>]*>|<(?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3}>/gi;

function cleanCueText(lines) {
  return lines
    .join('\n')
    .replace(CUE_TAG, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Parse SubRip (.srt) or WebVTT (.vtt) text into [{ start, end, text }] (seconds). */
export function parseSubtitles(text) {
  const blocks = String(text || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTime(a);
    const end = parseTime(b);
    if (start === null || end === null || end <= start) continue;
    const body = cleanCueText(lines.slice(i + 1));
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** SubRip text for cues [{ start, end, text }] (seconds). */
export function toSrt(cues) {
  return cues
    .filter((c) => String(c.text).trim())
    // A blank line ends a cue in SubRip, so blank lines inside the text are dropped.
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${String(c.text).trim().replace(/\n\s*\n/g, '\n')}\n`)
    .join('\n');
}

// ---- Captions on the timeline ---------------------------------------------

/** Characters that fit on one caption line for a preset in a project of this width. */
export function lineCharsFor(preset, width) {
  const style = { ...DEFAULT_TEXT_STYLE, ...(preset?.style || {}) };
  const charW = style.size * (style.bold ? 0.62 : 0.56) * (style.uppercase ? 1.12 : 1) + style.letterSpacing;
  return Math.max(10, Math.floor((width * 0.86) / Math.max(1, charW)));
}

/**
 * Text clips (caption: true) for cues, kept in order and never overlapping.
 *  presetId  TEXT_PRESETS id for the style
 *  position  'bottom' | 'center' | 'top'
 *  lineChars wrap long captions onto two lines of about this length
 *  offset    seconds added to every cue
 */
export function buildCaptionClips(cues, { presetId = 'subtitle', position = 'bottom', lineChars = 0, offset = 0 } = {}) {
  const preset = TEXT_PRESETS.find((p) => p.id === presetId) || TEXT_PRESETS.find((p) => p.id === 'subtitle');
  const sorted = [...cues].filter((c) => String(c.text).trim()).sort((a, b) => a.start - b.start);
  const clips = [];
  let prevEnd = 0;
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const nextStart = i + 1 < sorted.length ? Math.round((sorted[i + 1].start + offset) * US) : Infinity;
    const start = Math.max(prevEnd, Math.round((c.start + offset) * US));
    // Short words still stay up long enough to read, without running into the next caption.
    let end = Math.max(Math.round((c.end + offset) * US), start + 400_000);
    end = Math.min(end, Math.max(nextStart, start + MIN_CLIP));
    if (end - start < MIN_CLIP) continue;
    const text = lineChars ? wrapCaption(c.text, lineChars) : String(c.text).trim();
    const clip = makeClip('text', {
      start,
      duration: end - start,
      text,
      style: { ...DEFAULT_TEXT_STYLE, ...preset.style },
      preset: preset.id,
      caption: true,
    });
    clip.transform.y = CAPTION_POSITIONS[position] ?? CAPTION_POSITIONS.bottom;
    clips.push(clip);
    prevEnd = clipEnd(clip);
  }
  return clips;
}

/** Cues (seconds) for the caption clips in a project, in time order. */
export function captionCues(project) {
  const out = [];
  for (const t of project.tracks) for (const c of t.clips) if (c.type === 'text' && c.caption) out.push({ start: c.start / US, end: clipEnd(c) / US, text: c.text });
  return out.sort((a, b) => a.start - b.start);
}

// ---- Mixdown ----------------------------------------------------------------

function abortError() {
  return new DOMException('Cancelled', 'AbortError');
}

/** Clips whose sound is transcribed for a scope: 'main' (base track) or 'all'. */
export function clipsForScope(project, scope) {
  const list = audibleClips(project).filter(({ clip }) => project.assets[clip.assetId]);
  return scope === 'main' ? list.filter(({ track }) => track.main) : list;
}

/**
 * Mix the clips' sound to mono at sampleRate over the timeline, applying
 * each clip's in point, speed, volume, keyframes and fades. Returns a
 * Float32Array covering 0..end of the last clip, peak normalized.
 */
export async function mixdown(project, library, { scope = 'all', sampleRate = STT_RATE, onProgress, signal } = {}) {
  const items = clipsForScope(project, scope);
  if (!items.length) throw new Error(scope === 'main' ? 'The base track has no sound. Choose All audio, or add clips with sound.' : 'There is no audio in this project to caption.');
  const end = Math.max(...items.map(({ clip }) => clipEnd(clip)));
  const out = new Float32Array(Math.ceil((end / US) * sampleRate));
  const total = items.reduce((s, { clip }) => s + clip.duration, 0);
  let done = 0;
  for (const { clip } of items) {
    if (signal?.aborted) throw abortError();
    const asset = project.assets[clip.assetId];
    const blob = await library.mediaBlob(asset);
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) continue;
      // Source <-> timeline through the clip's speed (constant or a curve).
      const map = sourceMapper(clip);
      const toLocal = (srcSec) => localAtSource(clip, srcSec * US) / US;
      const srcStart = clip.in / US;
      const srcEnd = srcStart + sourceSpan(clip) / US;
      const tStart = clip.start / US;
      const tEnd = clipEnd(clip) / US;
      const sink = new AudioBufferSink(track);
      for await (const { buffer, timestamp } of sink.buffers(srcStart, srcEnd)) {
        if (signal?.aborted) throw abortError();
        mixChunk(out, sampleRate, buffer, timestamp, clip, { srcStart, map, toLocal, tStart, tEnd });
        onProgress?.(Math.min(1, (done + Math.min(clip.duration, toLocal(timestamp - srcStart) * US)) / total));
      }
    } finally {
      input.dispose();
    }
    done += clip.duration;
    onProgress?.(Math.min(1, done / total));
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const k = 0.9 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= k;
  }
  return out;
}

/** Add one decoded chunk of a clip into the output, resampled and gained. */
function mixChunk(out, rate, buffer, timestamp, clip, { srcStart, map, toLocal, tStart, tEnd }) {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const chans = buffer.numberOfChannels;
  let mono;
  if (chans === 1) mono = buffer.getChannelData(0);
  else {
    mono = new Float32Array(n);
    for (let c = 0; c < chans; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / chans;
    }
  }
  // Timeline seconds this chunk covers.
  const a = Math.max(tStart, tStart + toLocal(timestamp - srcStart));
  const b = Math.min(tEnd, tStart + toLocal(timestamp + n / sr - srcStart));
  const j0 = Math.max(0, Math.ceil(a * rate));
  const j1 = Math.min(out.length, Math.ceil(b * rate));
  let g = 0;
  for (let j = j0; j < j1; j++) {
    // Gain changes slowly; evaluate it every 10 ms.
    if ((j - j0) % 160 === 0) g = gainAt(clip, Math.round((j / rate) * US));
    if (!g) continue;
    const pos = (srcStart + map((j / rate - tStart) * US) / US - timestamp) * sr;
    const i = Math.floor(pos);
    if (i < 0 || i >= n) continue;
    const f = pos - i;
    const s = i + 1 < n ? mono[i] + (mono[i + 1] - mono[i]) * f : mono[i];
    out[j] += s * g;
  }
}

/**
 * Split a long mix into pieces of at most maxSeconds, cutting at the
 * quietest 100 ms near each boundary so words are not cut in half.
 * Returns [{ offset (seconds), samples }].
 */
export function splitForTranscription(samples, sampleRate, maxSeconds = CHUNK_SECONDS) {
  const max = Math.floor(maxSeconds * sampleRate);
  if (samples.length <= max) return [{ offset: 0, samples }];
  const win = Math.round(sampleRate * 0.1);
  const search = Math.round(sampleRate * Math.min(10, maxSeconds / 10));
  const pieces = [];
  let from = 0;
  while (samples.length - from > max) {
    const target = from + max;
    let best = target;
    let bestE = Infinity;
    for (let s = Math.max(from + win, target - search); s + win <= Math.min(target, samples.length); s += win) {
      let e = 0;
      for (let i = s; i < s + win; i++) e += samples[i] * samples[i];
      if (e < bestE) {
        bestE = e;
        best = s + Math.floor(win / 2);
      }
    }
    pieces.push({ offset: from / sampleRate, samples: samples.subarray(from, best) });
    from = best;
  }
  pieces.push({ offset: from / sampleRate, samples: samples.subarray(from) });
  return pieces;
}

// ---- Speech to text -----------------------------------------------------------

export function puterAvailable() {
  return typeof puter !== 'undefined' && Boolean(puter.ai?.speech2txt);
}

/** A readable message from whatever a failed Puter call threw. */
export function errorMessage(err, fallback = 'Something went wrong.') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  return err.error?.message || err.message || (typeof err.error === 'string' ? err.error : '') || fallback;
}

function normalizeWords(result) {
  const words = Array.isArray(result?.words) ? result.words : [];
  return words
    .map((w) => ({ text: String(w.text ?? w.word ?? '').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
}

/**
 * Timed words for one piece of mono audio. Tries xAI (per-word timestamps)
 * and, only when that fails, the default model, whose segments (or plain
 * text) are spread over the stretches of sound. An answer with no words
 * (silence, music) is final: asking again would only pay twice.
 */
export async function transcribePiece(samples, sampleRate, { language = 'auto', testMode = false, signal } = {}) {
  const file = new File([encodeWav([samples], sampleRate)], 'captions.wav', { type: 'audio/wav' });
  const lang = language && language !== 'auto' ? language : null;
  let firstError = null;
  try {
    const opts = { file, provider: 'xai' };
    if (lang) Object.assign(opts, { language: lang, format: true });
    if (testMode) opts.test_mode = true;
    const res = await puter.ai.speech2txt(opts);
    if (signal?.aborted) throw abortError();
    const words = normalizeWords(res);
    if (words.length) return words;
    const text = typeof res === 'string' ? res : res?.text;
    return text ? distributeText(text, regionsOrAll(samples, sampleRate)) : [];
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    firstError = err;
  }
  try {
    const opts = {};
    if (lang) opts.language = lang;
    const res = testMode ? await puter.ai.speech2txt(file, true) : await puter.ai.speech2txt(file, opts);
    if (signal?.aborted) throw abortError();
    const words = normalizeWords(res);
    if (words.length) return words;
    if (Array.isArray(res?.segments) && res.segments.length) return segmentsToWords(res.segments);
    const text = typeof res === 'string' ? res : res?.text;
    return text ? distributeText(text, regionsOrAll(samples, sampleRate)) : [];
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(errorMessage(err, errorMessage(firstError, "Couldn't transcribe the audio.")));
  }
}

function regionsOrAll(samples, sampleRate) {
  const r = speechRegions(samples, sampleRate);
  return r.length ? r : [{ start: 0, end: samples.length / sampleRate }];
}

/** Timed words for a whole mix, in pieces when it is long; times are timeline seconds. */
export async function transcribeMix(samples, sampleRate, { language, testMode, signal, onProgress } = {}) {
  const pieces = splitForTranscription(samples, sampleRate);
  const words = [];
  for (let i = 0; i < pieces.length; i++) {
    if (signal?.aborted) throw abortError();
    const { offset, samples: s } = pieces[i];
    const part = await transcribePiece(s, sampleRate, { language, testMode, signal });
    for (const w of part) words.push({ text: w.text, start: w.start + offset, end: w.end + offset });
    onProgress?.((i + 1) / pieces.length);
  }
  return words;
}
