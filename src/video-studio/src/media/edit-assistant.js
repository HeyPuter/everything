/**
 * Edit assistant: describe an edit in plain words and Puter AI turns it
 * into calls to a small set of edit tools, which the app checks and then
 * performs (see ui/assistant-actions.js).
 *
 * This module holds the parts that need no DOM: the tool definitions
 * (OpenAI-style function schemas), a compact text summary of the project
 * for the model, reading tool calls out of a reply (or a JSON action list
 * when the model answers in text), checking and clamping every argument
 * against the project, and the summary shown after an edit.
 *
 * Times the model sees and sends are seconds; the project stores
 * microseconds. Arguments that cannot be used are dropped with a reason.
 */
import { US } from '../lib/time.js';
import { RATIOS, MARKER_COLORS } from '../model/project.js';
import { EFFECTS, FILTERS, TRANSITIONS, ANIMATIONS, FONTS, TEXT_PRESETS } from '../model/catalog.js';
import { TEXT_EFFECTS } from '../model/text-presets.js';
import { CAPTION_STYLES } from '../model/caption-styles.js';
import { isBodyEffect } from '../model/body-effects.js';
import { canHaveEffects } from '../model/clip-effects.js';
import { LANGUAGES, CAPTION_POSITIONS } from './transcribe.js';
import { chatText, extractJson } from './script-video.js';

/** How many earlier messages go along with a request (follow-ups like "make it red instead"). */
export const HISTORY_LIMIT = 12;
/** Longest request accepted from the input. */
export const REQUEST_MAX = 1000;
/** Clips listed one by one in the summary; the rest are counted. */
const CLIP_LIMIT = 160;

// ---- Small value helpers --------------------------------------------------------

const toNum = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const isNum = (v) => Number.isFinite(toNum(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Number in [lo, hi], or d when v is missing or not a number. */
export const clampNum = (v, lo, hi, d) => (isNum(v) ? clamp(toNum(v), lo, hi) : d);
const toUs = (seconds) => Math.round(seconds * US);
/** "3.5s" for a time in microseconds. */
export const secs = (us) => `${(Math.round(us / 100_000) / 10).toFixed(1)}s`;
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const bool = (v) => v === true || v === 'true' || v === 1;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const lower = (v) => str(v, 80).toLowerCase();

const NAMED_COLORS = {
  white: '#ffffff', black: '#000000', red: '#e5322d', orange: '#ff8a1f', yellow: '#ffd23f', gold: '#f5b83d', green: '#2fbf5b',
  teal: '#14b8a6', cyan: '#22d3ee', blue: '#2f6bff', navy: '#1b2a5c', purple: '#8b4dff', violet: '#8b4dff', magenta: '#e83ad6',
  pink: '#ff5fa2', brown: '#8b5a2b', gray: '#8a8a8a', grey: '#8a8a8a', silver: '#c8c8c8',
};

/** '#rrggbb' from a hex color (#rgb or #rrggbb) or a common color name, else null. */
export function normColor(v) {
  const s = lower(v).replace(/\s+/g, '');
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${hex}`;
}

/** Catalog id from an id or a label, ignoring case ("Dissolve" finds "mix"). */
function findId(list, v) {
  const s = lower(v);
  if (!s) return null;
  return (list.find((x) => x.id.toLowerCase() === s) || list.find((x) => x.label?.toLowerCase() === s))?.id || null;
}

const NONE = new Set(['none', 'off', 'remove', 'null', 'no', '']);
const isNone = (v) => v === null || v === false || (typeof v === 'string' && NONE.has(v.trim().toLowerCase()));

const ALL_ANIMATIONS = [...ANIMATIONS.in, ...ANIMATIONS.out, ...ANIMATIONS.loop];
const TEXT_LOOKS = [...TEXT_PRESETS, ...TEXT_EFFECTS];
export const TEXT_POSITIONS = { top: CAPTION_POSITIONS.top, center: 0, middle: 0, bottom: CAPTION_POSITIONS.bottom };

// ---- Project state ----------------------------------------------------------------

/** Every top-level clip with its track: [{ clip, track, index }] (index = track position, top first). */
function clipsWithTracks(project) {
  const out = [];
  project.tracks.forEach((track, index) => {
    for (const clip of track.clips) out.push({ clip, track, index });
  });
  return out;
}

const projectLength = (p) => {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  return end;
};

/** The view of the editor a request is checked against: { project, selection: ids, time, duration }. */
export function assistState(store) {
  return { project: store.project, selection: [...store.selection], time: store.time, duration: store.duration ?? projectLength(store.project) };
}

const isVisualMedia = (c) => c.type === 'video' || c.type === 'image';
const isTimed = (c) => c.type === 'video' || c.type === 'audio';

/** Clip id words the model can use instead of listing ids. */
export const CLIP_WORDS = {
  selected: 'the selected clips',
  all: 'every clip',
  all_video: 'every video and image clip',
  all_text: 'every text clip (captions too)',
  all_captions: 'every caption',
  all_audio: 'every audio clip',
  base_track: 'the clips on the base track',
  first: 'the first clip on the base track',
  last: 'the last clip on the base track',
};

/**
 * Clip ids for a target list: ids from the summary and the words in
 * CLIP_WORDS. accept(clip) keeps the clips the tool can change. Returns
 * { ids, unknown, rejected } (unknown: ids not in the project; rejected:
 * clips of the wrong type or on locked tracks).
 */
export function resolveClips(raw, state, accept = () => true) {
  const list = (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw]).map((x) => str(x, 80)).filter(Boolean);
  const all = clipsWithTracks(state.project);
  const byId = new Map(all.map((x) => [x.clip.id, x]));
  const base = all.filter((x) => x.track.main).sort((a, b) => a.clip.start - b.clip.start);
  const picked = [];
  const unknown = [];
  const add = (x) => {
    if (x && !picked.includes(x)) picked.push(x);
  };
  for (const item of list) {
    const word = item.toLowerCase();
    if (byId.has(item)) add(byId.get(item));
    else if (word === 'selected' || word === 'selection') state.selection.forEach((id) => add(byId.get(id)));
    else if (word === 'all') all.forEach(add);
    else if (word === 'all_video') all.filter((x) => isVisualMedia(x.clip)).forEach(add);
    else if (word === 'all_text') all.filter((x) => x.clip.type === 'text').forEach(add);
    else if (word === 'all_captions') all.filter((x) => x.clip.type === 'text' && x.clip.caption).forEach(add);
    else if (word === 'all_audio') all.filter((x) => x.clip.type === 'audio').forEach(add);
    else if (word === 'base_track') base.forEach(add);
    else if (word === 'first') add(base[0]);
    else if (word === 'last') add(base.at(-1));
    else unknown.push(item);
  }
  const ok = picked.filter((x) => !x.track.locked && accept(x.clip));
  return { ids: ok.map((x) => x.clip.id), unknown, rejected: picked.length - ok.length };
}

// ---- Tools ------------------------------------------------------------------------

const CLIPS = { type: 'array', items: { type: 'string' }, description: `Clip ids from the project summary, or one of these words: ${Object.keys(CLIP_WORDS).join(', ')}.` };
const CLIP = { type: 'string', description: 'One clip id from the project summary (or "selected", "first", "last").' };
const SECONDS = (what) => ({ type: 'number', description: `${what}, in seconds` });
const obj = (properties, required = []) => ({ type: 'object', properties, required });

const TEXT_STYLE = obj({
  color: { type: 'string', description: 'Text color, #rrggbb or a color name' },
  size: { type: 'number', description: 'Font size in pixels at the project resolution (8 to 400; default text is 64)' },
  size_scale: { type: 'number', description: 'Multiply the current size (1.5 = half again as big)' },
  bold: { type: 'boolean' },
  italic: { type: 'boolean' },
  underline: { type: 'boolean' },
  font: { type: 'string', description: 'A font id from the font list' },
  align: { type: 'string', enum: ['left', 'center', 'right'] },
  case: { type: 'string', enum: ['none', 'upper', 'lower', 'title'] },
  outline_color: { type: 'string' },
  outline_width: { type: 'number', description: '0 to 40 pixels' },
  background_color: { type: 'string' },
  background_opacity: { type: 'number', description: '0 to 1' },
  shadow: { type: 'boolean' },
});

/**
 * The edit tools. Each has a schema for the model and check(args, state),
 * which returns { args } (normalized: times in microseconds, ids resolved)
 * or { error } with a short reason. ui/assistant-actions.js performs them.
 */
export const TOOLS = [
  {
    name: 'split',
    description: 'Split clips at a time. Without clips, splits every clip under that time.',
    parameters: obj({ time: SECONDS('Where to split'), clips: CLIPS }, ['time']),
    check(a, st) {
      if (!isNum(a.time)) return { error: 'no time given' };
      const r = a.clips === undefined ? { ids: [] } : resolveClips(a.clips, st);
      if (a.clips !== undefined && !r.ids.length) return { error: 'none of those clips can be split' };
      return { args: { time: toUs(clamp(toNum(a.time), 0, st.duration / US)), ids: r.ids } };
    },
  },
  {
    name: 'delete_clips',
    description: 'Delete clips. Gaps on the base track close up.',
    parameters: obj({ clips: CLIPS }, ['clips']),
    check(a, st) {
      const r = resolveClips(a.clips, st);
      return r.ids.length ? { args: { ids: r.ids } } : { error: 'no clips matched' };
    },
  },
  {
    name: 'remove_time_range',
    description: 'Cut a stretch of time out of the whole video on every track and close the gap (for example "trim the first 2 seconds" is 0 to 2).',
    parameters: obj({ start: SECONDS('Start of the part to remove'), end: SECONDS('End of the part to remove') }, ['start', 'end']),
    check(a, st) {
      if (!isNum(a.start) || !isNum(a.end)) return { error: 'start and end are needed' };
      const max = st.duration / US;
      const lo = clamp(Math.min(toNum(a.start), toNum(a.end)), 0, max);
      const hi = clamp(Math.max(toNum(a.start), toNum(a.end)), 0, max);
      if (hi - lo < 0.02) return { error: 'that range is empty' };
      return { args: { start: toUs(lo), end: toUs(hi) } };
    },
  },
  {
    name: 'trim_clip',
    description: 'Shorten one clip from its start and/or end (negative values lengthen it where the media allows).',
    parameters: obj({ clip: CLIP, trim_start: SECONDS('How much to cut off the beginning'), trim_end: SECONDS('How much to cut off the end') }, ['clip']),
    check(a, st) {
      const r = resolveClips(a.clip, st);
      if (r.ids.length !== 1) return { error: 'pick exactly one clip' };
      const ts = clampNum(a.trim_start, -3600, 3600, 0);
      const te = clampNum(a.trim_end, -3600, 3600, 0);
      if (!ts && !te) return { error: 'nothing to trim' };
      return { args: { id: r.ids[0], trimStart: toUs(ts), trimEnd: toUs(te) } };
    },
  },
  {
    name: 'move_clip',
    description: 'Move one clip so it starts at a new time on its track.',
    parameters: obj({ clip: CLIP, start: SECONDS('New start time') }, ['clip', 'start']),
    check(a, st) {
      const r = resolveClips(a.clip, st);
      if (r.ids.length !== 1) return { error: 'pick exactly one clip' };
      if (!isNum(a.start)) return { error: 'no start time given' };
      return { args: { id: r.ids[0], start: toUs(clamp(toNum(a.start), 0, 24 * 3600)) } };
    },
  },
  {
    name: 'duplicate_clips',
    description: 'Duplicate clips; each copy goes right after its original.',
    parameters: obj({ clips: CLIPS }, ['clips']),
    check(a, st) {
      const r = resolveClips(a.clips, st);
      return r.ids.length ? { args: { ids: r.ids } } : { error: 'no clips matched' };
    },
  },
  {
    name: 'set_speed',
    description: 'Set the playback speed of video or audio clips (0.1 to 100; 2 is twice as fast).',
    parameters: obj({ clips: CLIPS, speed: { type: 'number' } }, ['clips', 'speed']),
    check(a, st) {
      if (!isNum(a.speed)) return { error: 'no speed given' };
      const r = resolveClips(a.clips, st, (c) => isTimed(c) && !c.freeze);
      if (!r.ids.length) return { error: 'speed works on video and audio clips, and none matched' };
      return { args: { ids: r.ids, speed: Math.round(clamp(toNum(a.speed), 0.1, 100) * 100) / 100 } };
    },
  },
  {
    name: 'add_text',
    description: 'Add a text clip.',
    parameters: obj({
      text: { type: 'string' },
      start: SECONDS('Start time (default: the playhead)'),
      duration: SECONDS('Length (default 3)'),
      preset: { type: 'string', description: 'A text style id from the text style list' },
      position: { type: 'string', enum: ['top', 'center', 'bottom'] },
      style: TEXT_STYLE,
    }, ['text']),
    check(a, st) {
      const text = str(a.text, 500);
      if (!text) return { error: 'no text given' };
      const start = toUs(clampNum(a.start, 0, Math.max(0, st.duration / US), st.time / US));
      const duration = toUs(clampNum(a.duration, 0.2, 3600, 3));
      const preset = findId(TEXT_LOOKS, a.preset) || 'plain';
      return { args: { text, start, duration, preset, y: TEXT_POSITIONS[lower(a.position)], style: textStyle(a.style) } };
    },
  },
  {
    name: 'edit_text',
    description: 'Change the words, look or position of text clips (captions are text clips too).',
    parameters: obj({ clips: CLIPS, text: { type: 'string' }, position: { type: 'string', enum: ['top', 'center', 'bottom'] }, style: TEXT_STYLE }, ['clips']),
    check(a, st) {
      const r = resolveClips(a.clips, st, (c) => c.type === 'text');
      if (!r.ids.length) return { error: 'no text clips matched' };
      const text = a.text === undefined ? undefined : str(a.text, 500);
      const style = textStyle(a.style);
      const y = TEXT_POSITIONS[lower(a.position)];
      if (!text && !Object.keys(style).length && y === undefined) return { error: 'nothing to change' };
      return { args: { ids: r.ids, text: text || undefined, style, y } };
    },
  },
  {
    name: 'set_filter',
    description: 'Apply a color filter (look) to video and image clips, or "none" to remove it.',
    parameters: obj({ clips: CLIPS, filter: { type: 'string', description: 'A filter id from the filter list, or "none"' }, intensity: { type: 'number', description: '0 to 100 (default 100)' } }, ['clips', 'filter']),
    check(a, st) {
      const id = isNone(a.filter) ? null : findId(FILTERS, a.filter);
      if (id === null && !isNone(a.filter)) return { error: `there is no filter called "${str(a.filter, 40)}"` };
      const r = resolveClips(a.clips, st, isVisualMedia);
      if (!r.ids.length) return { error: 'filters go on video and image clips, and none matched' };
      return { args: { ids: r.ids, filter: id, intensity: Math.round(clampNum(a.intensity, 0, 100, 100)) } };
    },
  },
  {
    name: 'add_effect',
    description: 'Add a visual effect. With clips, the effect goes on those clips; without, it goes on an effect track over everything below it from start for duration.',
    parameters: obj({ effect: { type: 'string', description: 'An effect id from the effect list' }, clips: CLIPS, start: SECONDS('Start for an effect track clip (default: the playhead)'), duration: SECONDS('Length for an effect track clip (default 3)') }, ['effect']),
    check(a, st) {
      const id = findId(EFFECTS, a.effect);
      if (!id) return { error: `there is no effect called "${str(a.effect, 40)}"` };
      if (a.clips !== undefined && (!Array.isArray(a.clips) || a.clips.length)) {
        const body = isBodyEffect(id);
        const r = resolveClips(a.clips, st, (c) => canHaveEffects(c) && (!body || isVisualMedia(c)) && (c.effects?.length || 0) < 5);
        if (!r.ids.length) return { error: 'none of those clips can take another effect' };
        return { args: { effect: id, ids: r.ids } };
      }
      const start = toUs(clampNum(a.start, 0, Math.max(0, st.duration / US), st.time / US));
      return { args: { effect: id, ids: null, start, duration: toUs(clampNum(a.duration, 0.2, 3600, 3)) } };
    },
  },
  {
    name: 'set_transition',
    description: 'Put a transition at the cut after a clip on the base track, at every cut (all), or "none" to remove. Without a clip, uses the cut nearest the playhead.',
    parameters: obj({ transition: { type: 'string', description: 'A transition id from the transition list, or "none"' }, after_clip: CLIP, all: { type: 'boolean' }, duration: SECONDS('Length (default 0.5)') }, ['transition']),
    check(a, st) {
      const id = isNone(a.transition) ? null : findId(TRANSITIONS, a.transition);
      if (id === null && !isNone(a.transition)) return { error: `there is no transition called "${str(a.transition, 40)}"` };
      const duration = toUs(clampNum(a.duration, 0.1, 5, 0.5));
      if (bool(a.all)) return { args: { transition: id, all: true, id: null, duration } };
      let clipId = null;
      if (a.after_clip !== undefined && a.after_clip !== '') {
        const r = resolveClips(a.after_clip, st, (c) => 'transition' in c);
        if (r.ids.length !== 1) return { error: 'pick one video or image clip for the transition' };
        clipId = r.ids[0];
      }
      return { args: { transition: id, all: false, id: clipId, duration } };
    },
  },
  {
    name: 'set_animation',
    description: 'Give clips an in, out or loop animation (or "none" to remove it).',
    parameters: obj({ clips: CLIPS, kind: { type: 'string', enum: ['in', 'out', 'loop'] }, animation: { type: 'string', description: 'An animation id from the list for that kind, or "none"' }, duration: SECONDS('Length (default 0.5; loops repeat every duration)') }, ['clips', 'kind', 'animation']),
    check(a, st) {
      const kind = ['in', 'out', 'loop'].includes(lower(a.kind)) ? lower(a.kind) : null;
      if (!kind) return { error: 'kind must be in, out or loop' };
      const def = isNone(a.animation) ? null : ANIMATIONS[kind].find((x) => x.id === lower(a.animation) || x.label.toLowerCase() === lower(a.animation)) || null;
      if (!def && !isNone(a.animation)) return { error: `there is no ${kind} animation called "${str(a.animation, 40)}"` };
      const r = resolveClips(a.clips, st, (c) => 'animIn' in c && (!def?.textOnly || c.type === 'text'));
      if (!r.ids.length) return { error: def?.textOnly ? 'that animation is for text clips, and none matched' : 'no clips that can animate matched' };
      const duration = isNum(a.duration) ? toUs(clamp(toNum(a.duration), 0.1, 60)) : null;
      return { args: { ids: r.ids, kind, animation: def?.id || null, duration } };
    },
  },
  {
    name: 'set_audio',
    description: 'Change the sound of video and audio clips: volume in percent (100 = unchanged, 0 = silent), fade in and out in seconds, mute.',
    parameters: obj({ clips: CLIPS, volume: { type: 'number', description: 'Percent, 0 to 1000' }, fade_in: SECONDS('Fade in length'), fade_out: SECONDS('Fade out length'), muted: { type: 'boolean' } }, ['clips']),
    check(a, st) {
      const r = resolveClips(a.clips, st, (c) => 'volume' in c);
      if (!r.ids.length) return { error: 'no clips with sound matched' };
      const out = { ids: r.ids };
      if (isNum(a.volume)) out.volume = clamp(toNum(a.volume), 0, 1000) / 100;
      if (isNum(a.fade_in)) out.fadeIn = toUs(clamp(toNum(a.fade_in), 0, 10));
      if (isNum(a.fade_out)) out.fadeOut = toUs(clamp(toNum(a.fade_out), 0, 10));
      if (a.muted !== undefined) out.muted = bool(a.muted);
      if (Object.keys(out).length === 1) return { error: 'nothing to change' };
      return { args: out };
    },
  },
  {
    name: 'adjust_color',
    description: 'Set color adjustments on video and image clips. Each value is -100 to 100, 0 is neutral (temperature above 0 is warmer).',
    parameters: obj(Object.fromEntries(['clips', ...COLOR_KEYS()].map((k) => [k, k === 'clips' ? CLIPS : { type: 'number' }])), ['clips']),
    check(a, st) {
      const r = resolveClips(a.clips, st, (c) => isVisualMedia(c) || c.type === 'adjust');
      if (!r.ids.length) return { error: 'no video or image clips matched' };
      const adjust = {};
      for (const k of COLOR_KEYS()) if (isNum(a[k])) adjust[k] = Math.round(clamp(toNum(a[k]), -100, 100));
      if (!Object.keys(adjust).length) return { error: 'no color values given' };
      return { args: { ids: r.ids, adjust } };
    },
  },
  {
    name: 'set_transform',
    description: 'Position, size, turn or fade visual clips. x and y are offsets from the center as a share of the frame (-0.5 to 0.5 reaches the edges); scale 1 is the original size; rotation in degrees; opacity 0 to 1.',
    parameters: obj({ clips: CLIPS, x: { type: 'number' }, y: { type: 'number' }, scale: { type: 'number' }, rotation: { type: 'number' }, opacity: { type: 'number' } }, ['clips']),
    check(a, st) {
      const r = resolveClips(a.clips, st, (c) => 'transform' in c);
      if (!r.ids.length) return { error: 'no visual clips matched' };
      const patch = {};
      if (isNum(a.x)) patch.x = clamp(toNum(a.x), -2, 2);
      if (isNum(a.y)) patch.y = clamp(toNum(a.y), -2, 2);
      if (isNum(a.scale)) patch.scale = clamp(toNum(a.scale), 0.05, 10);
      if (isNum(a.rotation)) patch.rotation = clamp(toNum(a.rotation), -3600, 3600);
      if (isNum(a.opacity)) patch.opacity = clamp(toNum(a.opacity), 0, 1);
      if (!Object.keys(patch).length) return { error: 'nothing to change' };
      return { args: { ids: r.ids, patch } };
    },
  },
  {
    name: 'add_captions',
    description: 'Generate captions from the speech in the video (takes a little while).',
    parameters: obj({
      language: { type: 'string', description: `Spoken language code: ${LANGUAGES.map((l) => l.value).join(', ')}` },
      style: { type: 'string', description: 'A caption style id from the caption style list, or a text style id' },
      position: { type: 'string', enum: ['top', 'center', 'bottom'] },
      max_words: { type: 'number', description: 'Words per caption, 1 to 12 (default 5)' },
      replace_existing: { type: 'boolean', description: 'Remove captions the project already has' },
      listen_to: { type: 'string', enum: ['base_track', 'all_audio'] },
    }),
    check(a) {
      const lang = LANGUAGES.find((l) => l.value === lower(a.language) || l.label.toLowerCase() === lower(a.language))?.value || 'auto';
      const look = findId(CAPTION_STYLES, a.style);
      const preset = look ? null : findId(TEXT_PRESETS, a.style);
      const position = ['top', 'center', 'bottom'].includes(lower(a.position)) ? lower(a.position) : 'bottom';
      return { args: { language: lang, captionStyle: look, preset: preset || (look ? CAPTION_STYLES.find((x) => x.id === look).preset : 'yellow-caption'), position, maxWords: Math.round(clampNum(a.max_words, 1, 12, 5)), replace: bool(a.replace_existing), scope: lower(a.listen_to) === 'all_audio' ? 'all' : 'main' } };
    },
  },
  {
    name: 'remove_silences',
    description: 'Find quiet stretches in the sound and cut them out, closing the gaps.',
    parameters: obj({ threshold_db: { type: 'number', description: 'Quieter than this counts as silence, -70 to -10 (default -38)' }, min_silence: SECONDS('Shortest silence to cut (default 0.6)'), padding: SECONDS('Sound kept around speech (default 0.12)'), listen_to: { type: 'string', enum: ['base_track', 'all_audio'] } }),
    check(a) {
      return { args: { thresholdDb: clampNum(a.threshold_db, -70, -10, -38), minSilence: clampNum(a.min_silence, 0.2, 10, 0.6), pad: clampNum(a.padding, 0, 1, 0.12), scope: lower(a.listen_to) === 'all_audio' ? 'all' : 'main' } };
    },
  },
  {
    name: 'add_marker',
    description: 'Add a timeline marker with an optional name.',
    parameters: obj({ time: SECONDS('Where (default: the playhead)'), label: { type: 'string' }, color: { type: 'string' } }),
    check(a, st) {
      return { args: { time: toUs(clampNum(a.time, 0, st.duration / US, st.time / US)), label: str(a.label, 200), color: normColor(a.color) || MARKER_COLORS[0] } };
    },
  },
  {
    name: 'select_clips',
    description: 'Select clips (an empty list clears the selection).',
    parameters: obj({ clips: CLIPS }, ['clips']),
    check(a, st) {
      const r = resolveClips(a.clips, st);
      if (!r.ids.length && Array.isArray(a.clips) && a.clips.length) return { error: 'no clips matched' };
      return { args: { ids: r.ids } };
    },
  },
  {
    name: 'set_aspect_ratio',
    description: 'Change the shape of the video frame.',
    parameters: obj({ ratio: { type: 'string', enum: [...RATIOS.map((r) => r.id), 'original'] } }, ['ratio']),
    check(a) {
      const s = str(a.ratio, 20).replace(/\s+/g, '').replace('/', ':').replace('x', ':');
      const r = RATIOS.find((x) => x.id === s || x.hint.toLowerCase() === s.toLowerCase());
      if (!r && s.toLowerCase() !== 'original') return { error: `"${s}" is not a frame shape this editor offers` };
      return { args: { ratio: r?.id || 'original' } };
    },
  },
  {
    name: 'move_playhead',
    description: 'Move the playhead to a time.',
    parameters: obj({ time: SECONDS('Where') }, ['time']),
    check(a, st) {
      if (!isNum(a.time)) return { error: 'no time given' };
      return { args: { time: toUs(clamp(toNum(a.time), 0, st.duration / US)) } };
    },
  },
];

function COLOR_KEYS() {
  return ['brightness', 'contrast', 'saturation', 'exposure', 'temperature', 'tint', 'highlights', 'shadows', 'vibrance', 'vignette', 'sharpen', 'fade', 'grain'];
}

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Text style arguments as style fields (unknown or unusable values are left out). */
export function textStyle(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  const color = normColor(s.color);
  if (color) out.color = color;
  if (isNum(s.size)) out.size = Math.round(clamp(toNum(s.size), 8, 400));
  if (isNum(s.size_scale)) out.sizeScale = clamp(toNum(s.size_scale), 0.2, 5);
  for (const k of ['bold', 'italic', 'underline']) if (s[k] !== undefined) out[k] = bool(s[k]);
  const font = s.font !== undefined ? FONTS.find((f) => f.id.toLowerCase() === lower(s.font))?.id : null;
  if (font) out.font = font;
  if (['left', 'center', 'right'].includes(lower(s.align))) out.align = lower(s.align);
  if (['none', 'upper', 'lower', 'title'].includes(lower(s.case))) out.case = lower(s.case);
  const stroke = normColor(s.outline_color);
  if (stroke) out.strokeColor = stroke;
  if (isNum(s.outline_width)) out.strokeWidth = clamp(toNum(s.outline_width), 0, 40);
  else if (stroke) out.strokeWidth = 6;
  const bg = normColor(s.background_color);
  if (bg) out.bgColor = bg;
  if (isNum(s.background_opacity)) out.bgOpacity = clamp(toNum(s.background_opacity), 0, 1);
  else if (bg) out.bgOpacity = 1;
  if (s.shadow !== undefined) out.shadowOpacity = bool(s.shadow) ? 0.6 : 0;
  return out;
}

/** The tools as OpenAI-style function definitions for puter.ai.chat({ tools }). */
export function toolSpecs() {
  return TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/**
 * Check one call against the project: { ok: true, name, args } with
 * clamped arguments, or { ok: false, name, error }.
 */
export function validateCall(call, state) {
  const name = str(call?.name, 80);
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { ok: false, name, error: `unknown edit "${name || '?'}"` };
  const raw = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
  try {
    const r = tool.check(raw, state);
    return r.error ? { ok: false, name, error: r.error } : { ok: true, name, args: r.args };
  } catch (err) {
    return { ok: false, name, error: err?.message || 'could not read the request' };
  }
}

// ---- What the model is told ---------------------------------------------------------

const quote = (s, max = 60) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return JSON.stringify(t.length > max ? `${t.slice(0, max - 1)}…` : t);
};

function clipLine(c, project) {
  const parts = [c.id, c.type, `${secs(c.start)}-${secs(c.start + c.duration)}`];
  if (c.type === 'text') {
    parts.push(quote(c.text));
    if (c.caption) parts.push('caption');
    parts.push(`size ${Math.round(c.style?.size || 0)}`, `color ${c.style?.color}`);
    if (c.style?.font) parts.push(`font ${c.style.font}`);
  } else if (c.assetId) parts.push(quote(project.assets?.[c.assetId]?.name || c.name, 40));
  else if (c.name) parts.push(quote(c.name, 40));
  if (c.type === 'effect') parts.push(`effect ${c.effect}`);
  if (c.type === 'filter') parts.push(`filter ${c.filter}`);
  if (c.type === 'sticker') parts.push(`graphic ${c.sticker}`);
  if (c.speed && c.speed !== 1) parts.push(`speed ${c.speed}x`);
  if ('volume' in c && c.volume !== 1) parts.push(`volume ${Math.round(c.volume * 100)}%`);
  if (c.muted) parts.push('muted');
  if (c.fadeIn) parts.push(`fade in ${secs(c.fadeIn)}`);
  if (c.fadeOut) parts.push(`fade out ${secs(c.fadeOut)}`);
  if (c.type !== 'filter' && c.filter?.id) parts.push(`filter ${c.filter.id}`);
  if (c.effects?.length) parts.push(`effects ${c.effects.map((e) => e.id).join('+')}`);
  if (c.animIn) parts.push(`in ${c.animIn.id}`);
  if (c.animOut) parts.push(`out ${c.animOut.id}`);
  if (c.animLoop) parts.push(`loop ${c.animLoop.id}`);
  if (c.transition) parts.push(`transition after ${c.transition.id}`);
  if (c.transform && (c.transform.x || c.transform.y || c.transform.scale !== 1)) parts.push(`at ${+c.transform.x.toFixed(2)},${+c.transform.y.toFixed(2)} scale ${+c.transform.scale.toFixed(2)}`);
  if (c.disabled) parts.push('disabled');
  return parts.join(' ');
}

/** A compact text picture of the project for the model: settings, tracks and clips with ids, selection, markers. */
export function projectBrief(state) {
  const p = state.project;
  const s = p.settings;
  const lines = [
    `Project ${quote(p.name, 80)}: ${s.width}x${s.height} (${s.ratio}), ${s.fps} fps, length ${secs(state.duration)}. Playhead at ${secs(state.time)}.`,
    `Selected: ${state.selection.length ? state.selection.join(', ') : 'nothing'}.`,
  ];
  if (p.range) lines.push(`In/out range: ${secs(p.range.in)}-${secs(p.range.out)}.`);
  lines.push('Tracks, top to bottom:');
  let listed = 0;
  let skipped = 0;
  for (const t of p.tracks) {
    const flags = [t.main ? 'base track' : `${t.kind} track`, t.locked ? 'locked' : '', t.hidden ? 'hidden' : '', t.muted ? 'muted' : ''].filter(Boolean).join(', ');
    lines.push(`- ${t.id} (${flags}):`);
    const caps = t.clips.filter((c) => c.type === 'text' && c.caption);
    // Long caption tracks are summed up so the list stays short.
    if (caps.length > 12 && caps.length === t.clips.length) {
      lines.push(`  ${caps.length} captions from ${secs(caps[0].start)} to ${secs(caps.at(-1).start + caps.at(-1).duration)} (first ${caps[0].id} ${quote(caps[0].text, 40)}, size ${caps[0].style?.size}, color ${caps[0].style?.color}); use all_captions to change them all.`);
      continue;
    }
    for (const c of t.clips) {
      if (listed >= CLIP_LIMIT) {
        skipped++;
        continue;
      }
      lines.push(`  ${clipLine(c, p)}`);
      listed++;
    }
  }
  if (skipped) lines.push(`(${skipped} more clips not listed)`);
  const markers = p.markers || [];
  if (markers.length) lines.push(`Markers: ${markers.slice(0, 30).map((m) => `${secs(m.time)}${m.label ? ` ${quote(m.label, 30)}` : ''}`).join('; ')}.`);
  return lines.join('\n');
}

const ids = (list, show = (x) => x.label) => list.map((x) => (show(x) && show(x).toLowerCase() !== x.id.replace(/-/g, ' ') ? `${x.id} (${show(x)})` : x.id)).join(', ');

/** The ids the tools accept, with their names where those differ. */
export function catalogBrief() {
  return [
    `Filters: ${ids(FILTERS)}.`,
    `Effects: ${ids(EFFECTS)}.`,
    `Transitions: ${ids(TRANSITIONS)}.`,
    `In animations: ${ids(ANIMATIONS.in)}.`,
    `Out animations: ${ids(ANIMATIONS.out)}.`,
    `Loop animations: ${ids(ANIMATIONS.loop)}.`,
    `Text styles: ${ids(TEXT_LOOKS)}.`,
    `Caption styles: ${ids(CAPTION_STYLES)}.`,
    `Fonts: ${FONTS.map((f) => f.id).join(', ')}.`,
  ].join('\n');
}

const RULES = [
  'You are the edit assistant inside a browser video editor. You change the open project by calling the edit tools.',
  'Times are in seconds from the start of the video. Use clip ids exactly as listed in the project summary, or the clip words (selected, all, all_video, all_text, all_captions, all_audio, base_track, first, last). Never invent ids.',
  '"It", "this" or "that" usually means the selected clips or the clips changed in the previous request.',
  'Do everything the request asks in one reply, calling several tools when needed, in the order they should happen. Later calls see the result of earlier ones, so prefer clip words over ids of clips an earlier call may have removed.',
  '"Fade out at the end" usually means an out animation fade-out on the last base track clip plus a sound fade out on clips with sound that end there.',
  'A warm or cool "look" is a filter (for example warm or cool) unless the request asks for exact adjustments.',
  'If the request is unclear or cannot be done with these tools, do not call tools; answer in one or two short sentences instead.',
];

/** The system message: rules, the current project and the catalogs. json asks for a JSON action list instead of tool calls. */
export function systemPrompt(state, { json = false } = {}) {
  const parts = [...RULES];
  if (json) {
    parts.push(
      'Tool calling is not available, so reply with only a JSON object and nothing else, in this form:',
      '{"actions":[{"tool":"<tool name>","args":{...}}],"reply":"<one short sentence for the user>"}',
      'Use an empty actions list when nothing should change. The tools and their arguments (JSON schema):',
      JSON.stringify(TOOLS.map((t) => ({ name: t.name, description: t.description, args: t.parameters.properties }))),
    );
  }
  parts.push('', 'Current project:', projectBrief(state), '', 'Ids you can use:', catalogBrief());
  return parts.join('\n');
}

/** Chat messages for a request: system, the recent conversation, then the request. */
export function buildMessages(state, history, request, { json = false } = {}) {
  const recent = (history || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-HISTORY_LIMIT);
  return [{ role: 'system', content: systemPrompt(state, { json }) }, ...recent, { role: 'user', content: String(request).slice(0, REQUEST_MAX) }];
}

// ---- Reading replies -------------------------------------------------------------

function parseArgs(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string' || !v.trim()) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const loose = extractJson(v);
    return loose && typeof loose === 'object' && !Array.isArray(loose) ? loose : {};
  }
}

/** Tool calls in a chat reply ({ name, args }), from OpenAI-style tool_calls or tool_use content blocks. */
export function toolCallsFrom(reply) {
  const msg = reply?.message || reply;
  const out = [];
  const calls = msg?.tool_calls || reply?.tool_calls;
  if (Array.isArray(calls)) {
    for (const c of calls) {
      const name = c?.function?.name || c?.name;
      if (name) out.push({ name: String(name), args: parseArgs(c.function?.arguments ?? c.arguments ?? c.input) });
    }
  }
  if (Array.isArray(msg?.content)) {
    for (const b of msg.content) if (b?.type === 'tool_use' && b.name) out.push({ name: String(b.name), args: parseArgs(b.input) });
  }
  return out;
}

/** The text part of a reply (no tool blocks). */
export function replyText(reply) {
  const c = reply?.message?.content;
  if (Array.isArray(c)) return c.filter((b) => typeof b === 'string' || b?.type === 'text').map((b) => (typeof b === 'string' ? b : b.text || '')).join('').trim();
  if (reply?.message && (c === null || c === undefined)) return '';
  return chatText(reply).trim();
}

const NAME_KEYS = ['tool', 'name', 'action', 'function', 'type', 'op'];
const ARG_KEYS = ['args', 'arguments', 'parameters', 'params', 'input'];

function actionFrom(item) {
  if (!item || typeof item !== 'object') return null;
  let name = null;
  let nameKey = null;
  for (const k of NAME_KEYS) {
    const v = item[k];
    if (typeof v === 'string' && v.trim()) {
      name = v.trim();
      nameKey = k;
      break;
    }
    if (v && typeof v === 'object' && typeof v.name === 'string') {
      return { name: v.name, args: parseArgs(v.arguments ?? v.args) };
    }
  }
  if (!name) return null;
  const argKey = ARG_KEYS.find((k) => item[k] !== undefined);
  let args;
  if (argKey) args = parseArgs(item[argKey]);
  else {
    // Arguments written next to the name: {"tool":"split","time":3}
    args = { ...item };
    delete args[nameKey];
  }
  return { name, args };
}

/**
 * Edits written as JSON in a text reply: {"actions":[...],"reply":"..."},
 * a bare array of actions, or one action object. Each action names its tool
 * (tool / name / action / function) and its arguments (args / arguments /
 * parameters / input, or fields beside the name). Code fences and chatter
 * around the JSON are ignored. Returns { calls, reply } or null when the
 * reply has no JSON.
 */
export function parseActionList(reply) {
  const data = extractJson(reply);
  if (data === null || typeof data !== 'object') return null;
  let items = null;
  let text = '';
  if (Array.isArray(data)) items = data;
  else {
    items = ['actions', 'calls', 'tool_calls', 'steps', 'edits'].map((k) => data[k]).find(Array.isArray) || null;
    text = str(data.reply ?? data.message ?? data.summary ?? data.answer ?? '', 1000);
    if (!items) {
      const one = actionFrom(data);
      items = one && !text ? [data] : [];
    }
  }
  const calls = items.map(actionFrom).filter(Boolean);
  return { calls, reply: text };
}

const aborted = () => new DOMException('Cancelled', 'AbortError');

/** Resolve with p, or reject as soon as signal aborts (Puter chat calls cannot be stopped, only ignored). */
function abortable(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Ask the model what to do. chat(messages, options) is puter.ai.chat (or
 * a stand-in in tests). First with the edit tools; when the reply has no
 * tool calls (or tool calling fails), the request is asked again for a JSON
 * action list. Returns { calls, text, via: 'tools' | 'json' | 'none' }.
 */
export async function askForEdits({ request, state, history = [], chat, signal }) {
  let reply = null;
  let failure = null;
  try {
    reply = await abortable(Promise.resolve(chat(buildMessages(state, history, request), { tools: toolSpecs() })), signal);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    failure = err;
  }
  const text = reply ? replyText(reply) : '';
  if (reply) {
    const calls = toolCallsFrom(reply);
    if (calls.length) return { calls, text, via: 'tools' };
    const inline = parseActionList(text);
    if (inline?.calls.length) return { calls: inline.calls, text: inline.reply, via: 'json' };
  }
  let second = null;
  try {
    second = await abortable(Promise.resolve(chat(buildMessages(state, history, request, { json: true }))), signal);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    if (reply) return { calls: [], text, via: 'none' };
    throw failure || err;
  }
  const parsed = parseActionList(second);
  if (parsed?.calls.length) return { calls: parsed.calls, text: parsed.reply, via: 'json' };
  return { calls: [], text: parsed?.reply || text || chatText(second).trim(), via: 'none' };
}

// ---- After an edit -------------------------------------------------------------------

/**
 * What happened, for the chat: results are { ok, text, ids? } per call.
 * Returns { done, skipped, lines, note } where note is the plain text kept
 * in the conversation so follow-ups know which clips were touched.
 */
export function summarize(results) {
  const done = results.filter((r) => r.ok);
  const skipped = results.filter((r) => !r.ok);
  const lines = [...done.map((r) => ({ ok: true, text: r.text })), ...skipped.map((r) => ({ ok: false, text: r.text }))];
  const note = [
    done.length ? `Done: ${done.map((r) => (r.ids?.length ? `${r.text} [${r.ids.slice(0, 20).join(', ')}]` : r.text)).join('; ')}.` : 'Nothing was changed.',
    skipped.length ? `Skipped: ${skipped.map((r) => r.text).join('; ')}.` : '',
  ].filter(Boolean).join(' ');
  return { done: done.length, skipped: skipped.length, lines, note };
}

/** Undo label for a request: "Assistant: <request>", shortened. */
export function stepLabel(request) {
  const t = String(request || '').replace(/\s+/g, ' ').trim();
  return `Assistant: ${t.length > 40 ? `${t.slice(0, 39)}…` : t}`;
}

export { plural };
