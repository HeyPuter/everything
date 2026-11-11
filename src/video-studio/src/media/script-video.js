/**
 * Script to video: turn a written script into scenes (narration plus a
 * picture description), and lay the generated voices, pictures, captions
 * and music out on a timeline. The generation itself (Puter AI speech and
 * pictures) is passed in as services so the whole flow runs with fakes in
 * tests.
 *
 * Times in this module are integer microseconds unless a name says
 * seconds; word timings from speech services are seconds.
 */
import { US } from '../lib/time.js';
import { makeClip, makeTrack, createProject, RATIOS } from '../model/project.js';
import { TEXT_PRESETS } from '../model/catalog.js';
import { MIN_CLIP } from '../model/timeline.js';
import { groupWords, buildCaptionClips, lineCharsFor, distributeText } from './transcribe.js';
import { duckCurve } from './audio-analysis.js';

export const SCRIPT_MAX = 8000;
export const SCENES_MAX = 40;

export const SCRIPT_TONES = ['Friendly', 'Informative', 'Upbeat', 'Calm', 'Dramatic', 'Funny'];

export const SCRIPT_LENGTHS = [
  { id: 'short', label: 'Short, about 30 seconds', words: 75 },
  { id: 'medium', label: 'Medium, about 1 minute', words: 150 },
  { id: 'long', label: 'Long, about 2 minutes', words: 300 },
];

/** Frame shapes offered for a new script video. */
export const SCRIPT_RATIOS = ['16:9', '9:16', '1:1'];

/** Caption looks offered (TEXT_PRESETS ids); '' means no captions. */
export const SCRIPT_CAPTION_STYLES = [
  { id: 'clean-caption', label: 'Clean' },
  { id: 'yellow-caption', label: 'Bold pop' },
  { id: 'subtitle', label: 'Subtitle bar' },
  { id: 'boxed', label: 'Boxed' },
  { id: '', label: 'No captions' },
];

/** Silence before and after each scene's narration, and the crossfade between pictures. */
export const LEAD = 350_000;
export const TAIL = 450_000;
export const CROSSFADE = 500_000;
export const MIN_SCENE = 2 * US;
/** Speaking rate used when there is no voice to measure (words per second). */
export const WORDS_PER_SECOND = 2.5;

/** Slow camera moves the pictures cycle through (whole-clip loop animations). */
export const PICTURE_MOTIONS = ['push-in', 'pan-right', 'pull-out', 'pan-left', 'drift-zoom', 'pan-up'];

/** Gradient backdrops used for a scene whose picture could not be made. */
export const FALLBACK_BACKDROPS = ['dusk', 'ocean', 'slate', 'forest', 'peach'];

// ---- Chat replies ------------------------------------------------------------

/** The text of a Puter AI chat reply (a string, or a message object). */
export function chatText(reply) {
  if (typeof reply === 'string') return reply;
  const c = reply?.message?.content;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  if (typeof c === 'string') return c;
  if (typeof reply?.text === 'string') return reply.text;
  return reply == null ? '' : String(reply);
}

/** The first JSON array or object in a reply (code fences and chatter around it are ignored), or null. */
export function extractJson(reply) {
  const text = chatText(reply);
  const starts = [text.indexOf('['), text.indexOf('{')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const close = text[start] === '[' ? ']' : '}';
  // Try the longest candidate first, then shorter ones, so trailing prose does not break it.
  for (let end = text.lastIndexOf(close); end > start; end = text.lastIndexOf(close, end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// ---- Writing the script ----------------------------------------------------------

/** The chat prompt that writes a narration script about a topic. */
export function scriptPrompt({ topic, tone = 'Friendly', length = 'medium' }) {
  const len = SCRIPT_LENGTHS.find((l) => l.id === length) || SCRIPT_LENGTHS[1];
  return [
    `Write the narration for a short video about: ${String(topic || '').trim().slice(0, 1500)}`,
    `Tone: ${String(tone).toLowerCase()}. Length: about ${len.words} words in total.`,
    'Write it as spoken words only, in short paragraphs of one to three sentences. Each paragraph will be one scene with its own picture.',
    'Start with a line that makes people want to keep watching, and end with a short closing line.',
    'Do not add a title, scene numbers, speaker names, stage directions, hashtags or emoji.',
  ].join('\n');
}

const LABEL = /^(?:scene|part|section|slide|shot)\s*\d+\s*[:.)-]\s*/i;
const SPEAKER = /^(?:narrator|voice ?over|vo|host|speaker)\s*:\s*/i;

/** Narration text from a written script: drops headings, scene labels, stage directions and markup. */
export function cleanScript(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line
      .replace(/^\s*#{1,6}\s.*$/, '') // markdown headings
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '') // list markers
      .replace(/\*\*|__|`/g, '')
      .replace(/\[[^\]]*\]|\([^)]*(?:music|sound|cut to|visual|scene)[^)]*\)/gi, '') // [stage directions], (music fades)
      .trim()
      .replace(LABEL, '')
      .replace(SPEAKER, '')
      .replace(/^["“]|["”]$/g, '')
      .trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, SCRIPT_MAX);
}

const wordCount = (t) => String(t).split(/\s+/).filter(Boolean).length;

/** Sentences of a paragraph, keeping their end punctuation. */
export function splitSentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out = t.match(/[^.!?。！？…]+(?:[.!?。！？…]+["'’”)\]]*|$)/g) || [t];
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Scenes from a script: each paragraph is a scene, long paragraphs are
 * split between sentences to at most maxWords, and scenes shorter than
 * minWords join the one before. Returns [{ narration, picture: '' }].
 */
export function splitScenes(text, { maxWords = 40, minWords = 6, maxScenes = SCENES_MAX } = {}) {
  const paragraphs = cleanScript(text).split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const parts = [];
  for (const p of paragraphs) {
    if (wordCount(p) <= maxWords) {
      parts.push(p.replace(/\s+/g, ' '));
      continue;
    }
    let cur = '';
    for (const s of splitSentences(p)) {
      if (cur && wordCount(`${cur} ${s}`) > maxWords) {
        parts.push(cur);
        cur = s;
      } else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) parts.push(cur);
  }
  const merged = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last !== undefined && (wordCount(p) < minWords || wordCount(last) < minWords) && wordCount(`${last} ${p}`) <= maxWords * 1.5) merged[merged.length - 1] = `${last} ${p}`;
    else merged.push(p);
  }
  // Too many scenes: join neighbors pairwise until they fit.
  let list = merged;
  while (list.length > maxScenes) {
    const next = [];
    for (let i = 0; i < list.length; i += 2) next.push(list[i + 1] ? `${list[i]} ${list[i + 1]}` : list[i]);
    list = next;
  }
  return list.map((narration) => ({ narration, picture: '' }));
}

/** The chat prompt asking for one picture description per scene. */
export function picturesPrompt({ scenes, topic = '', style = '' }) {
  return [
    'A narrated video is made of the scenes below. For each scene, describe one still picture to show while it is spoken.',
    topic ? `The video is about: ${String(topic).slice(0, 600)}` : '',
    style ? `Picture style: ${style}.` : '',
    'Describe concrete things to see (subject, setting, light, framing) in one sentence of at most 30 words.',
    'No words, letters, logos or captions in the pictures, and no real or famous people.',
    `Reply with only a JSON array of exactly ${scenes.length} strings, in scene order.`,
    JSON.stringify(scenes.map((s) => String(s.narration || s).slice(0, 600))),
  ].filter(Boolean).join('\n');
}

/** Picture descriptions from a reply: always count strings, '' where the answer had none. */
export function parsePictures(reply, count) {
  const data = extractJson(reply);
  const arr = Array.isArray(data) ? data : Array.isArray(data?.pictures) ? data.pictures : Array.isArray(data?.scenes) ? data.scenes : [];
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = arr[i];
    const s = typeof v === 'string' ? v : typeof v?.picture === 'string' ? v.picture : typeof v?.description === 'string' ? v.description : '';
    out.push(s.replace(/\s+/g, ' ').trim().slice(0, 600));
  }
  return out;
}

/** What to ask the picture model for: the scene's description, else its narration. */
export function pictureText(scene) {
  return String(scene.picture || '').trim() || String(scene.narration || '').trim();
}

/** A short project name from the topic or script. */
export function projectName(text, fallback = 'Script video') {
  const first = cleanScript(text).split(/\n/)[0] || '';
  const words = first.replace(/[\\/:*?"<>|]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 7).join(' ');
  const name = words.length > 48 ? `${words.slice(0, 47).trim()}…` : words;
  return name || fallback;
}

// ---- Timing ---------------------------------------------------------------------

/** Speaking time for text when there is no voice to measure. */
export function estimateSpeech(text) {
  return Math.max(US, Math.round((wordCount(text) / WORDS_PER_SECOND) * US));
}

/**
 * Where each scene sits: given each scene's narration length (µs), every
 * scene lasts LEAD + narration + TAIL (at least MIN_SCENE) and they follow
 * each other from 0. Returns [{ start, duration, voiceStart }].
 */
export function sceneTimes(lengths, { lead = LEAD, tail = TAIL, min = MIN_SCENE } = {}) {
  let t = 0;
  return lengths.map((len) => {
    const duration = Math.max(min, Math.round(lead + Math.max(0, len) + tail));
    const out = { start: t, duration, voiceStart: t + lead };
    t += duration;
    return out;
  });
}

/**
 * Timed words for a scene's narration (seconds from the start of its
 * voice). With words heard by speech to text the narration's own words are
 * laid over them: one to one when the counts match, else by their position
 * in the text. Without them the words are spread over the voice by length.
 * Returns { words, timing: 'speech' | 'estimate' }.
 */
export function alignWords(narration, heard, duration) {
  const tokens = String(narration || '').split(/\s+/).filter(Boolean);
  const total = Math.max(0.1, duration / US);
  const spoken = (heard || [])
    .map((w) => ({ text: String(w.text ?? '').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
    .sort((a, b) => a.start - b.start);
  if (!tokens.length) return { words: [], timing: 'estimate' };
  if (!spoken.length) return { words: distributeText(tokens.join(' '), [{ start: 0, end: total }]), timing: 'estimate' };
  if (spoken.length === tokens.length) {
    return { words: tokens.map((text, i) => ({ text, start: spoken[i].start, end: spoken[i].end })), timing: 'speech' };
  }
  // Map a 0..1 position in the narration's characters to a time through the heard words.
  const weights = (list) => {
    const w = list.map((x) => (typeof x === 'string' ? x : x.text).length + 1);
    const sum = w.reduce((a, b) => a + b, 0);
    let acc = 0;
    return w.map((v) => {
      const a = acc / sum;
      acc += v;
      return [a, acc / sum];
    });
  };
  const spans = weights(spoken);
  const timeAt = (f) => {
    for (let j = 0; j < spoken.length; j++) {
      const [a, b] = spans[j];
      if (f <= b || j === spoken.length - 1) {
        const k = b > a ? Math.min(1, Math.max(0, (f - a) / (b - a))) : 0;
        return spoken[j].start + (spoken[j].end - spoken[j].start) * k;
      }
    }
    return spoken[spoken.length - 1].end;
  };
  const words = weights(tokens).map(([a, b], i) => ({ text: tokens[i], start: timeAt(a), end: timeAt(b) }));
  return { words, timing: 'speech' };
}

// ---- Laying it out ---------------------------------------------------------------

/**
 * Clips for generated scenes, with times from 0.
 *  scenes   [{ narration, words (seconds from voice start), voice: { assetId, duration } | null,
 *             image: { assetId, name } }]
 *  opts     { width, captions (TEXT_PRESETS id or ''), music: { assetId, duration } | null,
 *             musicVolume, duckDb }
 * Returns { pictures, voices, captions, music, duration }.
 */
export function layoutScenes(scenes, { width = 1920, captions = 'clean-caption', music = null, musicVolume = 0.4, duckDb = 12 } = {}) {
  const times = sceneTimes(scenes.map((s) => (s.voice ? s.voice.duration : estimateSpeech(s.narration))));
  const pictures = [];
  const voices = [];
  const cues = [];
  scenes.forEach((s, i) => {
    const { start, duration, voiceStart } = times[i];
    const last = i === scenes.length - 1;
    pictures.push(makeClip('image', {
      assetId: s.image.assetId,
      name: s.image.name || `Scene ${i + 1}`,
      start,
      duration,
      animLoop: { id: PICTURE_MOTIONS[i % PICTURE_MOTIONS.length], duration },
      transition: last ? null : { id: 'mix', duration: CROSSFADE },
      animIn: i === 0 ? { id: 'fade-in', duration: 400_000 } : null,
      animOut: last ? { id: 'fade-out', duration: 600_000 } : null,
    }));
    if (s.voice) voices.push(makeClip('audio', { assetId: s.voice.assetId, name: `Narration ${i + 1}`, start: voiceStart, duration: s.voice.duration }));
    if (captions) {
      const off = voiceStart / US;
      // Each scene is grouped on its own so a caption never spans a cut.
      for (const c of groupWords((s.words || []).map((w) => ({ ...w, start: w.start + off, end: w.end + off })), { maxWords: 5, maxChars: 38, maxGap: 0.7 })) cues.push(c);
    }
  });
  const duration = times.length ? times[times.length - 1].start + times[times.length - 1].duration : 0;
  const preset = TEXT_PRESETS.find((p) => p.id === captions);
  const captionClips = captions && cues.length ? buildCaptionClips(cues, { presetId: captions, position: 'bottom', lineChars: lineCharsFor(preset, width) }) : [];
  const speech = voices.map((v) => [v.start / US, (v.start + v.duration) / US]);
  const musicClips = music ? musicBed(music, duration, speech, { volume: musicVolume, duckDb }) : [];
  return { pictures, voices, captions: captionClips, music: musicClips, duration };
}

/**
 * A music bed covering [0, total): the track repeated as needed, faded in
 * and out, and turned down by duckDb wherever speech plays (seconds).
 */
export function musicBed(music, total, speech, { volume = 0.4, duckDb = 12, fadeIn = US, fadeOut = 1.5 * US } = {}) {
  const len = Math.max(MIN_CLIP, Math.round(music.duration));
  const clips = [];
  const low = 10 ** (-duckDb / 20);
  for (let at = 0; at < total - MIN_CLIP; at += len) {
    const duration = Math.min(len, total - at);
    const local = speech
      .map(([a, b]) => [a - at / US, b - at / US])
      .filter(([a, b]) => b > 0 && a < duration / US)
      .map(([a, b]) => [Math.max(0, a), Math.min(duration / US, b)]);
    const curve = duckCurve(local, duration / US, low);
    const keys = [];
    for (const p of curve) {
      const t = Math.min(duration, Math.round(p.t * US));
      if (keys.length && t - keys[keys.length - 1].t < 1000) keys[keys.length - 1].v = Math.round(volume * p.g * 1000) / 1000;
      else keys.push({ t, v: Math.round(volume * p.g * 1000) / 1000, ease: 'linear' });
    }
    clips.push(makeClip('audio', {
      assetId: music.assetId,
      name: music.name || 'Music',
      start: at,
      duration,
      volume,
      fadeIn: at === 0 ? Math.min(fadeIn, duration / 2) : 0,
      fadeOut: at + duration >= total ? Math.min(fadeOut, duration / 2) : 0,
      keyframes: keys.length > 1 ? { volume: keys } : {},
    }));
  }
  return clips;
}

/** A new project holding laid-out scenes: pictures on the base track, captions above, sound below. */
export function scriptProject(layout, assets, { name = 'Script video', ratio = '16:9' } = {}) {
  const r = RATIOS.find((x) => x.id === ratio) ? ratio : '16:9';
  const p = createProject({ name, ratio: r });
  for (const a of assets) p.assets[a.id] = a;
  p.tracks[0].clips = layout.pictures;
  if (layout.captions.length) p.tracks.unshift(makeTrack('text', { clips: layout.captions, name: 'Captions' }));
  if (layout.voices.length) p.tracks.push(makeTrack('audio', { clips: layout.voices, name: 'Narration' }));
  if (layout.music.length) p.tracks.push(makeTrack('audio', { clips: layout.music, name: 'Music' }));
  return p;
}

/**
 * Put laid-out scenes into an open project at time `at` (mutates it, for
 * use inside one store.update). The pictures go on the base track when it
 * is empty, else on a new video track above it. Returns the added clip ids.
 */
export function insertScenes(project, layout, assets, at = 0) {
  for (const a of assets) project.assets[a.id] = a;
  const shift = (clips) => clips.map((c) => ({ ...c, start: c.start + at }));
  const main = project.tracks.find((t) => t.main);
  const ids = [];
  const add = (track, clips) => {
    track.clips.push(...clips);
    track.clips.sort((a, b) => a.start - b.start);
    ids.push(...clips.map((c) => c.id));
  };
  const pictures = shift(layout.pictures);
  if (main && !main.clips.length && !main.locked) add(main, pictures);
  else {
    const i = Math.max(0, project.tracks.findIndex((t) => t.main));
    const track = makeTrack('video', { name: 'Script video' });
    project.tracks.splice(i, 0, track);
    add(track, pictures);
  }
  if (layout.captions.length) {
    const track = makeTrack('text', { name: 'Captions' });
    project.tracks.unshift(track);
    add(track, shift(layout.captions));
  }
  for (const [list, name] of [[layout.voices, 'Narration'], [layout.music, 'Music']]) {
    if (!list.length) continue;
    const track = makeTrack('audio', { name });
    project.tracks.push(track);
    add(track, shift(list));
  }
  return ids;
}

// ---- Generating ------------------------------------------------------------------

function abortError() {
  return new DOMException('Cancelled', 'AbortError');
}

/**
 * Make every scene's voice, picture and word timing, then lay them out.
 *  scenes    [{ narration, picture }]
 *  opts      { voice, style, aspect, width, height, captions, music (MUSIC id or '') }
 *  services  {
 *    speech(text, voiceId, { signal }) -> Blob
 *    image(prompt, { aspect, style, signal }) -> Blob
 *    words(asset, blob, { signal }) -> [{ text, start, end }] seconds | null   (optional)
 *    backdrop(index, width, height) -> File        a stand-in picture
 *    music(id) -> Blob                             (optional)
 *    addMedia(file, origin) -> asset               stores media, returns its asset (with duration)
 *  }
 * Scenes whose picture fails get a backdrop and scenes whose voice fails
 * are timed by their length; both are listed in `problems`. Throws only
 * when cancelled or when nothing at all could be made.
 * reuse (a Map kept by the caller between runs) holds the pictures and voices
 * already made, by what they were made from: a run after Stop or a failure
 * takes them from there rather than paying for them again.
 * Returns { layout, assets, problems, timing: 'speech' | 'estimate' | 'mixed' }.
 */
export async function generateScenes(scenes, opts, services, { signal, onProgress, reuse = null } = {}) {
  const list = scenes.filter((s) => String(s.narration || '').trim()).slice(0, SCENES_MAX);
  if (!list.length) throw new Error('Write at least one scene first.');
  const { voice, style = 'none', aspect = '16:9', width = 1920, height = 1080, captions = 'clean-caption' } = opts;
  const assets = [];
  const problems = [];
  const made = [];
  const timings = new Set();
  const steps = list.length * 2 + (opts.music ? 1 : 0);
  let done = 0;
  const tick = (label) => onProgress?.({ done: ++done, total: steps, label });
  const check = () => {
    if (signal?.aborted) throw abortError();
  };
  // Two scenes asking for the same picture or words still get one each.
  const seen = new Map();
  const keyOf = (k) => {
    const c = (seen.get(k) || 0) + 1;
    seen.set(k, c);
    return `${k}\n${c}`;
  };
  for (let i = 0; i < list.length; i++) {
    check();
    const s = list[i];
    const n = i + 1;
    onProgress?.({ done, total: steps, label: `Scene ${n} of ${list.length}: picture` });
    let image = null;
    const pictureKey = keyOf(`picture\n${aspect}\n${style}\n${pictureText(s)}`);
    try {
      let asset = reuse?.get(pictureKey);
      if (!asset) {
        const blob = await services.image(pictureText(s), { aspect, style, signal });
        asset = await services.addMedia(new File([blob], `Scene ${n} picture.${/jpe?g/.test(blob.type) ? 'jpg' : 'png'}`, { type: blob.type || 'image/png' }), 'generate');
        reuse?.set(pictureKey, asset);
        check();
      }
      assets.push(asset);
      image = { assetId: asset.id, name: asset.name };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      problems.push({ scene: n, what: 'picture', message: err?.message || 'The picture could not be made.' });
    }
    if (!image) {
      check();
      const file = await services.backdrop(i, width, height);
      const asset = await services.addMedia(file, 'backdrop');
      assets.push(asset);
      image = { assetId: asset.id, name: asset.name };
    }
    tick(`Scene ${n} of ${list.length}: voice`);
    check();
    let voiceClip = null;
    let words = null;
    const voiceKey = keyOf(`voice\n${voice}\n${s.narration}`);
    try {
      let kept = reuse?.get(voiceKey);
      if (!kept) {
        const blob = await services.speech(s.narration, voice, { signal });
        const ext = /wav/.test(blob.type) ? 'wav' : /ogg/.test(blob.type) ? 'ogg' : 'mp3';
        const asset = await services.addMedia(new File([blob], `Scene ${n} narration.${ext}`, { type: blob.type || 'audio/mpeg' }), 'speech');
        if (!asset?.duration) throw new Error('The narration came back empty.');
        kept = { asset, blob, words: null };
        reuse?.set(voiceKey, kept);
        check();
      }
      const { asset } = kept;
      assets.push(asset);
      voiceClip = { assetId: asset.id, duration: asset.duration };
      if (captions && services.words) {
        try {
          kept.words ??= await services.words(asset, kept.blob, { signal });
          words = kept.words;
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          words = null;
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      problems.push({ scene: n, what: 'voice', message: err?.message || 'The narration could not be made.' });
    }
    const length = voiceClip ? voiceClip.duration : estimateSpeech(s.narration);
    const aligned = alignWords(s.narration, words, length);
    timings.add(aligned.timing);
    made.push({ narration: s.narration, words: aligned.words, voice: voiceClip, image });
    tick(`Scene ${n} of ${list.length} done`);
  }
  if (made.every((m) => !m.voice) && problems.filter((p) => p.what === 'picture').length === made.length) {
    throw new Error(problems[0]?.message || 'Nothing could be made. Try again.');
  }
  let music = null;
  if (opts.music && services.music) {
    check();
    try {
      const blob = await services.music(opts.music);
      const asset = await services.addMedia(new File([blob], `${opts.musicName || 'Music'}.wav`, { type: 'audio/wav' }), 'music');
      assets.push(asset);
      music = { assetId: asset.id, duration: asset.duration, name: asset.name };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      problems.push({ scene: 0, what: 'music', message: err?.message || 'The music could not be added.' });
    }
    tick('Music added');
  }
  const layout = layoutScenes(made, { width, captions, music });
  const timing = timings.size > 1 ? 'mixed' : [...timings][0] || 'estimate';
  return { layout, assets, problems, timing };
}

/** One readable sentence about scenes that fell back, or ''. */
export function problemSummary(problems) {
  const pics = problems.filter((p) => p.what === 'picture').map((p) => p.scene);
  const voices = problems.filter((p) => p.what === 'voice').map((p) => p.scene);
  const music = problems.some((p) => p.what === 'music');
  const list = (a) => (a.length === 1 ? `scene ${a[0]}` : `scenes ${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  const parts = [];
  if (pics.length) parts.push(`No picture could be made for ${list(pics)}, so a plain backdrop stands in`);
  if (voices.length) parts.push(`no narration could be made for ${list(voices)}`);
  if (music) parts.push('the music could not be added');
  if (!parts.length) return '';
  const s = parts.join('; ');
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}
